-- 018_atomic_invoice_payment_status.sql
-- ============================================================================
-- CRITICAL FIX (audit P1-2): atomic invoice payment status update.
--
-- The record-payment route had a race condition: two concurrent payments
-- could both read the same prior-txns snapshot, both compute "partial",
-- and both write "partial" — leaving a fully-paid invoice stuck.
--
-- This RPC performs the SELECT (sum of bank_transactions) + UPDATE (invoice
-- status) in a single atomic Postgres transaction, eliminating the race.
-- The route calls this RPC after inserting the bank_transaction row.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.atomic_update_invoice_payment_status(
  p_invoice_id text,
  p_tenant_id text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_invoice RECORD;
  v_total_paid numeric;
  v_new_status text;
BEGIN
  -- Lock the invoice row to prevent concurrent updates.
  SELECT total, number, currency, status
  INTO v_invoice
  FROM public.invoices
  WHERE id = p_invoice_id AND tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  -- If already paid or cancelled, don't change.
  IF v_invoice.status = 'paid' OR v_invoice.status = 'cancelled' THEN
    RETURN v_invoice.status;
  END IF;

  -- Sum all credit bank_transactions for this invoice (cumulative).
  SELECT COALESCE(SUM(amount), 0) INTO v_total_paid
  FROM public.erp_bank_transactions
  WHERE invoice_number = v_invoice.number
    AND transaction_type = 'credit'
    AND category = 'invoice_payment'
    AND tenant_id = p_tenant_id;

  -- Determine new status (1 cent tolerance for float drift).
  IF v_total_paid >= v_invoice.total - 0.01 THEN
    v_new_status := 'paid';
  ELSE
    v_new_status := 'partial';
  END IF;

  -- Atomic update.
  UPDATE public.invoices
  SET status = v_new_status, updated_at = now()
  WHERE id = p_invoice_id AND tenant_id = p_tenant_id;

  RETURN v_new_status;
END;
$$;

GRANT EXECUTE ON FUNCTION public.atomic_update_invoice_payment_status(text, text) TO authenticated, anon;

COMMENT ON FUNCTION public.atomic_update_invoice_payment_status(text, text) IS
  'Atomically computes cumulative paid amount and updates invoice status. '
  'Uses SELECT FOR UPDATE to prevent concurrent payment races. '
  'Called by /api/invoices/[id]/record-payment after inserting the bank transaction.';
