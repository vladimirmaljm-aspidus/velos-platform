-- 086_error_logs.sql
-- ============================================================================
-- VELOS — In-house error audit system (task 8-c).
--
-- Purpose / Namena
-- ----------------
-- Sentry exists in the codebase but its DSN is inactive, so NOTHING captures
-- runtime errors today: a broken build chunk, an unhandled promise rejection,
-- a React render crash, or a 500 from an API route all vanish into the
-- browser console / Render stdout with no aggregation and no triage surface.
--
-- This migration creates the `error_logs` table — the storage half of the
-- in-house error audit system (zero external services):
--
--   • CLIENT-side capture  — src/components/error-reporter.tsx listens to
--     window "error" + "unhandledrejection", plus explicit reportError()
--     calls from src/app/error.tsx / global-error.tsx (React render errors
--     with the Next.js digest). Reports are POSTed to the PUBLIC
--     /api/client-errors route (rate-limited 30/min per IP, 8KB body cap).
--
--   • SERVER-side capture  — src/lib/monitoring/error-audit.ts recordError()
--     (and the withErrorCapture() route wrapper) writes source='server' rows
--     for API 500s.
--
--   • ADMIN triage — the "Error Audit" admin view (GET /api/admin/errors)
--     lists / filters / resolves rows.
--
-- Design: one row per FINGERPRINT (sha256 of source+message+first stack line,
-- computed app-side) — repeated occurrences of the same bug increment
-- occurrence_count and bump last_seen_at instead of piling up rows. The
-- atomic upsert lives in the record_error RPC below (same pattern as
-- check_rate_limit in migration 024) so concurrent reports cannot race the
-- counter.
--
-- Access model: RLS ENABLED, NO POLICIES — anon/authenticated are denied
-- everything by default; only the service_role (server-side code) bypasses
-- RLS. The table is never exposed to the browser.
--
-- Retention: the record_error RPC keeps the table capped at 5000 rows
-- (oldest by last_seen_at are deleted on every insert — cheap, keeps the
-- unbounded-growth class of problems off the table).
-- ============================================================================

-- ─── 1. Table ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.error_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT,                    -- null = platform / pre-login client error
  source            TEXT NOT NULL,           -- 'client' | 'server'
  level             TEXT NOT NULL DEFAULT 'error', -- 'error' | 'warning'
  message           TEXT NOT NULL,           -- capped at 1000 chars app-side
  stack             TEXT,                    -- capped at 4000 chars app-side
  url               TEXT,                    -- page URL (client) / route path (server), 500 chars
  user_agent        TEXT,
  user_email        TEXT,                    -- enriched from the session cookie when present
  user_role         TEXT,
  context           JSONB DEFAULT '{}',      -- JSON-stringified, capped at 2000 chars app-side
  fingerprint       TEXT NOT NULL,
  occurrence_count  INTEGER NOT NULL DEFAULT 1,
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at       TIMESTAMPTZ,
  resolved_by       TEXT
);

-- One row per fingerprint: the app-side upsert hinges on this unique index.
CREATE UNIQUE INDEX IF NOT EXISTS error_logs_fingerprint_idx
  ON public.error_logs (fingerprint);

-- Admin list view is ordered by last_seen_at DESC (most recent first).
CREATE INDEX IF NOT EXISTS error_logs_last_seen_at_idx
  ON public.error_logs (last_seen_at DESC);

-- Source slicing for the stats cards / source filter.
CREATE INDEX IF NOT EXISTS error_logs_source_idx
  ON public.error_logs (source);

-- "Unresolved" partial index — the default admin filter is resolved_at IS NULL.
CREATE INDEX IF NOT EXISTS error_logs_resolved_at_open_idx
  ON public.error_logs (resolved_at)
  WHERE resolved_at IS NULL;

-- ─── 2. Row Level Security ─────────────────────────────────────────────────
-- Enable RLS but DO NOT create any policy: anon/authenticated roles get NO
-- access (RLS default-deny). Only the service_role (server-side error-audit
-- util / API routes) bypasses RLS. Defense-in-depth against accidental
-- anon-key exposure — error payloads can contain user emails and URLs.
ALTER TABLE public.error_logs ENABLE ROW LEVEL SECURITY;

-- Drop any pre-existing policies (idempotent re-runs; we never create any).
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'error_logs'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.error_logs', rec.policyname);
  END LOOP;
END $$;

