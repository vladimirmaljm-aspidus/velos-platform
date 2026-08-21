-- 002_add_rpc_functions.sql
-- ============================================================================
-- Transaction-safe Postgres RPC functions for multi-step operations.
-- Fixes TXN-1, TXN-2, TXN-4, TXN-5 from AGENT-FINDINGS-DB.md, and adds the
-- missing unique constraint from SCH-4.
--
-- WHY RPC?
--   The Supabase JS client does not support cross-table transactions.
--   Multi-step operations that were previously "delete-then-insert" or
--   "insert-header-then-insert-lines" in JavaScript are non-atomic: if step 2
--   fails, step 1 is committed and the data is left inconsistent (orphaned
--   journal-entry headers, half-paid commissions, duplicate journal entries).
--   Wrapping each multi-step operation in a single Postgres FUNCTION makes the
--   whole operation atomic — Postgres auto-rolls-back on any error.
--
-- SECURITY
--   All functions are SECURITY DEFINER — they execute with the privileges of
--   the function owner (typically the postgres role). This is required because
--   the app calls these via the service_role key, which bypasses RLS but still
--   needs explicit table privileges. SECURITY DEFINER ensures the function can
--   read/write all referenced tables regardless of the caller's grants.
--
-- IDEMPOTENCY
--   Each function uses CREATE OR REPLACE so re-running the migration is safe.
--   The auto_journal_from_invoice function additionally has an internal
--   idempotency check (returns existing journal entry if one already exists
--   for the invoice) to fix TXN-5's double-insert bug.
--
-- SCHEMA NOTES (verified against supabase-schema-full.sql production snapshot)
--   * erp_journal_lines.tenant_id  — column exists in production snapshot
--                                    (supabase-schema-full.sql:365) but NOT
--                                    in dev supabase-schema.sql. We include
--                                    it here to match production.
--   * erp_journal_entries.date     — timestamptz (not date).
--   * erp_journal_entries.debit_total / credit_total / exchange_rate
--                                   — double precision (not numeric). Casts
--                                     are tolerant.
--   * commission_payouts columns   — `payment_reference` (not `reference`),
--                                     `paid_at` (not `payout_date`), and
--                                     `partner_id` is NOT NULL.
--   * deal_commissions             — has `payout_reference` (not `payout_id`).
--   * invoices                     — has no `owner_id`; the function takes an
--                                     explicit `p_created_by` parameter.
-- ============================================================================


-- ============================================================================
-- TXN-1: upsert_journal_entry
--   Atomic replacement of (entry header + lines). Replaces the non-atomic
--   "DELETE old lines; INSERT new lines" pattern in supabase-store.ts:1567-1580.
--   If the line insert fails, the whole operation rolls back — no orphaned
--   headers, no broken trial balance.
-- ============================================================================
CREATE OR REPLACE FUNCTION upsert_journal_entry(
  p_entry jsonb,
  p_lines jsonb
) RETURNS jsonb AS $$
DECLARE
  v_id text;
  v_existing_id text;
  v_tenant_id text;
  v_result jsonb;
