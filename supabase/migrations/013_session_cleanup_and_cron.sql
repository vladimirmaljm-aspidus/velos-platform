-- 013_session_cleanup_and_cron.sql
-- ============================================================================
-- MAINTENANCE — addresses audit findings B-P2-2, B-P3-1.
--
-- 1. Purge stale sessions (90 expired, 45 expired+not-revoked).
-- 2. Set up pg_cron job to purge expired sessions hourly.
-- 3. Set up pg_cron job to purge expired password reset tokens.
-- 4. Set up pg_cron job to VACUUM high-churn tables.
-- ============================================================================

-- ─── 1. One-time purge of expired sessions ─────────────────────────────────
DELETE FROM public.sessions WHERE expires_at < now();

-- ─── 2. pg_cron: purge expired sessions every hour ─────────────────────────
-- Drop existing job if re-running.
SELECT cron.unschedule('session-cleanup') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'session-cleanup');

SELECT cron.schedule(
  'session-cleanup',
  '0 * * * *',  -- every hour at minute 0
  $$DELETE FROM public.sessions WHERE expires_at < now()$$
);

-- ─── 3. pg_cron: purge expired password reset tokens daily ─────────────────
SELECT cron.unschedule('password-reset-cleanup') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'password-reset-cleanup');

SELECT cron.schedule(
  'password-reset-cleanup',
  '30 3 * * *',  -- daily at 03:30 UTC
  $$DELETE FROM public.password_resets WHERE expires_at < now()$$
);

-- ─── 4. pg_cron: VACUUM ANALYZE high-churn tables weekly ───────────────────
SELECT cron.unschedule('weekly-vacuum') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'weekly-vacuum');

-- Note: VACUUM cannot run inside a transaction, so we schedule individual
-- VACUUM commands via separate cron jobs instead of a single multi-statement job.
SELECT cron.schedule('vacuum-doc-seq',    '0 4 * * 0', 'VACUUM ANALYZE public.document_sequences');
SELECT cron.schedule('vacuum-settings',   '5 4 * * 0', 'VACUUM ANALYZE public.settings');
SELECT cron.schedule('vacuum-users',     '10 4 * * 0', 'VACUUM ANALYZE public.users');
SELECT cron.schedule('vacuum-sessions',  '15 4 * * 0', 'VACUUM ANALYZE public.sessions');
SELECT cron.schedule('vacuum-audit',     '20 4 * * 0', 'VACUUM ANALYZE public.audit_logs');
SELECT cron.schedule('vacuum-known-ips', '25 4 * * 0', 'VACUUM ANALYZE public.known_ips');
SELECT cron.schedule('vacuum-inv-mov',   '30 4 * * 0', 'VACUUM ANALYZE public.inventory_movements');

-- ─── 5. Verify jobs are scheduled ──────────────────────────────────────────
SELECT jobname, schedule, active FROM cron.job WHERE jobname IN ('session-cleanup', 'password-reset-cleanup', 'weekly-vacuum', 'subscription-sweep') ORDER BY jobname;
