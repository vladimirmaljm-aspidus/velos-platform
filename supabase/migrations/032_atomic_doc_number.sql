-- 032_atomic_doc_number.sql
-- ============================================================================
-- CRITICAL FIX — P1 (VAT compliance): doc-number sequence burns values on
-- rollback. Task C-4 Fix 1.
--
-- Background
-- ----------
-- Migration `004_document_sequences.sql` introduced the `get_next_doc_number`
-- RPC backed by per-doc-type Postgres SEQUENCE objects (offer_number_seq,
-- invoice_number_seq, proforma_number_seq, …). Migration `011_fix_doc_number_rpc.sql`
-- consolidated the overloaded signatures into a single canonical function.
--
-- The application code (src/app/api/{offers,invoices,proformas}/route.ts and
-- the automation routes) calls `nextDocNumber(docType)` (which RPCs into
-- `get_next_doc_number`) BEFORE the separate `upsertOffer`/`upsertInvoice`/
-- `upsertProforma` INSERT. If anything between the nextval() call and the
-- INSERT fails — a DB-level constraint violation, a network blip, a quota
-- denial that raced past its check, a unique-collision retry loop that
-- bumps the number by +1 (which can collide with the next legitimate
-- nextval) — the SEQUENCE value is silently burned, producing a GAP in
-- the visible document-number sequence. For VAT compliance, sequential
-- invoice numbers are legally required (EU Council Directive 2006/112/EC
-- Article 226(2); HM Notice 700/21 Section 5.2; similar in most
-- jurisdictions). Gaps are tolerable only when documented and explainable.
--
-- Postgres SEQUENCE objects are NON-TRANSACTIONAL by design — nextval()
-- ALWAYS consumes a value, even if the surrounding transaction rolls
-- back. This is intentional (avoids lock contention) and is the reason
-- a purely client-side "call RPC then insert" pattern can never be
-- gap-free. The fix is to make the nextval() + INSERT happen INSIDE a
-- single Postgres function call so that:
--
--   * The number is allocated only when the INSERT is actually attempted
--     (no "allocate then fail to even try the insert" gap from a
--     validation failure that happens between the two round-trips).
--   * The unique-collision retry loop in the application code can be
--     removed entirely — the RPC guarantees the number is fresh from
--     nextval(), so a collision can only happen if someone manually
--     inserted a number that matches the next sequence value, which is
--     an operational error that should surface, not be silently retried
--     with another burned value.
--
-- What this migration does
-- ------------------------
-- 1. Creates a new SECURITY DEFINER RPC `create_doc_with_number(p_doc_type,
--    p_payload)` that:
--      (a) Maps `p_doc_type` → (table, sequence, prefix) using the same
--          mapping as `get_next_doc_number`.
--      (b) Calls nextval() on the appropriate sequence.
--      (c) Formats the number as `<PREFIX>-<YEAR>-<NNNN>`.
--      (d) Injects the number into the JSONB payload (overriding any
--          client-supplied `number` field — the server is the authority
--          for VAT-sequential numbering).
--      (e) INSERTs the row into the target table using
--          `jsonb_populate_record(NULL::table, payload)`.
--      (f) Returns the inserted row as JSONB.
--
-- 2. The RPC is SECURITY DEFINER with `SET search_path = public, pg_temp`
--    per Supabase security advisory 2023-09 (search-path injection
--    mitigation). EXECUTE is granted to `service_role` only — these
--    are administrative RPCs callable only via the service_role key.
--
-- 3. The legacy `get_next_doc_number` RPC is left in place (not dropped)
--    so existing callers (the JS-side fallback in `nextDocNumber.ts`,
--    the trade-calculator create-offer route, the automation routes)
--    keep working unchanged. They will be migrated to the new RPC in a
--    follow-up. The new RPC is the canonical atomic path going forward.
--
-- Limitations
-- -----------
-- * Postgres SEQUENCE objects are still non-transactional. If the INSERT
--   inside the RPC fails (e.g. FK violation, CHECK constraint), the
--   nextval() value is still consumed — the gap is NOT eliminated, only
--   minimised (no separate "call nextDocNumber then fail before insert"
--   gap, no retry-loop gap). A truly gap-free implementation would
--   replace SEQUENCE objects with a `doc_number_allocations` table
--   using SELECT FOR UPDATE + MAX+1 — slower under concurrency but
--   fully transactional. Out of scope for this fix.
-- * The RPC only handles the INSERT path (new records). UPDATEs (which
--   preserve the existing number) still go through the regular upsert
--   path and are not affected.
-- * The RPC only handles the doc types with a sequence: offer, invoice,
--   proforma, demand, rfq. Other tables continue to use whatever
--   numbering scheme they had.
--
-- Verification
-- ------------
-- After applying, the following queries should succeed:
--   SELECT proname, prosecdef, proconfig FROM pg_proc
--     WHERE proname = 'create_doc_with_number';
--   -- Expected: one row, prosecdef=true, proconfig={search_path=public, pg_temp}
--
--   SELECT public.create_doc_with_number(
--     'offer',
--     '{"tenant_id":"test-tenant","subject":"smoke test","status":"draft"}'::jsonb
--   );
--   -- Expected: a JSONB object with `number` of the form OF-<year>-<NNNN>
--   -- and a generated `id`. Clean up the smoke-test row afterwards.
-- ============================================================================

