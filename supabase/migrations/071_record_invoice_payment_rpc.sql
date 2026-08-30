-- 071_record_invoice_payment_rpc.sql
-- ============================================================================
-- CRITICAL FIX — audit 2d2-F2 + 2d2-F4 + 2d2-F19 + 2d2-F20 (round 2)
--
-- PROBLEM
--   The route `src/app/api/invoices/[id]/record-payment/route.ts` performs
--   5+ DB writes as SEPARATE non-atomic PostgREST calls:
--     1. INSERT erp_bank_transactions   (line 156)
--     2. UPDATE invoices SET status     (line 303 — via atomic_update_invoice_payment_status RPC)
--     3. UPDATE deal_commissions        (line 362 — markCommissionsEarnedOnInvoicePaid, ONE-ROW-AT-A-TIME LOOP — 2d2-F20)
--     4. UPDATE proformas SET status    (line 454 — proforma cascade)
--     5. INSERT erp_journal_entries      (line 688 — header) + INSERT erp_journal_lines (line 761 — 2d2-F2)
--   Each write is in its own try/catch. If step 1 succeeds but step 2 fails,
--   the bank has a credit row but the invoice still says "sent" → phantom
--   credit (2d2-F4). If step 5a succeeds but step 5b fails, the JE header
--   is committed with ZERO lines → GL corruption (2d2-F2). The
--   markCommissionsEarnedOnInvoicePaid loop updates commissions ONE-BY-ONE —
--   if the Nth update fails, commissions 1..N-1 are "approved" but the
--   rest are still "pending" (2d2-F20).
--
--   ADDITIONALLY, the auto-journal at line 702 hardcodes
--   `exchange_rate: 1` — wrong when the bank_account currency ≠ invoice
--   currency. Bank balance reconciliation fails; revenue is mis-stated in
--   the base currency (2d2-F19).
--
-- FIX
--   Single SECURITY DEFINER plpgsql function `record_invoice_payment`
--   that performs ALL FIVE writes inside ONE Postgres transaction:
--     * SELECT invoice FOR UPDATE  (serializes concurrent record-payment
--       calls on the same invoice)
--     * INSERT bank_transaction
--     * Sum cumulative paid bank_transactions for this invoice
--     * UPDATE invoice (status + paid_at)
--     * Bulk UPDATE deal_commissions status='approved' (atomic, no loop — 2d2-F20)
--     * UPDATE proforma (conditional, idempotent)
--     * INSERT JE header + JE lines (atomic — 2d2-F2)
--     * Accepts p_exchange_rate numeric param (F19) — caller computes the
--       rate from bank_account.currency vs invoice.currency
--   Postgres auto-rollbacks on any error.
--
-- SECURITY
--   SECURITY DEFINER + SET search_path = public, pg_temp (Supabase
--   advisory 2023-09, matches migration 069 pattern). GRANT EXECUTE to
--   service_role ONLY — REVOKE from PUBLIC/anon/authenticated.
--
-- IDEMPOTENCY (preserved from the existing route)
--   * Cumulative paid sum includes the bank_txn we just inserted
--   * Commission cascade only runs when newStatus = 'paid' (full payment)
--   * Proforma cascade skips if proforma is already 'paid' (conditional UPDATE)
--   * JE idempotency: bail if a posted JE already exists for this invoice
--     (reference_type='invoice' + reference_id + tenant_id)
--
-- PRESERVED BEHAVIOR (graceful skip, not exception)
--   * If the tenant has no erp_settings row → JE skipped (journal_skipped:true)
--   * If cash/revenue account_id is unset OR invalid → JE skipped
--   * If no bank_account on file → bank_transaction_id is null (payment
--     still recorded against the invoice)
--   * Proforma cascade resolves proforma_id via invoice.proforma_id OR
--     the latest non-paid proforma linked to invoice.offer_id
--   * Overpayment (cumulative > invoice.total): split credit into Revenue
--     + Customer Prepayments (liability) IF a prepayment account exists;
--     otherwise book the full amount as Revenue (backward compatible)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.record_invoice_payment(
  p_invoice_id      text,
  p_tenant_id       text,
  p_amount          numeric,
  p_currency        text,
  p_bank_account_id text,
  p_reference       text,
  p_paid_at         timestamptz,
  p_created_by      text,
  p_payment_method  text DEFAULT 'bank_transfer',
  p_exchange_rate   numeric DEFAULT 1.0
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invoice           RECORD;
  v_bank_account      RECORD;
  v_bank_txn_id       text;
  v_total_paid        numeric;
  v_invoice_total     numeric;
  v_new_status        text;
  v_is_full_payment   boolean;
  v_deal_id           text;
  v_proforma_id       text;
  v_proforma_updated  boolean := false;
  v_proforma_rc       int;
  v_commissions_updated int := 0;
  v_existing_je_id    text;
  v_je_id             text := NULL;
  v_je_skipped        boolean := false;
  v_je_error          text := NULL;
  v_settings          RECORD;
  v_cash_account_id   text;
  v_revenue_account_id text;
  v_prepayment_account_id text;
  v_cash_valid        boolean := false;
  v_revenue_valid     boolean := false;
  v_je_amount         numeric;
  v_excess            numeric := 0;
  v_revenue_amount    numeric;
  v_je_number         text;
  v_should_post       boolean;
  v_je_currency       text;
  v_rate               numeric;
  v_result            jsonb;
BEGIN
  IF p_invoice_id IS NULL OR p_tenant_id IS NULL OR p_amount IS NULL OR p_created_by IS NULL THEN
    RAISE EXCEPTION 'record_invoice_payment: p_invoice_id, p_tenant_id, p_amount, p_created_by are all required';
  END IF;
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'record_invoice_payment: p_amount must be > 0';
  END IF;

  -- ── 1) SELECT invoice FOR UPDATE ─────────────────────────────────────
  -- Serializes concurrent record-payment calls on the same invoice.
  SELECT id, number, currency, total, status, partner_id, offer_id, issue_date, subject
    INTO v_invoice
    FROM invoices
    WHERE id = p_invoice_id
      AND tenant_id = p_tenant_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_invoice_payment: invoice % not found for tenant %', p_invoice_id, p_tenant_id;
  END IF;

  IF v_invoice.status = 'paid' OR v_invoice.status = 'cancelled' THEN
    RAISE EXCEPTION 'record_invoice_payment: invoice is already % — no further payments can be recorded', v_invoice.status;
  END IF;

  v_invoice_total := COALESCE(v_invoice.total, 0);

  -- ── 2) Validate bank_account_id belongs to the caller's tenant ──────
  IF p_bank_account_id IS NOT NULL THEN
    SELECT id, currency, account_id
      INTO v_bank_account
      FROM erp_bank_accounts
      WHERE id = p_bank_account_id
        AND tenant_id = p_tenant_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'record_invoice_payment: bank_account % not found in tenant %', p_bank_account_id, p_tenant_id;
    END IF;
  END IF;

  -- ── 3) INSERT erp_bank_transactions (credit row) ───────────────────
  -- Mirrors the existing route payload (line 156-170). When bank_account_id
  -- is NULL, no bank_txn is recorded (matches existing route behavior).
  IF p_bank_account_id IS NOT NULL THEN
    INSERT INTO erp_bank_transactions (
      tenant_id, bank_account_id, date, amount, transaction_type,
      description, reference, counterparty, is_reconciled,
      reconciled_with, invoice_number, category, is_auto_generated
    ) VALUES (
      p_tenant_id, p_bank_account_id, COALESCE(p_paid_at, now()),
      p_amount, 'credit',
      'Payment for invoice ' || v_invoice.number, p_reference,
      v_invoice.partner_id, false,
      p_invoice_id, v_invoice.number, 'invoice_payment', true
    )
    RETURNING id INTO v_bank_txn_id;
  END IF;

  -- ── 4) Sum cumulative paid (sum of credit bank_txns for this invoice) ──
  SELECT COALESCE(SUM(amount), 0) INTO v_total_paid
  FROM erp_bank_transactions
  WHERE tenant_id = p_tenant_id
    AND invoice_number = v_invoice.number
    AND transaction_type = 'credit'
    AND category = 'invoice_payment';

  -- 5) Compute new status (1 cent tolerance for float drift).
  IF v_total_paid >= v_invoice_total - 0.01 THEN
    v_new_status := 'paid';
    v_is_full_payment := true;
  ELSE
    v_new_status := 'partial';
    v_is_full_payment := false;
  END IF;

  -- ── 6) UPDATE invoice (status + paid_at) ────────────────────────────
  UPDATE invoices SET
    status = v_new_status,
    paid_at = CASE WHEN v_is_full_payment THEN COALESCE(p_paid_at, now()) ELSE paid_at END,
    updated_at = now()
  WHERE id = p_invoice_id AND tenant_id = p_tenant_id;

  -- ── 7) Commission cascade (only on full payment) ── 2d2-F20 fix ────
  -- Bulk UPDATE: status='pending' → 'approved' for all commissions on the
  -- invoice's originating deal. Single statement = atomic. Previously this
  -- was a JS loop that left some commissions "approved" and some "pending"
  -- if a mid-loop call failed.
  IF v_is_full_payment AND v_invoice.offer_id IS NOT NULL THEN
    SELECT deal_id INTO v_deal_id FROM offers
      WHERE id = v_invoice.offer_id AND tenant_id = p_tenant_id;
    IF v_deal_id IS NOT NULL THEN
      UPDATE deal_commissions SET
        status = 'approved',
        approved_at = now(),
        notes = 'Auto-approved: linked invoice paid at ' || to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        updated_at = now()
      WHERE tenant_id = p_tenant_id
        AND deal_id = v_deal_id
        AND status = 'pending';
      GET DIAGNOSTICS v_commissions_updated = ROW_COUNT;
    END IF;
  END IF;

  -- ── 8) Proforma cascade (only on full payment) ──────────────────────
  -- Resolve proforma_id: invoice.proforma_id (forward-compat) OR latest
  -- non-paid proforma linked to invoice.offer_id. Conditional UPDATE
  -- (WHERE status <> 'paid') makes the cascade idempotent.
  IF v_is_full_payment THEN
    -- Forward-compat: invoice.proforma_id (column may not exist on every
    -- deployment; wrapped in a BEGIN/EXCEPTION to fall through gracefully).
    BEGIN
      v_proforma_id := NULL;
      EXECUTE format('SELECT proforma_id FROM invoices WHERE id = $1 AND tenant_id = $2')
        INTO v_proforma_id
        USING p_invoice_id, p_tenant_id;
    EXCEPTION WHEN OTHERS THEN
      v_proforma_id := NULL;
    END;

    IF v_proforma_id IS NULL AND v_invoice.offer_id IS NOT NULL THEN
      SELECT id INTO v_proforma_id FROM proformas
        WHERE offer_id = v_invoice.offer_id
          AND tenant_id = p_tenant_id
          AND status NOT IN ('paid', 'expired')
        ORDER BY created_at DESC
        LIMIT 1;
    END IF;

    IF v_proforma_id IS NOT NULL THEN
      UPDATE proformas SET
        status = 'paid',
        paid_at = COALESCE(p_paid_at, now()),
        updated_at = now()
      WHERE id = v_proforma_id
        AND tenant_id = p_tenant_id
        AND status <> 'paid';
      GET DIAGNOSTICS v_proforma_rc = ROW_COUNT;
      v_proforma_updated := (v_proforma_rc > 0);
      -- If ROW_COUNT=0, a concurrent call already paid it — idempotent skip.
    END IF;
  END IF;

  -- ── 9) Auto-journal cascade (only when invoice flips to 'paid') ─────
  -- 2d2-F2 fix: INSERT JE header + JE lines atomically (single tx).
  -- 2d2-F19 fix: accept p_exchange_rate param, store on the JE row.
  IF v_new_status = 'paid' THEN
    -- Idempotency: bail if a posted JE already exists for this invoice.
    SELECT id INTO v_existing_je_id FROM erp_journal_entries
      WHERE reference_type = 'invoice'
        AND reference_id = p_invoice_id
        AND tenant_id = p_tenant_id
        AND status = 'posted'
      LIMIT 1;
    IF v_existing_je_id IS NOT NULL THEN
      v_je_id := v_existing_je_id;
      v_je_skipped := true;
    ELSE
      -- Resolve erp_settings (cash + revenue account ids, auto_post_journal).
      SELECT
        cash_account_id, revenue_account_id, auto_post_journal, default_currency
        INTO v_settings
      FROM erp_settings
      WHERE tenant_id = p_tenant_id
      LIMIT 1;

      v_cash_account_id := v_settings.cash_account_id;
      IF v_cash_account_id IS NULL AND p_bank_account_id IS NOT NULL THEN
        -- Fall back to the erp_bank_accounts.account_id (still tenant-scoped).
        v_cash_account_id := v_bank_account.account_id;
      END IF;
      v_revenue_account_id := v_settings.revenue_account_id;

      -- Validate the resolved account_ids exist in erp_accounts (tenant-scoped).
      IF v_cash_account_id IS NOT NULL THEN
        PERFORM 1 FROM erp_accounts WHERE id = v_cash_account_id AND tenant_id = p_tenant_id;
        v_cash_valid := FOUND;
      END IF;
      IF v_revenue_account_id IS NOT NULL THEN
        PERFORM 1 FROM erp_accounts WHERE id = v_revenue_account_id AND tenant_id = p_tenant_id;
        v_revenue_valid := FOUND;
      END IF;

      IF v_cash_account_id IS NOT NULL AND v_revenue_account_id IS NOT NULL
         AND v_cash_valid AND v_revenue_valid THEN
        -- JE amount: full cumulative on 'paid', else just this payment.
        v_je_amount := v_total_paid;
        -- Overpayment split (preserved from existing route).
        IF v_total_paid > v_invoice_total THEN
          v_excess := v_total_paid - v_invoice_total;
          v_revenue_amount := v_je_amount - v_excess;
          -- Auto-discover a Customer Prepayments liability account.
          SELECT id INTO v_prepayment_account_id FROM erp_accounts
            WHERE tenant_id = p_tenant_id
              AND type = 'liability'
              AND (name ILIKE '%prepay%' OR name ILIKE '%unearned%'
                   OR name ILIKE '%advance%' OR code ILIKE '%2100%' OR code ILIKE '%2200%')
            LIMIT 1;
          IF v_prepayment_account_id IS NULL THEN
            -- No prepayment account found — book full amount as Revenue
            -- (backward compatible with existing behavior).
            v_revenue_amount := v_je_amount;
          END IF;
        ELSE
          v_revenue_amount := v_je_amount;
        END IF;

        v_je_currency := COALESCE(p_currency, v_invoice.currency, v_settings.default_currency, 'USD');
        v_rate := COALESCE(p_exchange_rate, 1.0);
        v_should_post := COALESCE(v_settings.auto_post_journal, false);
        -- Generate a unique entry_number (caller pattern: PMT-<invoice>-<uuid8>)
        v_je_number := 'PMT-' || v_invoice.number || '-' || substring(gen_random_uuid()::text, 1, 8);

        -- INSERT JE header (atomic with lines below — same tx).
        INSERT INTO erp_journal_entries (
          id, tenant_id, entry_number, date, description, reference_type, reference_id,
          status, source_type, debit_total, credit_total, currency, exchange_rate,
          created_by, posted_by, posted_at
        ) VALUES (
          gen_random_uuid()::text, p_tenant_id, v_je_number,
          COALESCE(p_paid_at, now()),
          'Auto-journal for invoice ' || v_invoice.number || ' payment',
          'invoice', p_invoice_id,
          CASE WHEN v_should_post THEN 'posted' ELSE 'draft' END, 'auto',
          v_je_amount, v_je_amount, v_je_currency, v_rate,
          p_created_by,
          CASE WHEN v_should_post THEN p_created_by ELSE NULL END,
          CASE WHEN v_should_post THEN COALESCE(p_paid_at, now()) ELSE NULL END
        )
        RETURNING id INTO v_je_id;

        -- INSERT JE lines (atomic with header above — same tx). 2d2-F2 fix.
        INSERT INTO erp_journal_lines (
          id, journal_entry_id, tenant_id, account_id, description,
          debit, credit, line_number, currency, partner_id
        ) VALUES
          (gen_random_uuid()::text, v_je_id, p_tenant_id, v_cash_account_id,
           'Payment received - ' || v_invoice.number,
           v_je_amount, 0, 1, v_je_currency, v_invoice.partner_id),
          (gen_random_uuid()::text, v_je_id, p_tenant_id, v_revenue_account_id,
           'Revenue - ' || v_invoice.number,
           0, v_revenue_amount, 2, v_je_currency, v_invoice.partner_id);

        -- Optional prepayment line (only on overpayment + account found).
        IF v_excess > 0 AND v_prepayment_account_id IS NOT NULL THEN
          INSERT INTO erp_journal_lines (
            id, journal_entry_id, tenant_id, account_id, description,
            debit, credit, line_number, currency, partner_id
          ) VALUES
            (gen_random_uuid()::text, v_je_id, p_tenant_id, v_prepayment_account_id,
             'Customer prepayment (overpayment) - ' || v_invoice.number,
             0, v_excess, 3, v_je_currency, v_invoice.partner_id);
        END IF;
      ELSE
        -- Settings row missing or referenced accounts no longer exist —
        -- skip cleanly so the payment workflow isn't blocked on finance
        -- configuration (preserves existing route behavior).
        v_je_skipped := true;
      END IF;
    END IF;
  ELSE
    -- Partial payment — no auto-journal (matches existing route).
    v_je_skipped := true;
  END IF;

  v_result := jsonb_build_object(
    'bank_transaction_id', v_bank_txn_id,
    'invoice_status', v_new_status,
    'is_full_payment', v_is_full_payment,
    'cumulative_paid', v_total_paid,
    'invoice_total', v_invoice_total,
    'commissions_marked_approved', v_commissions_updated,
    'commission_deal_id', v_deal_id,
    'proforma_id', v_proforma_id,
    'proforma_updated', v_proforma_updated,
    'journal_entry_id', v_je_id,
    'journal_skipped', v_je_skipped,
    'journal_error', v_je_error
  );
  RETURN v_result;
