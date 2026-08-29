-- 061_logistics_number_seq.sql
-- ============================================================================
-- PORTAL-L8 — Atomic logistics number generation.
--
-- Background
-- ----------
-- src/app/api/portal/logistics/route.ts minted logistics-request numbers
-- with `LOG-<year>-<count+1>` where `count` came from a Supabase
-- `.select('id', { count: 'exact', head: true }).gte('created_at', year)`
-- call. This is the classic non-atomic read-then-write pattern: two
-- concurrent portal clients submitting a logistics request at the same
-- time each read the same `count`, both produce the same `LOG-<year>-N`,
-- and one of them collides on the unique constraint (if any) or persists
-- a duplicate number (if there's no unique constraint on `number`).
--
-- The other doc types (offer / invoice / proforma / demand / rfq) already
-- use the canonical `get_next_doc_number(p_doc_type)` RPC backed by a
-- Postgres SEQUENCE (migration 004 + 011 + 032). This migration adds the
-- "logistics" doc_type to that RPC so the portal logistics route can use
-- the atomic path via the `nextDocNumber("logistics")` TS helper.
--
-- What this migration does
-- ------------------------
-- 1. Creates `public.logistics_number_seq` (idempotent).
-- 2. Grants USAGE to authenticated/anon so the SECURITY DEFINER RPC can
--    call nextval() on it.
-- 3. Replaces `get_next_doc_number(p_doc_type, p_tenant_id)` with a
--    version that adds a `WHEN 'logistics'` case (mirroring the existing
--    5 cases) and bumps the function's comment.
--
-- Format
-- ------
--   logistics → LOG-<YEAR>-<NNNN>  (zero-padded to 4, matching the other
--                                  doc types — the previous portal
--                                  logistics route also padded to 4)
--
-- Backward compatibility
-- ----------------------
-- The previous function signature `(p_doc_type text, p_tenant_id text
-- DEFAULT NULL)` is preserved; only the body is extended. All existing
-- callers (offers / invoices / proformas / demands / rfqs) keep working
-- unchanged. The migration is idempotent (CREATE SEQUENCE IF NOT EXISTS,
-- CREATE OR REPLACE FUNCTION).
-- ============================================================================

-- ─── Sequence ──────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS public.logistics_number_seq
  START WITH 1 INCREMENT BY 1 NO CYCLE;

-- Grant USAGE so SECURITY DEFINER function can call nextval.
GRANT USAGE ON SEQUENCE public.logistics_number_seq TO authenticated, anon;

-- ─── Extended RPC ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_next_doc_number(
  p_doc_type text,
  p_tenant_id text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_year   INT := EXTRACT(YEAR FROM NOW());
  v_seq    BIGINT;
  v_prefix TEXT;
  v_pad    TEXT;
  v_seq_name TEXT;
BEGIN
  v_prefix := CASE p_doc_type
    WHEN 'invoice'   THEN 'INV'
    WHEN 'proforma'  THEN 'PRO'
    WHEN 'offer'     THEN 'OF'
    WHEN 'demand'    THEN 'DM'
    WHEN 'rfq'       THEN 'RFQ'
    WHEN 'logistics' THEN 'LOG'
    ELSE p_doc_type
  END;

  v_seq_name := CASE p_doc_type
    WHEN 'invoice'   THEN 'invoice_number_seq'
    WHEN 'proforma'  THEN 'proforma_number_seq'
    WHEN 'offer'     THEN 'offer_number_seq'
    WHEN 'demand'    THEN 'demand_number_seq'
    WHEN 'rfq'       THEN 'rfq_number_seq'
    WHEN 'logistics' THEN 'logistics_number_seq'
    ELSE NULL
  END;

  IF v_seq_name IS NULL THEN
    RAISE EXCEPTION 'Unknown doc_type: %', p_doc_type;
  END IF;

  EXECUTE format('SELECT nextval(%L)', 'public.' || v_seq_name) INTO v_seq;
  v_pad := lpad(v_seq::TEXT, 4, '0');

  RETURN v_prefix || '-' || v_year || '-' || v_pad;
END;
$$;

COMMENT ON FUNCTION public.get_next_doc_number(text, text) IS
  'Atomic document number generator. Returns <PREFIX>-<YEAR>-<NNNN>. '
  'Uses Postgres SEQUENCE nextval() which is atomic even under concurrent '
  'calls. Prefixes: INV (invoice), PRO (proforma), OF (offer), DM (demand), '
  'RFQ (rfq), LOG (logistics). p_tenant_id is accepted but not used — '
  'sequences are global.';

-- ─── Verification ──────────────────────────────────────────────────────────
-- SELECT public.get_next_doc_number('logistics') AS test_logistics_number;
-- Expected: LOG-<year>-NNNN (e.g. LOG-2026-0001)
