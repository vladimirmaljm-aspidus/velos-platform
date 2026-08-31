-- 078_payment_je_fx_and_balance.sql
-- ============================================================================
-- AUDIT17 — money-path RPC fixes (three P1s in one migration, all additive
-- function re-publications; no table changes, no data rewrites).
--
-- F7 (P1) — record_invoice_payment never updated erp_bank_accounts.balance.
--           The JS store path (upsertErpBankTransaction) adjusts the balance
--           on every txn, but the RPC refactor moved record-payment onto the
--           RPC which only INSERTed the txn — the account ledger and the
--           account balance silently diverged after every payment.
--           Fix: in-RPC atomic `UPDATE erp_bank_accounts SET balance =
--           balance + p_amount` (also removes the read-modify-write race).
--
-- F5 (P1) — the auto-JE created by record_invoice_payment stored the FX rate
--           only on the HEADER; lines defaulted fx_rate=1, debit_base=0,
--           credit_base=0, so base-currency reports (trial balance, balance
--           sheet) fell back to the raw foreign amount via effectiveBase.
--           Fix: lines now carry fx_rate + debit_base/credit_base = amount ×
--           rate (mirroring upsert_journal_entry semantics from 038).
--
-- F4 (P1) — reverse_journal_entry dropped multi-currency data: reversal lines
--           were inserted without currency/fx_rate/debit_base/credit_base
--           (defaults: USD / 1.0 / 0 / 0) — after reversing a foreign-
--           currency entry, base-currency GL was wrong (foreign amount
--           instead of foreign × rate; phantom balances that never clear).
--           Fix: reversal lines now copy currency + fx_rate from the source
--           line/entry and compute swapped base amounts = swapped amount ×
--           fx_rate.
--
-- Safety: all three are CREATE OR REPLACE of existing SECURITY DEFINER
-- functions with the SAME signatures (drop+create not needed); existing
-- callers (record-payment route, erp reverse route) keep working unchanged.
-- Grants re-issued at the bottom (service_role only, PUBLIC/anon/
-- authenticated revoked — house rule from 067/068).
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

    -- AUDIT17 / F7: keep the account balance in sync with the ledger. The
    -- JS store path (upsertErpBankTransaction) adjusts the balance on every
    -- insert, but this RPC only INSERTed the txn — every payment recorded
    -- through it left erp_bank_accounts.balance stale (the ledger and the
    -- balance silently diverged). In-SQL UPDATE = atomic, no read-modify-
    -- write race (also fixes the F8 class for this path).
    UPDATE erp_bank_accounts
       SET balance = COALESCE(balance, 0) + p_amount
     WHERE id = p_bank_account_id
       AND tenant_id = p_tenant_id;
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
        -- AUDIT17 / F5: fx_rate + debit_base/credit_base are now populated
        -- on the lines (previously only the HEADER carried the rate; lines
        -- defaulted fx_rate=1, debit_base=0, so base-currency reports fell
        -- back to the raw foreign amount via effectiveBase).
        INSERT INTO erp_journal_lines (
          id, journal_entry_id, tenant_id, account_id, description,
          debit, credit, line_number, currency, partner_id,
          fx_rate, debit_base, credit_base
        ) VALUES
          (gen_random_uuid()::text, v_je_id, p_tenant_id, v_cash_account_id,
           'Payment received - ' || v_invoice.number,
           v_je_amount, 0, 1, v_je_currency, v_invoice.partner_id,
           v_rate, v_je_amount * v_rate, 0),
          (gen_random_uuid()::text, v_je_id, p_tenant_id, v_revenue_account_id,
           'Revenue - ' || v_invoice.number,
           0, v_revenue_amount, 2, v_je_currency, v_invoice.partner_id,
           v_rate, 0, v_revenue_amount * v_rate);

        -- Optional prepayment line (only on overpayment + account found).
        IF v_excess > 0 AND v_prepayment_account_id IS NOT NULL THEN
          INSERT INTO erp_journal_lines (
            id, journal_entry_id, tenant_id, account_id, description,
            debit, credit, line_number, currency, partner_id,
            fx_rate, debit_base, credit_base
          ) VALUES
            (gen_random_uuid()::text, v_je_id, p_tenant_id, v_prepayment_account_id,
             'Customer prepayment (overpayment) - ' || v_invoice.number,
             0, v_excess, 3, v_je_currency, v_invoice.partner_id,
             v_rate, 0, v_excess * v_rate);
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


-- ── reverse_journal_entry (F4 patch) ────────────────────────────────────────
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

  -- Step 1: Insert reversal entry header (unchanged from 031)
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

  -- Step 2: Insert reversed lines (debit/credit SWAPPED).
  -- AUDIT17 / F4 — carry the multi-currency data through: currency/fx_rate
  -- from the source line (falling back to the entry), and debit_base /
  -- credit_base = swapped amount × fx_rate. Previously these columns were
  -- omitted entirely (defaults: currency='USD', fx_rate=1, bases=0), so
  -- reversing a foreign-currency entry corrupted base-currency reports.
  INSERT INTO erp_journal_lines (
    id, journal_entry_id, tenant_id, account_id, description,
    debit, credit, line_number, currency, fx_rate, debit_base, credit_base
  )
  SELECT
    gen_random_uuid()::text,
    p_reversal_id,
    v_tenant_id,
    elem->>'account_id',
    elem->>'description',
    COALESCE((elem->>'credit')::double precision, 0),  -- swapped
    COALESCE((elem->>'debit')::double precision, 0),   -- swapped
    ROW_NUMBER() OVER (),
    COALESCE(NULLIF(elem->>'currency', ''), COALESCE(p_reversal_entry->>'currency', 'USD')),
    COALESCE(NULLIF(elem->>'fx_rate', '')::double precision,
             COALESCE((p_reversal_entry->>'exchange_rate')::double precision, 1)),
    COALESCE(NULLIF(elem->>'credit_base', '')::double precision,
             COALESCE((elem->>'credit')::double precision, 0)
             * COALESCE(NULLIF(elem->>'fx_rate', '')::double precision,
                        COALESCE((p_reversal_entry->>'exchange_rate')::double precision, 1))),
    COALESCE(NULLIF(elem->>'debit_base', '')::double precision,
             COALESCE((elem->>'debit')::double precision, 0)
             * COALESCE(NULLIF(elem->>'fx_rate', '')::double precision,
                        COALESCE((p_reversal_entry->>'exchange_rate')::double precision, 1)))
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

-- ── Grants (house rule: service_role only) ─────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.record_invoice_payment(text, text, numeric, text, text, text, timestamptz, text, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.record_invoice_payment(text, text, numeric, text, text, text, timestamptz, text, text, numeric) TO service_role;
REVOKE EXECUTE ON FUNCTION public.reverse_journal_entry(text, text, jsonb, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.reverse_journal_entry(text, text, jsonb, jsonb, text) TO service_role;

COMMENT ON FUNCTION public.record_invoice_payment(text, text, numeric, text, text, text, timestamptz, text, text, numeric) IS
  'AUDIT17: + bank-account balance UPDATE (F7) + FX-aware JE lines (F5) on top of 071.';
COMMENT ON FUNCTION public.reverse_journal_entry(text, text, jsonb, jsonb, text) IS
  'AUDIT17: reversal lines now carry currency/fx_rate/debit_base/credit_base (F4).';

-- ── Verification ───────────────────────────────────────────────────────────
-- SELECT p.proname, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
--  WHERE n.nspname='public' AND p.proname IN ('record_invoice_payment','reverse_journal_entry');
-- Expected: prosecdef = true for both.