BEGIN
  v_id := p_entry->>'id';
  v_tenant_id := p_entry->>'tenant_id';

  IF v_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'upsert_journal_entry: p_entry must contain id and tenant_id';
  END IF;

  -- Does the entry already exist?
  SELECT id INTO v_existing_id FROM erp_journal_entries WHERE id = v_id;

  IF v_existing_id IS NOT NULL THEN
    -- UPDATE existing entry header (only overwrite fields that are present)
    UPDATE erp_journal_entries SET
      tenant_id        = COALESCE(p_entry->>'tenant_id', tenant_id),
      entry_number     = COALESCE(p_entry->>'entry_number', entry_number),
      date             = CASE WHEN p_entry ? 'date' THEN (p_entry->>'date')::timestamptz ELSE date END,
      description      = COALESCE(p_entry->>'description', description),
      reference_type   = COALESCE(p_entry->>'reference_type', reference_type),
      reference_id     = COALESCE(p_entry->>'reference_id', reference_id),
      fiscal_period_id = COALESCE(p_entry->>'fiscal_period_id', fiscal_period_id),
      status           = COALESCE(p_entry->>'status', status),
      source_type      = COALESCE(p_entry->>'source_type', source_type),
      debit_total      = CASE WHEN p_entry ? 'debit_total' THEN (p_entry->>'debit_total')::double precision ELSE debit_total END,
      credit_total     = CASE WHEN p_entry ? 'credit_total' THEN (p_entry->>'credit_total')::double precision ELSE credit_total END,
      currency         = COALESCE(p_entry->>'currency', currency),
      exchange_rate    = CASE WHEN p_entry ? 'exchange_rate' THEN (p_entry->>'exchange_rate')::double precision ELSE exchange_rate END,
      notes            = COALESCE(p_entry->>'notes', notes),
      posted_by        = COALESCE(p_entry->>'posted_by', posted_by),
      posted_at        = CASE WHEN p_entry->>'posted_at' IS NOT NULL THEN (p_entry->>'posted_at')::timestamptz ELSE posted_at END,
      updated_at       = now()
    WHERE id = v_id;

    -- Delete old lines (in same transaction — rolls back if insert fails)
    DELETE FROM erp_journal_lines WHERE journal_entry_id = v_id;
  ELSE
    -- INSERT new entry header
    INSERT INTO erp_journal_entries (
      id, tenant_id, entry_number, date, description, reference_type, reference_id,
      fiscal_period_id, status, source_type, debit_total, credit_total, currency,
      exchange_rate, notes, created_by, posted_by, posted_at
    ) VALUES (
      v_id,
      v_tenant_id,
      p_entry->>'entry_number',
      COALESCE((p_entry->>'date')::timestamptz, now()),
      COALESCE(p_entry->>'description', ''),
      p_entry->>'reference_type',
      p_entry->>'reference_id',
      p_entry->>'fiscal_period_id',
      COALESCE(p_entry->>'status', 'draft'),
      p_entry->>'source_type',
      COALESCE((p_entry->>'debit_total')::double precision, 0),
      COALESCE((p_entry->>'credit_total')::double precision, 0),
      COALESCE(p_entry->>'currency', 'EUR'),
      COALESCE((p_entry->>'exchange_rate')::double precision, 1),
      p_entry->>'notes',
      p_entry->>'created_by',
      p_entry->>'posted_by',
      CASE WHEN p_entry->>'posted_at' IS NOT NULL THEN (p_entry->>'posted_at')::timestamptz ELSE NULL END
    );
  END IF;

  -- Insert new lines (within the same transaction). erp_journal_lines has
  -- tenant_id in the production snapshot (NOT NULL).
  INSERT INTO erp_journal_lines (
    id, journal_entry_id, tenant_id, account_id, description,
    debit, credit, line_number
  )
  SELECT
    gen_random_uuid()::text,
    v_id,
    v_tenant_id,
    elem->>'account_id',
    elem->>'description',
    COALESCE((elem->>'debit')::double precision, 0),
    COALESCE((elem->>'credit')::double precision, 0),
    ROW_NUMBER() OVER ()
  FROM jsonb_array_elements(p_lines) AS elem;

  -- Return the entry with its lines as a JSON blob.
  SELECT jsonb_build_object(
    'entry', to_jsonb(e),
    'lines', COALESCE((
      SELECT jsonb_agg(to_jsonb(l) ORDER BY l.line_number)
      FROM erp_journal_lines l
      WHERE l.journal_entry_id = v_id
    ), '[]'::jsonb)
  ) INTO v_result
  FROM erp_journal_entries e
  WHERE e.id = v_id;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================================
-- TXN-2: reverse_journal_entry
--   Atomic 3-step reversal: insert reversal entry + insert reversed (swapped)
--   lines + mark original as reversed. Replaces the non-atomic 3-step pattern
--   in supabase-store.ts:1607-1662. If any step fails, the whole operation
--   rolls back — no half-reversed GL state.
-- ============================================================================
CREATE OR REPLACE FUNCTION reverse_journal_entry(
  p_original_id text,
  p_reversal_id text,
  p_reversal_entry jsonb,
  p_reversal_lines jsonb,
  p_reversal_reason text
) RETURNS jsonb AS $$
DECLARE
  v_tenant_id text;
  v_result jsonb;
