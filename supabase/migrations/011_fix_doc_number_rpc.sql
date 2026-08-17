-- 011_fix_doc_number_rpc.sql
-- ============================================================================
-- CRITICAL FIX — addresses audit finding C-1.
--
-- Migration 004 created get_next_doc_number(doc_type text).
-- Migration 008 created a SECOND overload get_next_doc_number(p_doc_type text, p_tenant_id text DEFAULT NULL)
-- with different prefix mappings (OFR vs OF for offers) and references to
-- non-existent sequences (demand_number_seq, rfq_number_seq).
--
-- This caused ERROR 42725: function get_next_doc_number(text) is not unique
-- — every call failed and fell back to the racy `listX().total + 1` path.
--
-- This migration:
-- 1. Drops BOTH overloads.
-- 2. Creates a SINGLE canonical function that handles all 5 doc types
--    (invoice, proforma, offer, demand, rfq) with consistent prefixes.
-- 3. Creates any missing sequences.
-- 4. Uses nextval() which is atomic at the Postgres level.
-- ============================================================================

-- Drop both overloads.
DROP FUNCTION IF EXISTS public.get_next_doc_number(text);
DROP FUNCTION IF EXISTS public.get_next_doc_number(text, text);

-- Create missing sequences (idempotent).
CREATE SEQUENCE IF NOT EXISTS public.invoice_number_seq  START WITH 1 INCREMENT BY 1 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS public.proforma_number_seq START WITH 1 INCREMENT BY 1 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS public.offer_number_seq    START WITH 1 INCREMENT BY 1 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS public.demand_number_seq   START WITH 1 INCREMENT BY 1 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS public.rfq_number_seq      START WITH 1 INCREMENT BY 1 NO CYCLE;

-- Grant USAGE so SECURITY DEFINER function can call nextval.
GRANT USAGE ON SEQUENCE public.invoice_number_seq  TO authenticated, anon;
GRANT USAGE ON SEQUENCE public.proforma_number_seq TO authenticated, anon;
GRANT USAGE ON SEQUENCE public.offer_number_seq    TO authenticated, anon;
GRANT USAGE ON SEQUENCE public.demand_number_seq   TO authenticated, anon;
GRANT USAGE ON SEQUENCE public.rfq_number_seq      TO authenticated, anon;

-- Single canonical function.
-- Returns format: <PREFIX>-<YEAR>-<NNNN> (e.g. INV-2026-0001).
-- p_tenant_id is accepted for forward compatibility but not used —
-- sequences are global, which is sufficient at current scale. For true
-- per-tenant isolation, switch to per-tenant sequences keyed by name.
CREATE OR REPLACE FUNCTION public.get_next_doc_number(
  p_doc_type text,
  p_tenant_id text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_year INT := EXTRACT(YEAR FROM NOW());
  v_seq BIGINT;
  v_prefix TEXT;
  v_pad TEXT;
  v_seq_name TEXT;
BEGIN
  v_prefix := CASE p_doc_type
    WHEN 'invoice'  THEN 'INV'
    WHEN 'proforma' THEN 'PRO'
    WHEN 'offer'    THEN 'OF'
    WHEN 'demand'   THEN 'DM'
    WHEN 'rfq'      THEN 'RFQ'
    ELSE p_doc_type
  END;

  v_seq_name := CASE p_doc_type
    WHEN 'invoice'  THEN 'invoice_number_seq'
    WHEN 'proforma' THEN 'proforma_number_seq'
    WHEN 'offer'    THEN 'offer_number_seq'
    WHEN 'demand'   THEN 'demand_number_seq'
    WHEN 'rfq'      THEN 'rfq_number_seq'
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
  'RFQ (rfq). p_tenant_id is accepted but not used — sequences are global.';

-- Verify it works.
SELECT public.get_next_doc_number('invoice') AS test_invoice_number;
