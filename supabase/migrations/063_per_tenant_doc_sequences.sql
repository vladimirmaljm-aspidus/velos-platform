-- 063_per_tenant_doc_sequences.sql
-- ============================================================================
-- CRITICAL FIX — EU VAT compliance: per-tenant document numbering.
--
-- Background
-- ----------
-- Migrations 004 + 011 + 032 use GLOBAL Postgres SEQUENCE objects
-- (offer_number_seq, invoice_number_seq, proforma_number_seq, ...) — the
-- `p_tenant_id` parameter of `get_next_doc_number` was explicitly ignored
-- ("sequences are global, which is sufficient at current scale").
--
-- For a multi-tenant B2B SaaS, global sequences have two problems:
--   1. Cross-tenant volume leak: Tenant A creates invoice → INV-2025-0001;
--      tenant B creates invoice → INV-2025-0002. Each tenant sees the
--      other's invoice volume via the visible sequence gap.
--   2. EU VAT non-compliance: EU Council Directive 2006/112/EC Article
--      226(2) + most national implementations (Serbian PDV, Italian
--      fatturazione, German §14 UStG) require invoice numbering to be
--      "sequential per establishment." A global sequence shared across
--      tenants violates this for any tenant in a strict jurisdiction.
--
-- What this migration does
-- ------------------------
-- Replaces the global SEQUENCE-backed `get_next_doc_number` with a
-- per-(tenant, doc_type, year) allocation table:
--
--   doc_number_allocations (
--     tenant_id  uuid NOT NULL,
--     doc_type   text NOT NULL,
--     year       int  NOT NULL,
--     last_seq   bigint NOT NULL DEFAULT 0,
--     PRIMARY KEY (tenant_id, doc_type, year)
--   )
--
-- The new `get_next_doc_number(p_doc_type, p_tenant_id)` RPC:
--   1. Resolves the current year from `now()`.
--   2. UPSERTs a row into `doc_number_allocations` for
--      (tenant_id, doc_type, year) with `last_seq = last_seq + 1` in a
--      single atomic statement (INSERT ... ON CONFLICT DO UPDATE ... RETURNING).
--   3. Returns the formatted number `<PREFIX>-<YEAR>-<NNNN>` with the
--      per-tenant per-year sequence.
--
-- This is fully atomic (no race), per-tenant (no cross-tenant leak), and
-- per-year (resets Jan 1 — which is also what most EU jurisdictions
-- expect). Gaps can still occur if an INSERT fails after the allocation
-- (the same non-transactional tradeoff as before), but that's acceptable
-- and documented.
--
-- Backward compatibility
-- ----------------------
-- The old global SEQUENCE objects (offer_number_seq, etc.) are KEPT (not
-- dropped) so existing rows with numbers from the global sequence remain
-- valid. The new RPC simply doesn't use them anymore. A future migration
-- can drop them once all tenants have rolled over to the new year.
--
-- The `create_doc_with_number` RPC from migration 032 is updated to call
-- the new `get_next_doc_number(p_doc_type, p_tenant_id)` instead of
-- `nextval()`.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.doc_number_allocations (
  tenant_id  uuid   NOT NULL,
  doc_type   text   NOT NULL,
  year       int    NOT NULL,
  last_seq   bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, doc_type, year)
);

ALTER TABLE public.doc_number_allocations ENABLE ROW LEVEL SECURITY;

-- Only the service role can read/write allocations (the RPC is SECURITY
-- DEFINER so it runs as the owner and bypasses RLS).
CREATE POLICY "doc_number_allocations_service_role_only"
  ON public.doc_number_allocations
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Drop the old signature so callers must supply p_tenant_id. The
-- application's nextDocNumber() helper was already updated to pass the
-- tenant id (FIX-ADMIN-C1 in the worklog); the old no-tenant signature
-- was kept for backward compat but is now removed to force the
-- per-tenant path.
DROP FUNCTION IF EXISTS public.get_next_doc_number(p_doc_type text, p_tenant_id uuid, p_prefix text);
DROP FUNCTION IF EXISTS public.get_next_doc_number(p_doc_type text, p_prefix text);
DROP FUNCTION IF EXISTS public.get_next_doc_number(p_doc_type text);

