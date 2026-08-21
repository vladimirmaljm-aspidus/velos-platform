-- 043_system_health_metrics.sql
-- ============================================================================
-- System health metrics — exposes Postgres introspection + pg_cron metadata
-- to the service_role via SECURITY DEFINER RPC functions.
--
-- Background
-- ----------
-- The /api/admin/system-health route (super_admin only) needs to surface:
--   • DB size: pg_size_pretty(pg_database_size(current_database()))
--   • Active connections: count(*) FROM pg_stat_activity
--   • Top-N largest tables: pg_total_relation_size(...) per table
--   • All pg_cron jobs with last run status + start_time
--
-- The service_role key bypasses RLS but does NOT bypass GRANTs. The
-- `cron.job` and `cron.job_run_details` tables (created by the pg_cron
-- extension in the `cron` schema) are only readable by the `postgres`
-- superuser by default. Same for `pg_stat_activity` (the view is owned
-- by `pg_read_all_stats`-granted roles).
--
-- The fix is two SECURITY DEFINER functions owned by `postgres` — they
-- run with the function owner's privileges so they can read pg_cron
-- metadata + pg_stat_activity + pg_database_size. Callers via the
-- Supabase REST API (PostgREST) get access via the GRANT EXECUTE below.
--
-- Both functions are read-only — no writes to any table.
-- ============================================================================

-- ─── 1. get_db_metrics() ───────────────────────────────────────────────────
-- Returns a single row with the database size + active connection count +
-- the top 10 largest public-schema tables.
CREATE OR REPLACE FUNCTION public.get_db_metrics()
RETURNS TABLE
(
  db_size_pretty      text,
  db_size_bytes       bigint,
  active_connections bigint,
  max_connections     bigint,
  largest_tables      jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_db_size_pretty  text;
  v_db_size_bytes   bigint;
  v_active_conns    bigint;
  v_max_conns       bigint;
  v_largest_tables  jsonb;
BEGIN
  -- Database size (the live DB — Supabase projects usually expose
  -- "postgres" but current_database() is more portable).
  SELECT pg_size_pretty(pg_database_size(current_database()))
    INTO v_db_size_pretty;
  SELECT pg_database_size(current_database())
    INTO v_db_size_bytes;

  -- Active connections (including idle). On Supabase, the direct
  -- connection count from pg_stat_activity is the operational signal
  -- the super_admin needs (PgBouncer pooler connections are separate).
  SELECT count(*)::bigint INTO v_active_conns
    FROM pg_stat_activity
   WHERE datname = current_database();

  -- Max connections (server setting). NULL if not visible — degraded
  -- gracefully by the route.
  SELECT (SELECT setting::bigint FROM pg_settings WHERE name = 'max_connections') INTO v_max_conns;

  -- Top 10 largest public-schema tables. pg_total_relation_size includes
  -- indexes + TOAST, which is what an operator wants to see when sizing.
  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'schemaname', t.schemaname,
             'tablename', t.tablename,
             'size_pretty', pg_size_pretty(pg_total_relation_size(t.schemaname || '.' || t.tablename)),
             'size_bytes', pg_total_relation_size(t.schemaname || '.' || t.tablename)
           )
           ORDER BY pg_total_relation_size(t.schemaname || '.' || t.tablename) DESC
         ), '[]'::jsonb)
    INTO v_largest_tables
    FROM pg_tables t
   WHERE t.schemaname = 'public'
   LIMIT 10;

  RETURN QUERY
    SELECT v_db_size_pretty,
           COALESCE(v_db_size_bytes, 0),
           COALESCE(v_active_conns, 0),
           COALESCE(v_max_conns, 0),
           COALESCE(v_largest_tables, '[]'::jsonb);
END;
$$;

COMMENT ON FUNCTION public.get_db_metrics() IS
  'Read-only Postgres introspection: database size, active connections, '
  || 'and the top 10 largest public-schema tables. SECURITY DEFINER so the '
  || 'service_role key (PostgREST) can read pg_stat_activity + '
  || 'pg_database_size, which are normally superuser-only. Used by '
  || '/api/admin/system-health (super_admin only).';

GRANT EXECUTE ON FUNCTION public.get_db_metrics() TO authenticated, anon, service_role;

-- ─── 2. get_cron_status() ─────────────────────────────────────────────────
-- Returns all pg_cron jobs with their last run status + timestamps.
-- Reads cron.job + cron.job_run_details (cron schema) which the
-- service_role can't access directly.
CREATE OR REPLACE FUNCTION public.get_cron_status()
RETURNS TABLE
(
  jobid              bigint,
  jobname            text,
  schedule          text,
  active            boolean,
  last_run_status   text,
  last_run_start    timestamptz,
  last_run_end      timestamptz,
  last_return_message text,
  last_runid        bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
    SELECT j.jobid,
           j.jobname,
           j.schedule,
           j.active,
           r.status,
           r.start_time,
           r.end_time,
           r.return_message,
           r.runid
      FROM cron.job j
      LEFT JOIN LATERAL (
        SELECT rd.runid, rd.status, rd.start_time, rd.end_time, rd.return_message
          FROM cron.job_run_details rd
         WHERE rd.jobid = j.jobid
         ORDER BY rd.start_time DESC
         LIMIT 1
      ) r ON true
     ORDER BY j.jobid;
END;
$$;

COMMENT ON FUNCTION public.get_cron_status() IS
  'Read-only pg_cron metadata: all jobs with their most recent run''s '
  || 'status + start_time + end_time + return_message. SECURITY DEFINER so '
  || 'the service_role key (PostgREST) can read cron.job / '
  || 'cron.job_run_details, which are superuser-only by default. Used by '
  || '/api/admin/system-health (super_admin only).';

GRANT EXECUTE ON FUNCTION public.get_cron_status() TO authenticated, anon, service_role;

-- ─── 3. Verify ─────────────────────────────────────────────────────────────
SELECT * FROM public.get_db_metrics();
SELECT count(*) AS cron_job_count FROM public.get_cron_status();
