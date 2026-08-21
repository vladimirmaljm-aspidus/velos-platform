-- 034_data_retention_cron.sql
-- ============================================================================
-- PII DATA RETENTION POLICY ENFORCEMENT (audit finding B-1 / P3-1).
--
-- Background
-- ----------
-- GDPR Article 5(1)(e) — "storage limitation": personal data must be kept
-- in a form which permits identification of data subjects for no longer
-- than is necessary for the purposes for which the data is processed.
--
-- The platform persists PII across many tables. The retention policy is
-- documented in `src/lib/compliance/retention.ts` and enforced by the cron
-- route `src/app/api/cron/data-retention/route.ts` (TypeScript, not SQL,
-- so the policy is visible in the application layer — easier to audit than
-- a SQL string in `cron.job.command`).
--
-- This migration schedules the cron route via pg_cron + net.http_get, so
-- the retention cleanup runs DAILY at 03:00 UTC. The route itself is the
-- source of truth for which tables are cleaned and what their retention
-- periods are — this migration only schedules it.
--
-- Existing migration-level pg_cron jobs (013 session-cleanup, 013
-- password-reset-cleanup, 024 rate-limits-cleanup) are NOT removed — they
-- remain as defence-in-depth. If the HTTP route is down, the SQL-level
-- cleanups keep the high-churn tables (sessions, password_resets,
-- rate_limits) bounded. The HTTP route covers the additional tables
-- (login_history, mail_queue, notifications) that have no SQL-level cron.
--
-- CRON_TOKEN
-- ----------
-- The token is stored as the Supabase setting `app.cron_token` (set via
-- `ALTER ROLE postgres SET app.cron_token = '...'` or via the Supabase
-- dashboard). The cron command reads it via `current_setting('app.cron_token',
-- true)` so the token does NOT appear in `cron.job.command` (which is
-- visible to anyone with SELECT on cron.job). This is the same pattern
-- used by migrations 025 + the C-5 cron-auth refactor.
--
-- Idempotent
-- ----------
-- All `cron.unschedule` calls are guarded by `WHERE EXISTS` so the
-- migration can be re-run safely. `cron.schedule` errors if a job with
-- the same name already exists, so we unschedule first.
-- ============================================================================

-- ─── 1. Schedule data-retention-cleanup — daily at 03:00 UTC ───────────────
SELECT cron.unschedule('data-retention-cleanup')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'data-retention-cleanup');

SELECT cron.schedule(
  'data-retention-cleanup',
  '0 3 * * *',  -- daily at 03:00 UTC
  $cmd$
    SELECT net.http_get(
      url := 'https://aspidus.onrender.com/api/cron/data-retention',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || current_setting('app.cron_token', true)
      )
    )
  $cmd$
);

-- ─── 2. Verify ─────────────────────────────────────────────────────────────
SELECT jobname, schedule, active
  FROM cron.job
  WHERE jobname = 'data-retention-cleanup'
  ORDER BY jobname;

-- ─── 3. Summary of all HTTP-based cron jobs (for ops visibility) ──────────
-- Lists every pg_cron job that calls the app via net.http_get — this is
-- the set the ops team needs to monitor for 401s / 500s.
SELECT jobname, schedule, active
  FROM cron.job
  WHERE command LIKE '%net.http_get%'
  ORDER BY jobname;
