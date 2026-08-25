-- 059_proforma_overdue_cron.sql
-- ============================================================================
-- FIX-MED-1 / Fix 3 — schedule the proforma-overdue cron.
--
-- Background
-- ----------
-- The /api/cron/proforma-overdue route (src/app/api/cron/proforma-overdue/
-- route.ts) marks every proforma whose `valid_until` is in the past AND
-- whose status is still `sent` or `accepted` as `expired`. The proforma
-- status enum already includes `expired` (see `ProformaStatus` in
-- src/lib/supabase/types.ts: "draft" | "sent" | "viewed" | "accepted" |
-- "paid" | "expired") but no automated job was setting it — so stale
-- proformas lingered in `sent` / `accepted` forever, the partner could
-- still "accept" a stale proforma weeks after it expired, and finance
-- teams had no clean `expired` cohort to filter on.
--
-- This migration schedules the route via pg_cron + net.http_get using
-- the same hybrid token-lookup pattern established in migration 036
-- (current_setting GUC first, app_config table fallback for Supabase):
--
--   COALESCE(
--     nullif(current_setting('app.cron_token', true), ''),
--     (SELECT value FROM public.app_config WHERE key = 'cron_token')
--   )
--
-- Cadence: every hour, at minute 7. Hourly is frequent enough that an
-- expired proforma flips to `expired` within ~60 minutes of its
-- `valid_until`, and infrequent enough not to add meaningful load (the
-- query is a single range scan on `valid_until`; even with ~10K
-- proformas tenant-wide, the cohort-size at any given hour is small).
-- Minute 7 (rather than minute 0) to avoid colliding with the other
-- hourly cron jobs that fire on the hour (subscription-sweep-hourly at
-- :15, invoice-overdue at 09:00) — staggering keeps the net.http_get
-- fan-out from hammering the same render instance simultaneously.
--
-- Auth
-- ----
-- Same shared `authorizeCron` helper as the other cron routes. The
-- pg_cron command sends `Authorization: Bearer <CRON_TOKEN>` via the
-- hybrid COALESCE lookup — no literal token in cron.job.command.
--
-- Idempotent
-- ----------
-- `cron.unschedule` is guarded by `WHERE EXISTS`. The route itself is
-- idempotent: the UPDATE carries `WHERE status IN ('sent','accepted')`
-- AND `valid_until < now()` in BOTH the cohort SELECT and the per-row
-- UPDATE, so a row already flipped to `expired` (by a concurrent run
-- or a manual admin edit) is left untouched and doesn't double-count.
-- Running the cron twice in a row is a safe no-op.
--
-- Related
-- -------
-- Migration 036 (cron_token_setting.sql) created the app_config table +
-- the hybrid token-lookup pattern. Migration 056 (auction_sweep_cron.sql)
-- is the template for this migration (same structure, same comments).
-- The /api/cron/invoice-overdue/route.ts is the template for the route
-- (same audit-log shape, same per-row try/catch pattern).
-- ============================================================================

-- ─── 1. Schedule proforma-overdue — every hour at minute 7 ────────────────
SELECT cron.unschedule('proforma-overdue')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'proforma-overdue');

SELECT cron.schedule(
  'proforma-overdue',
  '7 * * * *',  -- every hour at minute 7 (staggered off the :0 / :15 slots)
  $cmd$
    SELECT net.http_get(
      url := 'https://aspidus.onrender.com/api/cron/proforma-overdue',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || COALESCE(
          nullif(current_setting('app.cron_token', true), ''),
          (SELECT value FROM public.app_config WHERE key = 'cron_token')
        )
      )
    )
  $cmd$
);

-- ─── 2. Verify ──────────────────────────────────────────────────────────────
SELECT jobname, schedule, active
  FROM cron.job
  WHERE jobname = 'proforma-overdue'
  ORDER BY jobname;

-- ─── 3. Summary: all HTTP-based cron jobs (for ops visibility) ─────────────
SELECT jobname, schedule, active
  FROM cron.job
  WHERE command LIKE '%net.http_get%'
  ORDER BY jobname;