BEGIN
  v_tenant_id := p_reversal_entry->>'tenant_id';
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'reverse_journal_entry: p_reversal_entry must contain tenant_id';
  END IF;

  -- Step 1: Insert reversal entry header
  INSERT INTO erp_journal_entries (
    id, tenant_id, entry_number, date, description, reference_type, reference_id,
    fiscal_period_id, status, source_type, debit_total, credit_total, currency,
    exchange_rate, notes, created_by
  ) VALUES (
    p_reversal_id,
    v_tenant_id,
    p_reversal_entry->>'entry_number',
    COALESCE((p_reversal_entry->>'date')::timestamptz, now()),
    COALESCE(p_reversal_entry->>'description', ''),
    'reversal',
    p_original_id,
    p_reversal_entry->>'fiscal_period_id',
    'posted',
    'reversal',
    COALESCE((p_reversal_entry->>'debit_total')::double precision, 0),
    COALESCE((p_reversal_entry->>'credit_total')::double precision, 0),
    COALESCE(p_reversal_entry->>'currency', 'EUR'),
    COALESCE((p_reversal_entry->>'exchange_rate')::double precision, 1),
    p_reversal_reason,
    p_reversal_entry->>'created_by'
  );

  -- Step 2: Insert reversed lines (debit/credit SWAPPED)
  INSERT INTO erp_journal_lines (
    id, journal_entry_id, tenant_id, account_id, description,
    debit, credit, line_number
  )
  SELECT
    gen_random_uuid()::text,
    p_reversal_id,
    v_tenant_id,
    elem->>'account_id',
    elem->>'description',
    COALESCE((elem->>'credit')::double precision, 0),  -- swapped
    COALESCE((elem->>'debit')::double precision, 0),   -- swapped
    ROW_NUMBER() OVER ()
  FROM jsonb_array_elements(p_reversal_lines) AS elem;

  -- Step 3: Mark original entry as reversed (in same transaction)
  UPDATE erp_journal_entries SET
    status    = 'reversed',
    notes     = COALESCE(notes || ' | ', '') || 'Reversed by ' || p_reversal_id || ': ' || COALESCE(p_reversal_reason, ''),
    updated_at = now()
  WHERE id = p_original_id;

  SELECT jsonb_build_object(
    'reversal_id', p_reversal_id,
    'original_id', p_original_id,
    'status', 'reversed'
  ) INTO v_result;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================================
-- TXN-4: create_commission_payout
--   Atomic payout creation + bulk mark commissions paid. Replaces the
--   non-atomic for-loop in src/app/api/commission-payouts/route.ts:55-60.
--
--   Tenant safety: the UPDATE filters by tenant_id (TI-2 fix) so a caller
--   cannot mark another tenant's commissions paid. The "status != 'paid'"
--   filter prevents double-payment on retry.
--
--   SCHEMA NOTE: commission_payouts in production has `partner_id` (NOT NULL),
--   `payment_reference` (not `reference`), `paid_at` (not `payout_date`).
--   deal_commissions has `payout_reference` (not `payout_id`); we store the
--   payout id there so the link is preserved.
-- ============================================================================
CREATE OR REPLACE FUNCTION create_commission_payout(
  p_payout jsonb,
  p_commission_ids text[]
) RETURNS jsonb AS $$
DECLARE
  v_payout_id text;
  v_tenant_id text;
  v_result jsonb;
  v_updated_count int;
  v_total_count int;
  v_partner_id text;
BEGIN
  v_payout_id := p_payout->>'id';
  v_tenant_id := p_payout->>'tenant_id';
  v_partner_id := p_payout->>'partner_id';

  IF v_payout_id IS NULL OR v_tenant_id IS NULL OR v_partner_id IS NULL THEN
    RAISE EXCEPTION 'create_commission_payout: p_payout must contain id, tenant_id, and partner_id';
  END IF;

  -- Step 1: Insert the payout record
  INSERT INTO commission_payouts (
    id, tenant_id, agent_id, partner_id, total_amount, currency,
    commission_ids, payment_method, payment_reference, paid_at,
    status, notes, created_by
  ) VALUES (
    v_payout_id,
    v_tenant_id,
    p_payout->>'agent_id',
    v_partner_id,
    COALESCE((p_payout->>'total_amount')::numeric, 0),
    COALESCE(p_payout->>'currency', 'USD'),
    p_commission_ids,
    p_payout->>'payment_method',
    p_payout->>'payment_reference',
    CASE WHEN COALESCE(p_payout->>'status', 'completed') = 'completed' THEN now() ELSE NULL END,
    COALESCE(p_payout->>'status', 'completed'),
    p_payout->>'notes',
    p_payout->>'created_by'
  );

  -- Step 2: Mark all listed commissions as paid (in the same transaction).
  -- Tenant-scoped + idempotent (skips already-paid).
  UPDATE deal_commissions SET
    status           = 'paid',
    paid_at          = now(),
    payout_reference = v_payout_id,
    updated_at       = now()
  WHERE id = ANY(p_commission_ids)
    AND tenant_id = v_tenant_id
    AND status <> 'paid';

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  v_total_count := COALESCE(array_length(p_commission_ids, 1), 0);

  SELECT jsonb_build_object(
    'payout_id',              v_payout_id,
    'commissions_marked_paid', v_updated_count,
    'commissions_already_paid', v_total_count - v_updated_count,
    'commissions_total',      v_total_count
  ) INTO v_result;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================================
