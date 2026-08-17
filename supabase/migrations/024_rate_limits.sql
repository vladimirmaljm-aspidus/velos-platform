-- 024_rate_limits.sql
-- ============================================================================
-- F-7 (CSRF + Rate Limiting): DB-backed rate limits for sensitive auth routes.
--
-- BACKGROUND
--   The existing in-memory rate limiter (src/middleware.ts) is per-instance:
--   on Render's multi-instance setup each replica has its own Map, so an
--   attacker rotating across instances (or simply lucky enough to land on a
--   fresh one) bypasses the cap entirely. This migration creates a shared
--   `rate_limits` table that the new DB-backed rate limiter
--   (src/lib/security/rate-limiter.ts) uses for atomic increment + window
--   rollover via a single SQL UPSERT.
--
--   Sensitive routes that get the DB-backed limiter:
--     • /api/auth/login                 (20 / 15min per IP)
--     • /api/portal/login               (20 / 15min per IP)
--     • /api/portal/forgot-password     (5  / 15min per IP — email-flood guard)
--     • /api/portal/setup-password      (10 / 15min per IP)
--     • /api/setup                      (3  / 60min per IP — bootstrap guard)
--
--   These limits are SEPARATE from and in ADDITION to:
--     • The per-account lockout (5 failed attempts → 15min) in /api/auth/login
--       and /api/portal/login — that one is per-USERNAME, this is per-IP.
--     • The in-memory middleware caps (per-instance, defense-in-depth).
--
-- SCHEMA NOTES
--   • `key` is the rate-limit key, e.g. "login:ip:1.2.3.4". UNIQUE constraint
--     lets us do an atomic UPSERT (INSERT … ON CONFLICT DO UPDATE) so the
--     increment + window-rollover is race-free across concurrent requests.
--   • `count` is the number of hits in the current window.
--   • `window_start` is when the current window began. If now() -
--     window_start > windowMs, the limiter resets count to 1 and bumps
--     window_start to now().
--   • No RLS — the table is accessed ONLY by the service_role (server-side
--     rate-limiter util). Anon access is blocked by default (RLS defaults to
--     "no access" when no policy exists) since we never grant a policy.
--
-- TTL
--   A pg_cron job `rate-limits-cleanup` runs hourly and deletes rows whose
--   window_start is older than 24h — keeps the table bounded (stale windows
--   for IPs that never come back would otherwise accumulate forever).
-- ============================================================================

-- ─── 1. Table ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.rate_limits (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key          TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 1,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(key)
);

-- ─── 2. Indexes ────────────────────────────────────────────────────────────
-- The UNIQUE constraint on `key` already provides an index for lookups.
-- Add a partial index on window_start for the hourly cleanup sweep.
CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start
  ON public.rate_limits(window_start);

-- ─── 3. Row Level Security ────────────────────────────────────────────────
-- Enable RLS but DO NOT create any policy — this means anon/authenticated
-- roles are denied all access. Only the service_role (used by the rate
-- limiter util on the server) bypasses RLS. Defense-in-depth against
-- accidental anon-key exposure.
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

-- Drop any pre-existing policies (idempotent re-runs — should be a no-op
-- since we never create any, but harmless to include).
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'rate_limits'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.rate_limits', rec.policyname);
  END LOOP;
END $$;

-- ─── 3b. Atomic check_rate_limit RPC ──────────────────────────────────────
-- A single-statement UPSERT that atomically:
--   • INSERTs the row with count=1 if it doesn't exist
--   • Resets count=1 + window_start=now() if the existing window has rolled
--     over (now - window_start > windowMs)
--   • Increments count by 1 otherwise
-- All inside one SQL statement so concurrent requests cannot race the
-- count (Postgres serializes conflicts on the UNIQUE(key) constraint).
-- Returns: { cnt, window_start, allowed } where `allowed = cnt <= max`.
--
-- SECURITY DEFINER so the function runs with the owner's privileges
-- (service_role) — lets anon/authenticated callers use it without an RLS
-- policy on the table. The function is read-only on its inputs and only
-- touches the rate_limits table.
--
-- NOTE: the output column is named `cnt` (not `count`) to avoid ambiguity
-- with the `rate_limits.count` table column inside the RETURNING clause.
--
-- DROP + CREATE (instead of CREATE OR REPLACE) so we can change the return
-- signature if the function pre-exists with a different shape. Idempotent.
DROP FUNCTION IF EXISTS public.check_rate_limit(TEXT, INTEGER, BIGINT);

CREATE FUNCTION public.check_rate_limit(
  p_key TEXT,
  p_max_attempts INTEGER,
  p_window_ms BIGINT
) RETURNS TABLE(cnt INTEGER, window_start TIMESTAMPTZ, allowed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now        TIMESTAMPTZ := now();
  v_cnt        INTEGER;
  v_window_st  TIMESTAMPTZ;
BEGIN
  -- Atomic UPSERT: INSERT … ON CONFLICT (key) DO UPDATE.
  -- Postgres serializes conflicts on the UNIQUE(key) constraint, so two
  -- concurrent requests will see cnt=N and cnt=N+1 respectively — never
  -- both cnt=N. The CASE expressions handle window rollover.
  INSERT INTO public.rate_limits (key, count, window_start, updated_at)
  VALUES (p_key, 1, v_now, v_now)
  ON CONFLICT (key) DO UPDATE
    SET
      count        = CASE
                       WHEN extract(epoch from (v_now - public.rate_limits.window_start)) * 1000 >= p_window_ms
                       THEN 1
                       ELSE public.rate_limits.count + 1
                     END,
      window_start = CASE
                       WHEN extract(epoch from (v_now - public.rate_limits.window_start)) * 1000 >= p_window_ms
                       THEN v_now
                       ELSE public.rate_limits.window_start
                     END,
      updated_at   = v_now
  RETURNING public.rate_limits.count, public.rate_limits.window_start
    INTO v_cnt, v_window_st;

  RETURN QUERY SELECT v_cnt, v_window_st, (v_cnt <= p_max_attempts);
END;
$$;

-- Revoke EXECUTE from anon/authenticated; only service_role (which bypasses
-- everything anyway) and the function owner can call it.
REVOKE EXECUTE ON FUNCTION public.check_rate_limit(TEXT, INTEGER, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(TEXT, INTEGER, BIGINT) TO service_role;

-- ─── 4. pg_cron: hourly cleanup of stale rate-limit windows ────────────────
-- Rows whose window_start is older than 24h are dead weight (the next hit
-- for that key would have reset the window anyway, but the row hangs around
-- if the IP never returns). Hourly sweep keeps the table bounded.
SELECT cron.unschedule('rate-limits-cleanup')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rate-limits-cleanup');

SELECT cron.schedule(
  'rate-limits-cleanup',
  '0 * * * *',  -- top of every hour
  $$
    DELETE FROM public.rate_limits
    WHERE window_start < now() - interval '24 hours';
  $$
);

-- ─── 5. Verify ────────────────────────────────────────────────────────────
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'rate-limits-cleanup';