-- ─── 3. Atomic record_error RPC ────────────────────────────────────────────
-- Single-statement UPSERT that atomically:
--   • INSERTs the fingerprinted row on first sight, OR
--   • on conflict (same fingerprint — the same bug seen again):
--       – increments occurrence_count
--       – bumps last_seen_at to now()
--       – keeps the EARLIEST first_seen_at (never overwritten)
--       – coalesces richer fields (a sighting WITH a stack/url/email never
--         overwrites an existing value with NULL — but upgrades NULLs)
--       – escalates level to 'error' (never downgrades to warning)
--       – upgrades an empty '{}' context to the incoming context
--       – REOPENS the row when it re-occurs after being resolved: a
--         regression is exactly what the admin needs to see again
--         (resolved_at / resolved_by are cleared; the original resolve
--         action stays traceable in audit_logs)
--
-- Postgres serializes conflicts on the unique fingerprint index, so two
-- concurrent reports of the same bug get count=N and count=N+1 — never both
-- N. Same pattern as check_rate_limit (migration 024).
--
-- SECURITY DEFINER so the function runs with the owner's privileges — the
-- app calls it with the service_role key; anon/authenticated EXECUTE is
-- revoked below.
--
-- DROP + CREATE (instead of CREATE OR REPLACE) so a signature change on a
-- pre-existing function is applied cleanly. Idempotent.
DROP FUNCTION IF EXISTS public.record_error(JSONB);

CREATE FUNCTION public.record_error(p_payload JSONB)
RETURNS public.error_logs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.error_logs;
  v_fp  text;
BEGIN
  -- AUDIT28 hardening: compute a fingerprint when the caller didn't pass one
  -- (md5 of source+message+stack head) so a direct RPC call without a
  -- fingerprint cannot violate the NOT NULL constraint (23502).
  v_fp := p_payload->>'fingerprint';
  IF v_fp IS NULL OR v_fp = '' THEN
    v_fp := 'fp_' || md5(
      COALESCE(p_payload->>'source','') || '|' ||
      COALESCE(p_payload->>'message','') || '|' ||
      split_part(COALESCE(p_payload->>'stack',''), E'\n', 1)
    );
  END IF;

  INSERT INTO public.error_logs (
    tenant_id, source, level, message, stack, url,
    user_agent, user_email, user_role, context, fingerprint
  ) VALUES (
    p_payload->>'tenant_id',
    p_payload->>'source',
    COALESCE(p_payload->>'level', 'error'),
    p_payload->>'message',
    p_payload->>'stack',
    p_payload->>'url',
    p_payload->>'user_agent',
    p_payload->>'user_email',
    p_payload->>'user_role',
    COALESCE(p_payload->'context', '{}'::jsonb),
    v_fp
  )
  ON CONFLICT (fingerprint) DO UPDATE
    SET
      occurrence_count = public.error_logs.occurrence_count + 1,
      last_seen_at     = now(),
      tenant_id        = COALESCE(EXCLUDED.tenant_id, public.error_logs.tenant_id),
      stack            = COALESCE(EXCLUDED.stack, public.error_logs.stack),
      url              = COALESCE(EXCLUDED.url, public.error_logs.url),
      user_agent       = COALESCE(EXCLUDED.user_agent, public.error_logs.user_agent),
      user_email       = COALESCE(EXCLUDED.user_email, public.error_logs.user_email),
      user_role        = COALESCE(EXCLUDED.user_role, public.error_logs.user_role),
      context          = CASE
                           WHEN public.error_logs.context = '{}'::jsonb
                             AND EXCLUDED.context IS NOT NULL
                             AND EXCLUDED.context <> '{}'::jsonb
                           THEN EXCLUDED.context
                           ELSE public.error_logs.context
                         END,
      level            = CASE
                           WHEN EXCLUDED.level = 'error' THEN 'error'
                           ELSE public.error_logs.level
                         END,
      resolved_at      = NULL,
      resolved_by      = NULL
  RETURNING * INTO v_row;

  DELETE FROM public.error_logs
  WHERE id NOT IN (
    SELECT id FROM public.error_logs ORDER BY last_seen_at DESC LIMIT 5000
  );

  RETURN v_row;
END;
$$;
-- Only the server (service_role) may record errors.
REVOKE EXECUTE ON FUNCTION public.record_error(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_error(JSONB) TO service_role;

-- ─── 4. Comments ───────────────────────────────────────────────────────────
COMMENT ON TABLE public.error_logs IS
  'In-house error audit (task 8-c): client JS errors, unhandled rejections, React render errors and API 500s, aggregated by fingerprint. Service-role only (RLS enabled, no policies).';
COMMENT ON COLUMN public.error_logs.fingerprint IS
  'sha256(source + message + first stack line), first 16 hex chars — computed app-side (src/lib/monitoring/error-audit.ts). Unique per distinct bug signature.';
COMMENT ON COLUMN public.error_logs.occurrence_count IS
  'Times this fingerprint has been reported. Incremented atomically by the record_error RPC (recurrence reopens a resolved row).';