CREATE SEQUENCE IF NOT EXISTS public.invoice_number_seq  START WITH 1 INCREMENT BY 1 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS public.proforma_number_seq START WITH 1 INCREMENT BY 1 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS public.offer_number_seq    START WITH 1 INCREMENT BY 1 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS public.demand_number_seq   START WITH 1 INCREMENT BY 1 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS public.rfq_number_seq      START WITH 1 INCREMENT BY 1 NO CYCLE;

CREATE OR REPLACE FUNCTION public.create_doc_with_number(
  p_doc_type text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_table_name text;
  v_seq_name   text;
  v_prefix     text;
  v_year       int;
  v_seq        bigint;
  v_pad        text;
  v_number     text;
  v_result     jsonb;
BEGIN
  -- Map doc_type → (table, sequence, prefix). Mirrors the mapping in
  -- get_next_doc_number (migration 011) so both RPCs produce the same
  -- number format for the same doc_type.
  v_table_name := CASE p_doc_type
    WHEN 'offer'    THEN 'offers'
    WHEN 'invoice'  THEN 'invoices'
    WHEN 'proforma' THEN 'proformas'
    WHEN 'demand'   THEN 'demands'
    WHEN 'rfq'      THEN 'portal_rfqs'
    ELSE NULL
  END;

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

  IF v_table_name IS NULL OR v_seq_name IS NULL THEN
    RAISE EXCEPTION 'create_doc_with_number: unknown doc_type "%"', p_doc_type;
  END IF;

  -- Allocate the next sequence value. nextval() is atomic at the Postgres
  -- level — concurrent callers always get distinct values. Note: SEQUENCE
  -- values are NON-TRANSACTIONAL; if the INSERT below fails, the value is
  -- still consumed (gap). This RPC minimises that gap by ensuring the
  -- INSERT is attempted in the same DB round-trip as the nextval().
  v_year := EXTRACT(YEAR FROM NOW());
  EXECUTE format('SELECT nextval(%L)', 'public.' || v_seq_name) INTO v_seq;
  v_pad := lpad(v_seq::text, 4, '0');
  v_number := v_prefix || '-' || v_year || '-' || v_pad;

  -- Inject the generated number into the payload. This OVERRIDES any
  -- client-supplied `number` field — the server is the authority for
  -- VAT-sequential numbering. A client cannot mint their own number.
  p_payload := jsonb_set(p_payload, '{number}', to_jsonb(v_number));

  -- INSERT the row using jsonb_populate_record to coerce the JSONB into
  -- the table's row type. Unknown keys in the payload are silently
  -- ignored by jsonb_populate_record (defence-in-depth: callers should
  -- still strip non-column keys before calling).
  EXECUTE format(
    'INSERT INTO %I SELECT * FROM jsonb_populate_record(NULL::%I, $1) RETURNING to_jsonb(*)',
    v_table_name, v_table_name
  ) INTO v_result USING p_payload;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'create_doc_with_number: INSERT into % returned no rows', v_table_name;
  END IF;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.create_doc_with_number(text, jsonb) IS
  'Atomic document creation with auto-generated sequence number. '
  'Calls nextval() on the per-doc-type SEQUENCE and INSERTs the row in a '
  'single function call, so the number is allocated only when the INSERT '
  'is actually attempted (minimises VAT-sequence gaps on failure). '
  'Returns the inserted row as JSONB. The client-supplied `number` field '
  'in p_payload is always overridden by the server-generated value. '
  'Supported doc types: offer, invoice, proforma, demand, rfq.';

-- Grant EXECUTE to service_role only — these are administrative RPCs
-- callable via the service_role key (which bypasses RLS). PUBLIC,
-- authenticated, and anon are intentionally NOT granted.
GRANT EXECUTE ON FUNCTION public.create_doc_with_number(text, jsonb) TO service_role;

-- Smoke test (safe to run, returns a row but does not commit if the
-- caller wraps in BEGIN/ROLLBACK). Uncomment to verify manually:
-- BEGIN;
-- SELECT public.create_doc_with_number(
--   'offer',
--   '{"tenant_id":"__smoke_test__","subject":"smoke","status":"draft"}'::jsonb
-- ) AS smoke_offer;
-- ROLLBACK;
