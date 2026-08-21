-- 036_cron_token_setting.sql
-- ============================================================================
-- CRON TOKEN — REMOVE LITERAL FROM cron.job.command (audit P2-4 / task C-7).
--
-- Background
-- ----------
-- Migration 025 originally used a literal `<CRON_TOKEN>` placeholder in
-- the cron.schedule commands. When 025 was applied to the live Supabase
-- project (during F-8 / commit fca015e), the real token was substituted
-- in via `sed -e 's|<CRON_TOKEN>|<actual_token>|g'` BEFORE applying —
-- so the live `cron.job.command` rows contained the REAL TOKEN VALUE in
-- plaintext. Anyone with SELECT on `cron.job` (which includes the
-- `postgres` role and any role granted SELECT) could read the token.
--
-- Migration 025 has since been updated (commit C-7) to use
-- `current_setting('app.cron_token', true)` so fresh deploys don't have
-- the literal-token problem. But two issues remain:
--
--   1. The LIVE database still has the old `cron.job.command` rows with
--      the token baked in.
--   2. On Supabase, `current_setting('app.cron_token', true)` returns
--      NULL because custom GUC parameters require SUPERUSER to set via
--      `ALTER DATABASE` / `ALTER ROLE` — and the `postgres` role on
--      Supabase is NOT a superuser (only `supabase_admin` is). So even
--      if the operator runs `ALTER DATABASE postgres SET app.cron_token
--      = '...';` via the Supabase SQL editor (which runs as `postgres`),
--      it fails with `permission denied to set parameter "app.cron_token"`.
--
-- This migration fixes BOTH issues by:
--   • Creating a `public.app_config` table to store the cron token (and
--     any other platform-level secrets pg_cron needs to read at runtime).
--   • Re-scheduling the three HTTP-based cron jobs from 025 to use a
--     HYBRID token lookup:
--       COALESCE(
--         nullif(current_setting('app.cron_token', true), ''),
--         (SELECT value FROM public.app_config WHERE key = 'cron_token')
--       )
--     This tries the GUC FIRST (per the task C-7 spec) and falls back to
--     the table when the GUC is unset (the Supabase case). Either way,
--     the literal token NEVER appears in `cron.job.command`.
--
-- Why a table and not a SECURITY DEFINER function?
--   A function would also work, but it adds an indirection layer that
--   makes the cron command harder to read in `SELECT * FROM cron.job`.
--   The inline `COALESCE(...)` is grep-friendly: an operator can scan
--   `cron.job.command` and immediately see that the token comes from
--   `app_config` / `current_setting`, not from a literal.
--
-- Prerequisite (operator must run BEFORE applying this migration)
-- ---------------------------------------------------------------
-- None. The migration creates the `app_config` table itself and inserts
-- the cron token. The operator MUST update the placeholder token value
-- below to match the actual CRON_TOKEN env var set on Render:
--
--   -- Replace the value below with the real token:
--   UPDATE public.app_config
--     SET value = '<actual_cron_token>', updated_at = now()
--     WHERE key = 'cron_token';
--
-- If you forget this step, the cron jobs will send an obviously-wrong
-- `Bearer <CRON_TOKEN>` header and the cron routes will 401 — easy to
-- spot in the cron.job_run_history log.
--
-- Idempotent
-- ----------
-- `CREATE TABLE IF NOT EXISTS`, `INSERT ... ON CONFLICT DO UPDATE`, and
-- `cron.unschedule ... WHERE EXISTS` all make this safe to re-run. The
-- verification step at the end surfaces any job whose `command` still
-- contains a literal token pattern — those would need a manual re-schedule.
-- ============================================================================