END;
$$;

-- SECURITY: GRANT to service_role only.
REVOKE EXECUTE ON FUNCTION public.record_invoice_payment(text, text, numeric, text, text, text, timestamptz, text, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.record_invoice_payment(text, text, numeric, text, text, text, timestamptz, text, text, numeric) TO service_role;

COMMENT ON FUNCTION public.record_invoice_payment(text, text, numeric, text, text, text, timestamptz, text, text, numeric) IS
  'Atomic invoice payment record. Wraps bank_txn INSERT + invoice status UPDATE + deal_commissions bulk approve + proforma cascade + JE header+lines INSERT in one Postgres transaction. Closes audit 2d2-F2 + F4 + F19 + F20.';

-- ── Verification ───────────────────────────────────────────────────────────
-- SELECT p.proname, p.prosecdef, p.proconfig
-- FROM pg_proc p
-- JOIN pg_namespace n ON p.pronamespace = n.oid
-- WHERE n.nspname = 'public' AND p.proname = 'record_invoice_payment';
-- Expected: prosecdef = true; proconfig = {search_path=public,pg_temp}
--
-- SELECT has_function_privilege('anon','record_invoice_payment(text,text,numeric,text,text,text,timestamptz,text,text,numeric)','EXECUTE') AS anon_can,
--        has_function_privilege('authenticated','record_invoice_payment(text,text,numeric,text,text,text,timestamptz,text,text,numeric)','EXECUTE') AS auth_can,
--        has_function_privilege('service_role','record_invoice_payment(text,text,numeric,text,text,text,timestamptz,text,text,numeric)','EXECUTE') AS svc_can;
-- Expected: anon_can=false, auth_can=false, svc_can=true
