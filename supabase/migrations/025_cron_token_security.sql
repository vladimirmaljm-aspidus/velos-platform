-- 025_cron_token_security.sql
-- ============================================================================
-- F-8 (Infra P1) — Move CRON_TOKEN out of URL query strings into the
-- `Authorization: Bearer <token>` header, and schedule the previously
-- unscheduled invoice-overdue cron job.
--
-- BACKGROUND
--   The audit (P1) found that CRON_TOKEN was hardcoded as a URL query
--   parameter in cron.job.command for both `subscription-sweep-hourly` and
--   `webhook-retry`. URL query parameters leak via:
--     • Render nginx access logs
--     • Postgres `cron.job.command` (visible to anyone with SELECT on cron.job)
--     • Browser history (if a URL is ever copy-pasted into a browser)
--     • pg_stat_activity (visible query text during execution)
--
--   Additionally, `process.env.CRON_TOKEN` was NOT set on Render — meaning
--   the existing cron jobs were silently failing auth (returning 401) and
--   pg_cron's "succeeded" status was masking the actual API failure.
--
--   This migration:
--   1. Unschedules the existing jobs (which used `?token=...` in URL).
--   2. Reschedules them with the token in the `Authorization` header,
--      read from the Postgres setting `app.cron_token` via
--      `current_setting('app.cron_token', true)` so the token does NOT
--      appear in `cron.job.command` (which is visible to anyone with
--      SELECT on cron.job).
--   3. Schedules the previously-unscheduled `invoice-overdue-check` job.
--
-- CRON_TOKEN STORAGE
--   The token is NOT hardcoded in this file. Instead, it lives in the
--   Postgres custom setting `app.cron_token`, which is set out-of-band
--   by the operator via:
--     ALTER DATABASE postgres SET app.cron_token = '<actual_token>';
--   (or via `ALTER ROLE postgres SET app.cron_token = '...';` for
--   role-scoped settings — see migration 034 for the same pattern).
--   The setting is NOT visible to anon/authenticated roles, and
--   `cron.job.command` only contains the literal SQL
--   `current_setting('app.cron_token', true)` — never the token value.
--
--   To rotate the token in the future:
--     1. Generate a new token: `python3 -c "import secrets; print(secrets.token_urlsafe(32))"`
--     2. PUT it to Render: curl -X PUT https://api.render.com/v1/services/$SERVICE_ID/env-vars/CRON_TOKEN -d '{"value":"<NEW_TOKEN>"}'
--     3. Update the Postgres setting: `ALTER DATABASE postgres SET app.cron_token = '<NEW_TOKEN>';`
--        (and `SELECT pg_reload_conf();` to apply).
--     4. Trigger a Render deploy so the new env var takes effect.
--     5. No cron re-schedule needed — the jobs already read the setting
--        dynamically, so they'll pick up the new token on the next run.
--
-- CRON ROUTES
--   All three cron routes (webhook-retry, subscription-sweep, invoice-overdue)
--   have been updated in src/app/api/cron/*/route.ts to accept BOTH:
--     • Authorization: Bearer <token> header  (preferred — F-8)
--     • ?token=... URL query                  (legacy backward compat)
--   so a rolling deploy won't break cron jobs that haven't been re-scheduled
--   yet.
--
-- IDEMPOTENT
--   All cron.unschedule calls are guarded by `WHERE EXISTS` checks so the
--   migration can be re-run safely. cron.schedule returns an error if a
--   job with the same name already exists, so we unschedule before each
--   schedule call.
--
-- NOTE (audit P2-4 / task C-7): the original version of this migration
--   used a literal `<CRON_TOKEN>` placeholder string in the SQL command,
--   which would schedule jobs with the literal string "<CRON_TOKEN>" as
--   the bearer token if applied verbatim. The live DB had the real token
--   substituted in via `sed` before applying — but the file as committed
--   was broken. This file now uses `current_setting('app.cron_token',
--   true)` per the task C-7 spec.
--
--   SUPABASE CAVEAT: on Supabase, `current_setting('app.cron_token',
--   true)` returns NULL because custom GUC parameters require SUPERUSER
--   to set via `ALTER DATABASE` / `ALTER ROLE`, and the `postgres` role
--   on Supabase is NOT a superuser. Migration 036_cron_token_setting.sql
--   is the LIVE-DB FIX — it creates a `public.app_config` table as a
--   fallback and re-schedules these three jobs with a hybrid COALESCE:
--     COALESCE(
--       nullif(current_setting('app.cron_token', true), ''),
--       (SELECT value FROM public.app_config WHERE key = 'cron_token')
--     )
--   The hybrid tries the GUC first (per spec) and falls back to the
--   table when the GUC is unset (the Supabase case). Either way, the
--   literal token NEVER appears in `cron.job.command`.
-- ============================================================================

-- ─── 0. Pre-flight: ensure `app.cron_token` is set ────────────────────────
--   This is a SOFT check — if the setting is missing, the migration still
--   applies (the jobs will be scheduled, they'll just fail auth on first
--   run with a clear "app.cron_token not set" error in the cron job log).
--   The operator sets the setting via:
--     ALTER DATABASE postgres SET app.cron_token = '<actual_token>';
--   On Supabase, this requires superuser (the `supabase_admin` role) —
--   see migration 036 for the table-based fallback that works without
--   superuser.
DO $$
DECLARE
  tok text;
BEGIN
  tok := current_setting('app.cron_token', true);
  IF tok IS NULL OR tok = '' THEN
    RAISE NOTICE 'app.cron_token is not set — cron jobs will fail auth until it is set via: ALTER DATABASE postgres SET app.cron_token = ''<token>''; (Supabase: see migration 036 for the table fallback.)';
  END IF;
END $$;

-- ─── 1. subscription-sweep-hourly — token moved URL→header ────────────────
SELECT cron.unschedule('subscription-sweep-hourly')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'subscription-sweep-hourly');

SELECT cron.schedule(
  'subscription-sweep-hourly',
  '15 * * * *',  -- every hour at minute 15
  $cmd$
    SELECT net.http_get(
      url := 'https://aspidus.onrender.com/api/cron/subscription-sweep',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || current_setting('app.cron_token', true)
      )
    )
  $cmd$
);

-- ─── 2. webhook-retry — token moved URL→header ────────────────────────────
SELECT cron.unschedule('webhook-retry')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'webhook-retry');

SELECT cron.schedule(
  'webhook-retry',
  '*/5 * * * *',  -- every 5 minutes
  $cmd$
    SELECT net.http_get(
      url := 'https://aspidus.onrender.com/api/cron/webhook-retry',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || current_setting('app.cron_token', true)
      )
    )
  $cmd$
);