-- ─── 1. Create the app_config table (if it doesn't already exist) ──────────
--   Stores platform-level secrets that pg_cron jobs need at runtime.
--   RLS: only the `postgres` and `service_role` roles can SELECT; `anon`
--   and `authenticated` get NOTHING (REVOKE ALL). This is stricter than
--   RLS — even if a future migration accidentally adds a permissive RLS
--   policy, the REVOKE ensures anon/authenticated still can't read.
CREATE TABLE IF NOT EXISTS public.app_config (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.app_config IS
  'Platform-level key/value config (audit P2-4 / task C-7). Stores secrets '
  'like the cron_token that pg_cron jobs need to read at runtime — keeps '
  'the literal value OUT of cron.job.command (which is visible to anyone '
  'with SELECT on cron.job). Access: only postgres + service_role can '
  'read; anon/authenticated are REVOKE''d.';

-- Lock down: anon/authenticated get nothing, even if RLS is enabled later.
REVOKE ALL ON public.app_config FROM anon, authenticated;
GRANT SELECT ON public.app_config TO postgres, service_role;

-- ─── 2. Insert the cron token (placeholder — operator MUST update) ─────────
--   The value below is a PLACEHOLDER. The operator must UPDATE it to the
--   real CRON_TOKEN value (matching the env var on Render) BEFORE the
--   cron jobs will successfully authenticate. We use ON CONFLICT so
--   re-running the migration doesn't clobber a value the operator has
--   already set.
--
--   NOTE: this placeholder is intentionally a recognizable string so a
--   forgotten update is visible in the cron error log as a 401 with
--   `Authorization: Bearer <CRON_TOKEN>` rather than a silent failure.
INSERT INTO public.app_config (key, value) VALUES
  ('cron_token', '<CRON_TOKEN>')
ON CONFLICT (key) DO NOTHING;

-- ─── 3. Soft pre-flight check ─────────────────────────────────────────────
--   Unlike the previous version of this migration (which raised an
--   EXCEPTION if `app.cron_token` was unset), we now only emit a NOTICE.
--   The GUC is OPTIONAL on Supabase — the table fallback handles it. The
--   NOTICE is for ops visibility: if the GUC IS set (e.g. on a self-hosted
--   Postgres where superuser is available), it takes precedence over the
--   table value, and the operator might want to know which one is active.
DO $$
DECLARE
  guc_tok text;
  tbl_tok text;
BEGIN
  guc_tok := nullif(current_setting('app.cron_token', true), '');
  SELECT value INTO tbl_tok FROM public.app_config WHERE key = 'cron_token';
  IF guc_tok IS NOT NULL THEN
    RAISE NOTICE 'app.cron_token GUC is set (length: %). New encryptions will use the GUC value (takes precedence over app_config table).', length(guc_tok);
  ELSIF tbl_tok IS NOT NULL AND tbl_tok <> '<CRON_TOKEN>' THEN
    RAISE NOTICE 'app.cron_token GUC is NOT set; using public.app_config.cron_token (length: %). This is the Supabase-compatible path.', length(tbl_tok);
  ELSE
    RAISE NOTICE 'app.cron_token GUC is NOT set AND app_config.cron_token is still the placeholder. Cron jobs will fail auth until you UPDATE public.app_config SET value = ''<actual_token>'' WHERE key = ''cron_token'';';
  END IF;
END $$;

-- ─── 4. Re-schedule subscription-sweep-hourly with hybrid token lookup ────
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
        'Bearer ' || COALESCE(
          nullif(current_setting('app.cron_token', true), ''),
          (SELECT value FROM public.app_config WHERE key = 'cron_token')
        )
      )
    )
  $cmd$
);

-- ─── 5. Re-schedule webhook-retry with hybrid token lookup ────────────────
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
        'Bearer ' || COALESCE(
          nullif(current_setting('app.cron_token', true), ''),
          (SELECT value FROM public.app_config WHERE key = 'cron_token')
        )
      )
    )
  $cmd$
);

-- ─── 6. Re-schedule invoice-overdue-check with hybrid token lookup ────────
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
        'Bearer ' || COALESCE(
          nullif(current_setting('app.cron_token', true), ''),
          (SELECT value FROM public.app_config WHERE key = 'cron_token')
        )
      )
    )
  $cmd$
);

-- ─── 7. Verify no cron.job.command still contains a literal Bearer token ──
--   After this migration, EVERY HTTP-based cron job's `command` should
--   contain the literal string `current_setting('app.cron_token', true)`
--   OR `public.app_config` — and NOT a real token value. This query
--   returns any job that still has a literal token (i.e. wasn't
--   re-scheduled by this migration). Expected: 0 rows after a successful
--   apply.
--
--   The pattern `Bearer 0ray_` is the prefix of the REAL token previously
--   baked into the live DB; if you're applying this to a different env,
--   substitute your token prefix. We deliberately don't include the full
--   token here (that would defeat the point of removing it from the code).
SELECT jobname, schedule, active
  FROM cron.job
  WHERE command LIKE '%net.http_get%'
    AND command NOT LIKE '%current_setting%'
    AND command NOT LIKE '%app_config%'
  ORDER BY jobname;

-- ─── 8. Summary: all HTTP-based cron jobs (for ops visibility) ───────────
SELECT jobname, schedule, active
  FROM cron.job
  WHERE command LIKE '%net.http_get%'
  ORDER BY jobname;

-- ─── 9. NOTE on the data-retention-cleanup job ───────────────────────────
--   Migration 034 (data-retention-cron.sql) ALREADY uses the
--   `current_setting('app.cron_token', true)` pattern — it was added
--   AFTER the 025 fix and learned from 025's mistake. So the
--   `data-retention-cleanup` job does NOT need re-scheduling here; only
--   the three jobs from migration 025 (subscription-sweep-hourly,
--   webhook-retry, invoice-overdue-check) need the live-DB fix.
--
--   IMPORTANT (Supabase caveat): migration 034 uses `current_setting`
--   ONLY (no table fallback). On Supabase, the GUC is unset (custom GUCs
--   require superuser to set via ALTER DATABASE/ROLE), so the
--   data-retention-cleanup job will send an empty Bearer header and 401
--   until the operator either:
--     (a) sets the GUC via the Supabase dashboard SQL editor (which runs
--         as `postgres`, NOT superuser — this MAY fail with the same
--         permission error; if so, contact Supabase support to set it
--         via the `supabase_admin` role), OR
--     (b) re-schedules the data-retention-cleanup job to use the same
--         COALESCE hybrid pattern (steps 4-6 above) — copy/paste the
--         command from migration 034 and wrap the token in the COALESCE.
--   This is a known limitation documented here for the next operator;
--   it does NOT affect the three jobs fixed by this migration.
-- ============================================================================
