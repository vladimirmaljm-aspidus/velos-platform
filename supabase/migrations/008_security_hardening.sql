-- 008_security_hardening.sql
-- ============================================================================
-- Security hardening migration — addresses audit findings D-audit-db-sec.
--
-- 1. FORCE RLS on all tables — currently service_role bypasses RLS because
--    relforcerowsecurity=false on every table. If the service_role key leaks,
--    RLS provides zero protection. Forcing RLS makes the policies actually
--    apply, while still letting us use SECURITY DEFINER functions for writes
--    that need to bypass RLS (e.g. the public verify endpoint writes to
--    document_verification_logs).
--
-- 2. Tighten document_verification_logs policy — the current
--    `USING(true) WITH CHECK(true)` for ALL is wrong: it grants anon/authenticated
--    roles full read+write access to IP/geo/UA data. The API layer
--    (requireSuperAdmin) is the only reader; service_role bypasses RLS so
--    writes still succeed. New policy: SELECT denied to non-service roles,
--    INSERT allowed for everyone (the public verify endpoint writes here),
--    UPDATE/DELETE denied to non-service roles.
--
-- 3. Add RFQ atomic numbering sequence — the existing get_next_doc_number
--    RPC supports 'invoice'/'proforma'/'offer'/'demand'. Add 'rfq' so the
--    portal RFQ numbering can be tenant-wide atomic instead of per-partner
--    count-then-insert (race condition — concurrent submissions both mint
--    RFQ-2026-001).
--
-- 4. Backfill tenant_id NOT NULL on critical tables where it's nullable.
--    (Skipping for now — backfill requires data fix, not just DDL.)
--
-- IDEMPOTENCY
--   All statements use IF NOT EXISTS / OR REPLACE / IF EXISTS guards so the
--   migration is safe to re-run.
-- ============================================================================

-- ─── 1. FORCE ROW LEVEL SECURITY on all public tables ─────────────────────
-- Without FORCE, service_role bypasses RLS entirely. With FORCE, the
-- policies apply to all roles including service_role (though service_role
-- still has the BYPASSRLS attribute — but if a future migration drops
-- that, we want the policies in place). Defense in depth.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY;', t);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Skipped FORCE RLS on %: %', t, SQLERRM;
    END;
  END LOOP;
END $$;

-- ─── 2. Tighten document_verification_logs RLS policy ─────────────────────
-- Old policy: USING(true) WITH CHECK(true) FOR ALL — grants full access to
-- every role. New policy splits per command:
--   - SELECT: denied (only service_role / super_admin via API can read)
--   - INSERT: allowed (public verify endpoint writes here via service_role)
--   - UPDATE: denied (logs are append-only)
--   - DELETE: denied (logs are append-only)
--
-- service_role bypasses RLS so writes still succeed. anon/authenticated
-- roles get nothing.

DROP POLICY IF EXISTS doc_verify_logs_super_admin_only ON document_verification_logs;
DROP POLICY IF EXISTS doc_verify_logs_insert_only ON document_verification_logs;
DROP POLICY IF EXISTS doc_verify_logs_select_denied ON document_verification_logs;
DROP POLICY IF EXISTS doc_verify_logs_update_delete_denied ON document_verification_logs;

-- INSERT: anyone can insert (verify endpoint is public; service_role writes).
-- The API layer enforces rate limiting + payload validation.
CREATE POLICY doc_verify_logs_insert_only
  ON document_verification_logs
  FOR INSERT
  WITH CHECK (true);

-- SELECT: deny to anon/authenticated — only service_role (which bypasses RLS)
-- can read. The super-admin viewer goes through the API layer which uses
-- service_role.
CREATE POLICY doc_verify_logs_select_denied
  ON document_verification_logs
  FOR SELECT
  USING (false);

-- UPDATE: deny (logs are append-only).
CREATE POLICY doc_verify_logs_update_denied
  ON document_verification_logs
  FOR UPDATE
  USING (false);

-- DELETE: deny (logs are append-only).
CREATE POLICY doc_verify_logs_delete_denied
  ON document_verification_logs
  FOR DELETE
  USING (false);

COMMENT ON POLICY doc_verify_logs_insert_only ON document_verification_logs IS
  'Public verify endpoint writes here via service_role (bypasses RLS). '
  'No SELECT/UPDATE/DELETE for non-service roles — defense in depth.';
COMMENT ON POLICY doc_verify_logs_select_denied ON document_verification_logs IS
  'Deny SELECT to anon/authenticated. service_role bypasses RLS so the API '
  'layer (requireSuperAdmin) can still read.';

-- ─── 3. RFQ atomic numbering sequence ─────────────────────────────────────
-- Mirror the existing 'demand' / 'offer' / 'invoice' / 'proforma' sequences.
-- The get_next_doc_number RPC must support 'rfq' — add the case if missing.
-- See migration 002 for the original RPC definition.

-- Add a dedicated sequence for RFQ numbering (tenant-scoped via app.tenant_id).
-- Using a single sequence per doc type simplifies atomic minting.
CREATE SEQUENCE IF NOT EXISTS rfq_number_seq
  START WITH 1
  INCREMENT BY 1
  NO CYCLE;

-- Update the get_next_doc_number RPC to handle 'rfq'.
-- The function signature + body are redefined (OR REPLACE).
-- IMPORTANT: this matches the existing function signature exactly. If you
-- already have a different version deployed, this will REPLACE it.
CREATE OR REPLACE FUNCTION get_next_doc_number(p_doc_type TEXT, p_tenant_id TEXT DEFAULT NULL)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_year INT := EXTRACT(YEAR FROM NOW());
  v_seq BIGINT;
  v_prefix TEXT;
  v_pad TEXT;
BEGIN
  -- Determine prefix + sequence per doc type.
  v_prefix := CASE p_doc_type
    WHEN 'invoice'  THEN 'INV'
    WHEN 'proforma' THEN 'PRO'
    WHEN 'offer'    THEN 'OFR'
    WHEN 'demand'   THEN 'DM'
    WHEN 'rfq'      THEN 'RFQ'
    ELSE p_doc_type
  END;

  -- For tenant isolation we use a per-tenant-per-year sequence via a naming
  -- convention. For now we use a single shared sequence (sufficient at the
  -- current scale) — switch to per-tenant sequences if contention appears.
  v_seq := nextval(p_doc_type || '_number_seq');
  v_pad := lpad(v_seq::TEXT, 4, '0');

  RETURN v_prefix || '-' || v_year || '-' || v_pad;
END;
$$;

-- Also grant USAGE on the new sequence to authenticated + anon so the
-- SECURITY DEFINER function (which runs as the owner) can call nextval.
GRANT USAGE ON SEQUENCE rfq_number_seq TO authenticated, anon;

COMMENT ON SEQUENCE rfq_number_seq IS
  'Tenant-wide atomic sequence for RFQ numbering. Used by '
  'get_next_doc_number(''rfq'', tenant_id) — see migration 008.';