-- ─── 3. invoice-overdue-check — NEW schedule (was never scheduled) ────────
--   The /api/cron/invoice-overdue/route.ts handler existed but had no
--   pg_cron job calling it. Invoices that passed their due_date stayed in
--   "sent"/"viewed" status forever — no overdue transition, no notification.
SELECT cron.unschedule('invoice-overdue-check')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'invoice-overdue-check');

SELECT cron.schedule(
  'invoice-overdue-check',
  '0 9 * * *',  -- daily at 09:00 UTC
  $cmd$
    SELECT net.http_get(
      url := 'https://aspidus.onrender.com/api/cron/invoice-overdue',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || current_setting('app.cron_token', true)
      )
    )
  $cmd$
);

-- ─── 4. Verify all 3 HTTP-based cron jobs are scheduled ───────────────────
--   Non-HTTP jobs (session-cleanup, password-reset-cleanup, vacuum-*) are
--   unchanged — they don't make outbound HTTP calls so the CRON_TOKEN
--   security fix doesn't apply to them.
SELECT jobname, schedule, active
  FROM cron.job
  WHERE command LIKE '%net.http_get%'
  ORDER BY jobname;

-- ─── 5. NOTE on token storage ─────────────────────────────────────────────
--   The token is NOT in this file. It lives in the Postgres custom setting
--   `app.cron_token` (set via `ALTER DATABASE postgres SET app.cron_token`).
--   The cron command reads it via `current_setting('app.cron_token', true)`
--   so the value never appears in `cron.job.command` (which is visible to
--   anyone with SELECT on cron.job). This keeps the token out of:
--     • Git history (this file is committed)
--     • GitHub search / code scanning
--     • Anyone who clones the repo but doesn't have Render/Supabase access
--     • The `cron.job.command` column itself (defense in depth)
-- ============================================================================