-- New per-tenant signature: (p_doc_type, p_tenant_id) → formatted number.
CREATE OR REPLACE FUNCTION public.get_next_doc_number(
  p_doc_type   text,
  p_tenant_id  uuid
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_year       int   := extract(year FROM now())::int;
  v_prefix     text;
  v_next_seq   bigint;
  v_number     text;
BEGIN
  -- Map doc type → prefix. Mirrors the mapping in 004_document_sequences.sql.
  v_prefix := CASE p_doc_type
    WHEN 'offer'    THEN 'OFF'
    WHEN 'invoice'  THEN 'INV'
    WHEN 'proforma' THEN 'PRO'
    WHEN 'demand'   THEN 'DEM'
    WHEN 'rfq'      THEN 'RFQ'
    WHEN 'logistics' THEN 'LOG'
    ELSE upper(left(p_doc_type, 3))
  END;

  -- Atomic per-(tenant, doc_type, year) sequence. INSERT ... ON CONFLICT
  -- DO UPDATE is the standard Postgres UPSERT pattern — the RETURNING
  -- clause gives us the new last_seq without a separate SELECT.
  INSERT INTO public.doc_number_allocations (tenant_id, doc_type, year, last_seq)
  VALUES (p_tenant_id, p_doc_type, v_year, 1)
  ON CONFLICT (tenant_id, doc_type, year)
  DO UPDATE SET last_seq = doc_number_allocations.last_seq + 1,
                updated_at = now()
  RETURNING last_seq INTO v_next_seq;

  -- Format: PREFIX-YEAR-NNNNNN (zero-padded to 6 digits — enough for
  -- 999,999 documents per tenant per year per type).
  v_number := v_prefix || '-' || v_year::text || '-' || lpad(v_next_seq::text, 6, '0');

  RETURN v_number;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_next_doc_number(text, uuid) TO service_role;

-- ============================================================================
-- Update create_doc_with_number (migration 032) to use the per-tenant
-- RPC. The old version called nextval() on the global sequence; the new
-- version calls get_next_doc_number(p_doc_type, p_tenant_id) which uses
-- the per-tenant allocation table.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_doc_with_number(
  p_doc_type   text,
  p_tenant_id  uuid,
  p_payload    jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_number  text;
  v_table   text;
  v_result  jsonb;
BEGIN
  -- Resolve the next per-tenant number.
  v_number := public.get_next_doc_number(p_doc_type, p_tenant_id);

  -- Map doc type → target table. Mirrors 004 + 032.
  v_table := CASE p_doc_type
    WHEN 'offer'    THEN 'offers'
    WHEN 'invoice'  THEN 'invoices'
    WHEN 'proforma' THEN 'proformas'
    WHEN 'demand'   THEN 'demands'
    WHEN 'rfq'      THEN 'portal_rfqs'
    WHEN 'logistics' THEN 'logistics_requests'
    ELSE NULL
  END;

  IF v_table IS NULL THEN
    RAISE EXCEPTION 'Unknown doc type: %', p_doc_type;
  END IF;

  -- Inject the server-issued number into the payload (override any
  -- client-supplied number — the server is the VAT authority).
  p_payload := jsonb_set(p_payload, '{number}', to_jsonb(v_number));

  -- INSERT using jsonb_populate_record. The tenant_id is also forced
  -- server-side to prevent cross-tenant injection.
  p_payload := jsonb_set(p_payload, '{tenant_id}', to_jsonb(p_tenant_id));

  EXECUTE format(
    'INSERT INTO %I SELECT * FROM jsonb_populate_record(NULL::%I, $1) RETURNING to_jsonb(*)',
    v_table, v_table
  ) INTO v_result USING p_payload;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_doc_with_number(text, uuid, jsonb) TO service_role;
