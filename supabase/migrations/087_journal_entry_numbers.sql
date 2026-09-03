-- 087_journal_entry_numbers.sql
-- ============================================================================
-- BUG 31-e / E1 (P1) — ERP journal entries: manual creation is broken (500).
--
-- Background
-- ----------
-- `erp_journal_entries.entry_number` is NOT NULL in the live database (the
-- hand-written type in src/lib/supabase/types.ts models it as a required
-- `string`, matching the DB). The `upsert_journal_entry` RPC (migration 038)
-- inserts `p_entry->>'entry_number'` verbatim with no COALESCE fallback, and
-- neither the POST route (src/app/api/erp/journal-entries/route.ts) nor the
-- store (SupabaseStore.upsertErpJournalEntry) generates one — the default UI
-- form shape simply doesn't include an entry_number. Every manual journal
-- entry create therefore died inside the RPC with a 23502 not-null violation
-- surfaced as an opaque 500 "Missing required field.".
--
-- What this migration does
-- ------------------------
-- The per-tenant document numbering RPC `get_next_doc_number(p_doc_type,
-- p_tenant_id)` from migration 063_per_tenant_doc_sequences.sql already
-- provides an ATOMIC per-(tenant, doc_type, year) allocation table
-- (doc_number_allocations) — exactly what journal-entry numbering needs
-- (GL entry numbers must be gap-free per tenant per year for auditability,
-- same reasoning as the EU-VAT invoice sequence fix in 063).
--
-- The only missing piece: the deployed function's prefix CASE has no
-- 'journal' arm, so `get_next_doc_number('journal', …)` fell through to the
-- `ELSE upper(left(p_doc_type, 3))` branch and minted `JOU-…` numbers
-- instead of the documented `JE-…` format.
--
-- This migration CREATE OR REPLACEs the function with an identical body
-- (copied verbatim from 063 — same signature, same SECURITY DEFINER, same
-- search_path, same atomic INSERT … ON CONFLICT DO UPDATE … RETURNING
-- allocation, same 6-digit zero-padding, same GRANT) with exactly ONE added
-- line in the prefix CASE:
--
--     WHEN 'journal' THEN 'JE'
--
-- Idempotency / prerequisites
-- ---------------------------
-- • CREATE OR REPLACE is safe to run any number of times; it does not
--   allocate numbers and does not touch data.
-- • Requires migration 063 (doc_number_allocations table + the
--   (p_doc_type, p_tenant_id) signature) to be applied — in production it
--   already is. plpgsql does not resolve table references at CREATE time,
--   so re-running this file on an already-correct schema is a no-op.
-- • The app-side fallback in SupabaseStore (count+1 with a unique-
--   violation retry) covers the window before this migration is applied,
--   so journal-entry creation works in both states.
-- ============================================================================

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
  -- 087: 'journal' → 'JE' added (ERP journal entries; see header comment).
  v_prefix := CASE p_doc_type
    WHEN 'offer'    THEN 'OFF'
    WHEN 'invoice'  THEN 'INV'
    WHEN 'proforma' THEN 'PRO'
    WHEN 'demand'   THEN 'DEM'
    WHEN 'rfq'      THEN 'RFQ'
    WHEN 'logistics' THEN 'LOG'
    WHEN 'loi'      THEN 'LOI'
    WHEN 'journal'  THEN 'JE'
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
-- Verification (run in Supabase Studio after applying):
--
--   SELECT p.proname, pg_get_functiondef(p.oid)
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname = 'get_next_doc_number';
--   -- Expect the body to contain: WHEN 'journal' THEN 'JE'
--
--   (Do NOT call the RPC to test it — every call atomically increments
--   doc_number_allocations and burns a real number for the tenant.)
-- ============================================================================
