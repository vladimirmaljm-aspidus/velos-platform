-- 004_document_sequences.sql
-- ============================================================================
-- Atomic document numbering via Postgres SEQUENCE objects.
--
-- WHY SEQUENCES?
--   The previous implementation in src/app/api/{offers,invoices,proformas}/route.ts
--   and src/app/api/automation/*/route.ts auto-generated document numbers via
--   `store.listX({limit:1}).total + 1`. This is NOT atomic: two concurrent
--   POSTs would each read the same `total`, generate the same number, and one
--   of them would then fail with a unique-collision. The retry loop only
--   bumped the sequence by 1 — so under sustained concurrency numbers could
--   still collide and retries could starve.
--
--   A Postgres SEQUENCE is the canonical fix: `nextval()` is guaranteed
--   atomic at the database level, returning a distinct value to every caller
--   regardless of transaction visibility or concurrent load.
--
-- NUMBER FORMAT
--   All document numbers follow `<PREFIX>-<YEAR>-<NNNN>`:
--     offer   → OF-2025-0001
--     invoice → INV-2025-0001
--     proforma→ PRO-2025-0001
--   The year is read server-side at call time from CURRENT_DATE — so the
--   sequence is global (one counter per doc_type) but the formatted number
--   rolls over visually each January. Note: this means the numeric portion
--   does NOT reset at year-boundary; the year is purely a label. This is
--   acceptable for an SME platform (and matches the previous behavior).
--
-- SECURITY
--   The function is SECURITY DEFINER so it can execute nextval() on the
--   sequence objects regardless of the caller's grants. The caller is the
--   service_role key, which bypasses RLS — but explicit EXECUTE on the
--   function is still required, which the postgres role grants by default.
--
-- IDEMPOTENCY
--   CREATE SEQUENCE IF NOT EXISTS and CREATE OR REPLACE FUNCTION make this
--   migration safe to re-run.
-- ============================================================================

-- ─── Sequence objects (one per document type) ─────────────────────────────
CREATE SEQUENCE IF NOT EXISTS offer_number_seq    START 1;
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq  START 1;
CREATE SEQUENCE IF NOT EXISTS proforma_number_seq START 1;

-- Set starting values to current max + 1 so existing numbers don't collide.
-- Each UPDATE runs only once per install; the SELECT-MAX pattern is safe
-- here because the migration runs in a single transaction.
DO $$
DECLARE
  v_max BIGINT;
BEGIN
  SELECT COALESCE(MAX(
    -- Extract the trailing numeric portion after the last '-' (e.g. OF-2025-0042 → 42)
    NULLIF(
      SUBSTRING(number FROM '-(\\d+)$'),
      ''
    )::BIGINT
  ), 0) INTO v_max FROM offers;
  IF v_max > 0 THEN
    PERFORM setval('offer_number_seq', GREATEST(v_max, 1));
  END IF;

  SELECT COALESCE(MAX(
    NULLIF(SUBSTRING(number FROM '-(\\d+)$'), '')::BIGINT
  ), 0) INTO v_max FROM invoices;
  IF v_max > 0 THEN
    PERFORM setval('invoice_number_seq', GREATEST(v_max, 1));
  END IF;

  SELECT COALESCE(MAX(
    NULLIF(SUBSTRING(number FROM '-(\\d+)$'), '')::BIGINT
  ), 0) INTO v_max FROM proformas;
  IF v_max > 0 THEN
    PERFORM setval('proforma_number_seq', GREATEST(v_max, 1));
  END IF;
END $$;


-- ─── get_next_doc_number(doc_type TEXT) ───────────────────────────────────
--   Returns the next document number for the given doc_type in the canonical
--   `<PREFIX>-<YEAR>-<NNNN>` format. Uses nextval() which is atomic — two
--   concurrent calls will always get distinct sequence values.
--
--   Args:
--     doc_type: 'offer' | 'invoice' | 'proforma'
--   Returns:
--     e.g. 'OF-2025-0042' | 'INV-2025-0042' | 'PRO-2025-0042'
-- ============================================================================
CREATE OR REPLACE FUNCTION get_next_doc_number(doc_type TEXT)
RETURNS TEXT AS $$
DECLARE
  v_seq_name TEXT;
  v_prefix TEXT;
  v_next_val BIGINT;
  v_year INT;
BEGIN
  v_year := EXTRACT(YEAR FROM CURRENT_DATE)::INT;

  CASE doc_type
    WHEN 'offer'    THEN v_seq_name := 'offer_number_seq';    v_prefix := 'OF';
    WHEN 'invoice'  THEN v_seq_name := 'invoice_number_seq';  v_prefix := 'INV';
    WHEN 'proforma' THEN v_seq_name := 'proforma_number_seq'; v_prefix := 'PRO';
    ELSE RAISE EXCEPTION 'get_next_doc_number: unknown doc_type "%"', doc_type;
  END CASE;

  EXECUTE format('SELECT nextval(%L)', v_seq_name) INTO v_next_val;

  RETURN format('%s-%s-%s', v_prefix, v_year, lpad(v_next_val::text, 4, '0'));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ─── Verification queries (run manually in Supabase Studio) ───────────────
-- 1. List the new sequences. Expected: offer_number_seq, invoice_number_seq, proforma_number_seq
--    SELECT sequence_name, start_value, last_value
--    FROM information_schema.sequences
--    WHERE sequence_schema = 'public'
--      AND sequence_name IN ('offer_number_seq','invoice_number_seq','proforma_number_seq');

-- 2. Smoke-test the function (each call returns a fresh number):
--    SELECT get_next_doc_number('offer');
--    SELECT get_next_doc_number('invoice');
--    SELECT get_next_doc_number('proforma');

-- 3. Confirm the function exists and is SECURITY DEFINER:
--    SELECT routine_name, security_type
--    FROM information_schema.routines
--    WHERE routine_schema = 'public' AND routine_name = 'get_next_doc_number';