-- TXN-5: auto_journal_from_invoice
--   Idempotent auto-journal creation for an invoice. Replaces the non-atomic
--   and non-idempotent pattern in supabase-store.ts:2027-2065.
--
--   IDEMPOTENCY: Before inserting, we look for an existing journal entry with
--   reference_type='invoice' AND reference_id=p_invoice_id for this tenant.
--   If one exists, we return its id with `already_existed: true` — no double
--   revenue recognition on retry.
--
--   SCHEMA NOTE: invoices has no `owner_id` column. The caller MUST pass an
--   explicit `p_created_by` (typically the user id from the auth context).
--
--   SIMPLIFIED GL: This function posts a 2-line entry (debit AR, credit
--   Revenue) using placeholder account ids 'accounts_receivable' and
--   'sales_revenue'. In production, these should be resolved from
--   erp_settings (the ERP's default account mapping) — this is a known
--   simplification, documented here so a future task can extend it.
-- ============================================================================
CREATE OR REPLACE FUNCTION auto_journal_from_invoice(
  p_invoice_id text,
  p_tenant_id text,
  p_entry_id text,
  p_entry_number text,
  p_created_by text
) RETURNS jsonb AS $$
DECLARE
  v_existing_id text;
  v_invoice jsonb;
  v_total numeric;
  v_currency text;
  v_issue_date date;
  v_invoice_number text;
  v_result jsonb;
BEGIN
  -- Idempotency check: return existing entry if one already exists for this invoice
  SELECT id INTO v_existing_id
  FROM erp_journal_entries
  WHERE reference_type = 'invoice'
    AND reference_id = p_invoice_id
    AND tenant_id = p_tenant_id
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    SELECT jsonb_build_object(
      'journal_entry_id', v_existing_id,
      'already_existed',  true
    ) INTO v_result;
    RETURN v_result;
  END IF;

  -- Fetch invoice
  SELECT to_jsonb(i) INTO v_invoice
  FROM invoices i
  WHERE i.id = p_invoice_id AND i.tenant_id = p_tenant_id;
  IF v_invoice IS NULL THEN
    RAISE EXCEPTION 'auto_journal_from_invoice: invoice % not found for tenant %', p_invoice_id, p_tenant_id;
  END IF;

  v_total          := COALESCE((v_invoice->>'total')::numeric, 0);
  v_currency       := COALESCE(v_invoice->>'currency', 'USD');
  v_invoice_number := v_invoice->>'number';
  v_issue_date     := CASE
    WHEN v_invoice ? 'issue_date' THEN (v_invoice->>'issue_date')::date
    ELSE current_date
  END;

  IF p_created_by IS NULL OR p_created_by = '' THEN
    RAISE EXCEPTION 'auto_journal_from_invoice: p_created_by is required (invoices table has no owner_id column)';
  END IF;

  -- Step 1: Insert journal entry header
  INSERT INTO erp_journal_entries (
    id, tenant_id, entry_number, date, description, reference_type, reference_id,
    status, source_type, debit_total, credit_total, currency, exchange_rate, created_by
  ) VALUES (
    p_entry_id,
    p_tenant_id,
    p_entry_number,
    v_issue_date::timestamptz,
    'Auto-journal for invoice ' || v_invoice_number,
    'invoice',
    p_invoice_id,
    'posted',
    'auto',
    v_total::double precision,
    v_total::double precision,
    v_currency,
    1,
    p_created_by
  );

  -- Step 2: Insert two lines (debit AR, credit Revenue).
  -- Placeholder account ids — see SCHEMA NOTE above.
  INSERT INTO erp_journal_lines (id, journal_entry_id, tenant_id, account_id, description, debit, credit, line_number)
  VALUES
    (gen_random_uuid()::text, p_entry_id, p_tenant_id, 'accounts_receivable', 'Accounts Receivable', v_total::double precision, 0, 1),
    (gen_random_uuid()::text, p_entry_id, p_tenant_id, 'sales_revenue',       'Sales Revenue',        0, v_total::double precision, 2);

  SELECT jsonb_build_object(
    'journal_entry_id', p_entry_id,
    'already_existed',  false
  ) INTO v_result;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================================
-- SCH-4: Add missing UNIQUE constraint on erp_journal_entries (tenant_id, entry_number)
--   The dev supabase-schema.sql:950 declares this UNIQUE inline, but the
--   production snapshot (supabase-schema-full.sql) is missing it. Without it,
--   the store's `upsert(payload, { onConflict: "tenant_id,entry_number" })`
--   silently inserts duplicates on retry, corrupting the trial balance.
--   Idempotent: skipped if the constraint already exists (by any name).
-- ============================================================================
DO $$
DECLARE
  v_constraint_exists boolean;
BEGIN
  -- Check if ANY unique constraint exists on (tenant_id, entry_number)
  -- (the dev schema creates it with the auto-generated name
  -- `erp_journal_entries_tenant_id_entry_number_key`).
  SELECT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'erp_journal_entries'
      AND c.contype = 'u'
      AND array_to_string(c.conkey, ',') = (
        SELECT array_to_string(array_agg(attnum), ',')
        FROM (
          SELECT attnum
          FROM pg_attribute
          WHERE attrelid = t.oid
            AND attname IN ('tenant_id', 'entry_number')
          ORDER BY attname
        ) s
      )
  ) INTO v_constraint_exists;

  IF NOT v_constraint_exists THEN
    ALTER TABLE erp_journal_entries
      ADD CONSTRAINT erp_journal_entries_tenant_entry_number_key
      UNIQUE (tenant_id, entry_number);
    RAISE NOTICE 'Added UNIQUE (tenant_id, entry_number) constraint to erp_journal_entries';
  ELSE
    RAISE NOTICE 'UNIQUE (tenant_id, entry_number) constraint already exists on erp_journal_entries — skipping';
  END IF;
