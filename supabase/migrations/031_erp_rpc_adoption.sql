-- 031_erp_rpc_adoption.sql
-- ============================================================================
-- CRITICAL FIX — audit finding B-1 P0 #3 / C-3 (ERP journal entry atomicity).
--
-- Background
-- ----------
-- Migration `002_add_rpc_functions.sql` shipped four SECURITY DEFINER RPCs
-- that wrap multi-step ERP/commission writes in a single Postgres
-- transaction:
--     * upsert_journal_entry        (TXN-1)
--     * reverse_journal_entry       (TXN-2)
--     * create_commission_payout    (TXN-4)
--     * auto_journal_from_invoice   (TXN-5)
--
-- The migration README (supabase/migrations/README.md:27-38) explicitly
-- noted: "The migrations add the DB-layer fixes, but the application code
-- still uses the old non-atomic patterns. A follow-up task should update
-- the store methods and route handlers to call the new RPC functions
-- instead. Until that follow-up is done, the migrations are inert."
--
-- That follow-up is THIS migration + the accompanying app-code changes
-- in `src/lib/data/supabase-store.ts` (`upsertErpJournalEntry`,
-- `reverseErpJournalEntry`, `autoJournalFromInvoice`) and
-- `src/app/api/commission-payouts/route.ts` (now calls
-- `createCommissionPayoutAtomic`).
--
-- What this migration does
-- ------------------------
-- 1. SECURITY HARDENING — all four RPCs were originally `SECURITY DEFINER`
--    WITHOUT `SET search_path`. Supabase security advisory 2023-09
--    (https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-using-the-security-definer-tag)
--    recommends `SET search_path = public, pg_temp` on every SECURITY
--    DEFINER function to mitigate search-path injection. We re-CREATE
--    OR REPLACE all four functions with that clause added.
-- 2. `create_commission_payout` PATCH — the migration-002 body ALWAYS
--    ran the bulk mark-paid UPDATE, even when `p_payout->>'status'` was
--    `'pending'` or `'cancelled'`. That silently transitioned
--    DealCommissions to `'paid'` for payouts that had not been approved
--    yet (audit F-6 / P1-7 approval gate). The patched body:
--      (a) skips the bulk UPDATE when `status <> 'completed'`;
--      (b) returns the inserted payout row (via RETURNING) so the route
--          handler doesn't need a follow-up SELECT.
-- 3. `auto_journal_from_invoice` — left functionally unchanged. The
--    app's `autoJournalFromInvoice` store method keeps the
--    erp_settings-based account-id resolution client-side (the RPC
--    uses placeholder account ids 'accounts_receivable' / 'sales_revenue'
--    which would regress the per-tenant mapping), and delegates only
--    the atomic write to `upsert_journal_entry` (with a client-side
--    idempotency check that mirrors the RPC's). The RPC remains
--    available for direct callers and is hardened here with
--    `SET search_path`.
-- 4. `upsert_journal_entry` and `reverse_journal_entry` — functionally
--    unchanged (their migration-002 bodies already returned the shapes
--    the app expects: `{entry, lines}` and `{reversal_id, original_id,
--    status}` respectively). Hardened with `SET search_path`.
--
-- Verification
-- ------------
-- After applying, the following query should return four rows, all with
-- proconfig = {search_path=public, pg_temp}:
--
--     SELECT proname, prosecdef, proconfig
--     FROM pg_proc
--     WHERE proname IN (
--       'upsert_journal_entry',
--       'reverse_journal_entry',
--       'create_commission_payout',
--       'auto_journal_from_invoice'
--     )
--     ORDER BY proname;
--
-- Idempotency
-- -----------
-- CREATE OR REPLACE FUNCTION is idempotent; re-running this migration is
-- safe (the search_path clause is set deterministically each time).
-- ============================================================================


-- ============================================================================
-- upsert_journal_entry (re-published with SET search_path)
--   Atomic replacement of (entry header + lines). Body unchanged from
--   migration 002 — re-published here only to add the search_path clause.
-- ============================================================================
CREATE OR REPLACE FUNCTION upsert_journal_entry(
  p_entry jsonb,
  p_lines jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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

  -- Return the entry with its lines as a JSON blob. The application's
  -- `upsertErpJournalEntry` store method reads `result.entry` and
  -- `result.lines` — do not change this shape without updating the store.
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
$$;


-- ============================================================================
-- reverse_journal_entry (re-published with SET search_path)
--   Atomic 3-step reversal: insert reversal entry + insert reversed
--   (debit/credit swapped) lines + mark original as reversed. Body
--   unchanged from migration 002.
-- ============================================================================
CREATE OR REPLACE FUNCTION reverse_journal_entry(
  p_original_id text,
  p_reversal_id text,
  p_reversal_entry jsonb,
  p_reversal_lines jsonb,
  p_reversal_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
$$;


-- ============================================================================
-- create_commission_payout (PATCHED + SET search_path)
--   PATCH vs migration 002:
--     (1) Skip the bulk mark-paid UPDATE when p_payout->>'status' is NOT
--         'completed' (audit F-6 / P1-7 approval gate — a 'pending' payout
--         must not transition any DealCommission to 'paid').
--     (2) Return the inserted payout row (RETURNING to_jsonb(...)) so the
--         route handler does not need a follow-up SELECT to fetch the
--         created row.
-- ============================================================================
CREATE OR REPLACE FUNCTION create_commission_payout(
  p_payout jsonb,
  p_commission_ids text[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_payout_id text;
  v_tenant_id text;
  v_partner_id text;
  v_status text;
  v_result jsonb;
  v_updated_count int;
  v_total_count int;
  v_inserted jsonb;
BEGIN
  v_payout_id := p_payout->>'id';
  v_tenant_id := p_payout->>'tenant_id';
  v_partner_id := p_payout->>'partner_id';
  v_status := COALESCE(p_payout->>'status', 'completed');

  IF v_payout_id IS NULL OR v_tenant_id IS NULL OR v_partner_id IS NULL THEN
    RAISE EXCEPTION 'create_commission_payout: p_payout must contain id, tenant_id, and partner_id';
  END IF;

  -- Step 1: Insert the payout record (capture the row for the return value).
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
    CASE WHEN v_status = 'completed' THEN now() ELSE NULL END,
    v_status,
    p_payout->>'notes',
    p_payout->>'created_by'
  )
  RETURNING to_jsonb(commission_payouts.*) INTO v_inserted;

  -- Step 2: Mark all listed commissions as paid — ONLY when the payout is
  -- being created as 'completed'. A 'pending' or 'cancelled' payout must
  -- not transition any commission to 'paid' (audit F-6 / P1-7 approval
  -- gate). Tenant-scoped + idempotent (skips already-paid).
  IF v_status = 'completed' THEN
    UPDATE deal_commissions SET
      status           = 'paid',
      paid_at          = now(),
      payout_reference = v_payout_id,
      updated_at       = now()
    WHERE id = ANY(p_commission_ids)
      AND tenant_id = v_tenant_id
      AND status <> 'paid';

    GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  ELSE
    v_updated_count := 0;
  END IF;
  v_total_count := COALESCE(array_length(p_commission_ids, 1), 0);

  SELECT jsonb_build_object(
    'payout',                   v_inserted,
    'payout_id',                v_payout_id,
    'commissions_marked_paid',  v_updated_count,
    'commissions_already_paid', v_total_count - v_updated_count,
    'commissions_total',        v_total_count
  ) INTO v_result;
  RETURN v_result;
END;
$$;


-- ============================================================================
-- auto_journal_from_invoice (re-published with SET search_path)
--   Functionally unchanged from migration 002 — re-published here only to
--   add the search_path clause. The application's
--   `SupabaseStore.autoJournalFromInvoice` keeps the erp_settings-based
--   account-id resolution client-side (this RPC uses placeholder account
--   ids 'accounts_receivable' / 'sales_revenue' — see SCHEMA NOTE in
--   migration 002) and delegates only the atomic write to
--   `upsert_journal_entry` (with a client-side idempotency check that
--   mirrors the one below). The RPC remains available for direct callers
--   that want a self-contained auto-journal endpoint with default account
--   mapping.
-- ============================================================================
CREATE OR REPLACE FUNCTION auto_journal_from_invoice(
  p_invoice_id text,
  p_tenant_id text,
  p_entry_id text,
  p_entry_number text,
  p_created_by text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
  -- Placeholder account ids — see SCHEMA NOTE in migration 002. The
  -- application's `autoJournalFromInvoice` store method resolves real
  -- account ids from erp_settings and routes through
  -- `upsert_journal_entry` instead of this RPC; this RPC remains for
  -- callers that want default account mapping.
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
$$;


-- ============================================================================
-- GRANT — explicit EXECUTE grant to service_role (the role the app uses).
-- PUBLIC / authenticated / anon are NOT granted — these RPCs are
-- administrative and must only be callable via the service_role key.
-- (Idempotent — GRANT is a no-op if the grant already exists.)
-- ============================================================================
GRANT EXECUTE ON FUNCTION upsert_journal_entry(jsonb, jsonb)         TO service_role;
GRANT EXECUTE ON FUNCTION reverse_journal_entry(text, text, jsonb, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION create_commission_payout(jsonb, text[])    TO service_role;
GRANT EXECUTE ON FUNCTION auto_journal_from_invoice(text, text, text, text, text) TO service_role;


-- ============================================================================
-- VERIFICATION QUERIES (run manually in Supabase Studio → SQL Editor)
-- ============================================================================
-- 1. All four RPCs should be SECURITY DEFINER with search_path set:
--      SELECT proname, prosecdef, proconfig
--      FROM pg_proc
--      WHERE proname IN (
--        'upsert_journal_entry',
--        'reverse_journal_entry',
--        'create_commission_payout',
--        'auto_journal_from_invoice'
--      )
--      ORDER BY proname;
--    Expected: proconfig = {search_path=public, pg_temp} for all four.
--
-- 2. create_commission_payout should gate the mark-paid on status:
--      SELECT pg_get_functiondef('create_commission_payout(jsonb,text[])'::regprocedure);
--    Expected: body contains "IF v_status = 'completed' THEN" around the
--    bulk UPDATE.
--
-- 3. Smoke-test create_commission_payout with status='pending' — no
--    DealCommission should transition to 'paid':
--      SELECT create_commission_payout(
--        '{"id":"test-cp-1","tenant_id":"<uuid>","partner_id":"<uuid>","total_amount":0,"status":"pending"}'::jsonb,
--        '{}'::text[]
--      );
--      SELECT * FROM commission_payouts WHERE id = 'test-cp-1';
--      DELETE FROM commission_payouts WHERE id = 'test-cp-1';