END $$;


-- ============================================================================
-- VERIFICATION QUERIES (run manually in Supabase Studio → SQL Editor)
-- ============================================================================

-- 1. List the new RPC functions. Expected:
--      upsert_journal_entry
--      reverse_journal_entry
--      create_commission_payout
--      auto_journal_from_invoice
-- SELECT routine_name, routine_type, security_type
-- FROM information_schema.routines
-- WHERE routine_schema = 'public'
--   AND routine_name IN (
--     'upsert_journal_entry',
--     'reverse_journal_entry',
--     'create_commission_payout',
--     'auto_journal_from_invoice'
--   )
-- ORDER BY routine_name;

-- 2. Confirm the SCH-4 unique constraint exists.
-- SELECT conname, contype, pg_get_constraintdef(oid) AS def
-- FROM pg_constraint
-- WHERE conrelid = 'public.erp_journal_entries'::regclass
--   AND contype = 'u';

-- 3. Smoke-test upsert_journal_entry (manual — provide real ids):
-- SELECT upsert_journal_entry(
--   '{"id":"test-je-1","tenant_id":"<uuid>","entry_number":"JE-TEST-1","date":"2025-01-01","description":"test","created_by":"<user-id>","debit_total":100,"credit_total":100,"currency":"USD"}'::jsonb,
--   '[{"account_id":"accounts_receivable","description":"AR","debit":100,"credit":0},{"account_id":"sales_revenue","description":"REV","debit":0,"credit":100}]'::jsonb
-- );
-- -- Then cleanup:
-- -- DELETE FROM erp_journal_lines WHERE journal_entry_id = 'test-je-1';
-- -- DELETE FROM erp_journal_entries WHERE id = 'test-je-1';
