-- 072_mark_payout_paid_rpc.sql
-- ============================================================================
-- CRITICAL FIX — audit 2d2-F3 + 2d2-F20 (round 2)
--
-- PROBLEM
--   `src/app/api/commission-payouts/[id]/route.ts` (PUT) does the payout
--   completion as TWO separate non-atomic steps:
--     1. `upsertCommissionPayout({ ...body, id, status: "completed" })` (line 104)
--        — DB write to payout row
--     2. For each commission_id: `markDealCommissionPaid(commissionId, ...)` (line 113)
--        — sequential per-row DB updates in a JS loop, EACH in its own
--        try/catch (line 117)
--   If the third of five markDealCommissionPaid calls fails, the loop
--   CONTINUES silently. Final state: payout.status = "completed",
--   commissions #1+#2 = "paid", #3 = "approved" (failed), #4+#5 = "paid".
--   The user sees the payout as "completed" in the UI; the underlying
--   commission rows are in inconsistent states (2d2-F3).
--
--   The markCommissionsEarnedOnInvoicePaid helper has the SAME pattern
--   (2d2-F20) — sequential per-row UPDATEs in a JS loop; on failure
--   some commissions stay "pending" while others are "approved". This
--   is closed by migration 071's record_invoice_payment RPC (which does
--   a bulk UPDATE inline). This migration closes the payout-completion
--   path (2d2-F3).
--
-- FIX
--   Single SECURITY DEFINER plpgsql function `mark_commission_payout_paid`
--   that performs ALL writes inside ONE Postgres transaction:
--     * SELECT payout FOR UPDATE  (serializes concurrent PUT calls on
--       the same payout + ensures idempotency: skip if already 'completed')
--     * UPDATE payout SET status='completed', paid_at=now(), payment_reference
--     * Bulk UPDATE deal_commissions SET status='paid', paid_at, payout_reference
--       WHERE id = ANY(commission_ids) AND tenant_id AND status = 'approved'
--       — single statement, atomic, no JS loop
--   Postgres auto-rollbacks on any error.
--
-- SECURITY
--   SECURITY DEFINER + SET search_path = public, pg_temp (Supabase
--   advisory 2023-09, matches migration 069 pattern). GRANT EXECUTE to
--   service_role ONLY — REVOKE from PUBLIC/anon/authenticated.
--
-- IDEMPOTENCY
--   * If the payout is ALREADY 'completed', the function is a no-op
--     (returns the existing state with commissions_marked_paid=0).
--   * The bulk UPDATE filters status='approved' so already-paid
--     commissions are skipped (counted as already_paid).
--
-- PRECONDITION (enforced by the route, not the RPC)
--   The route's approval-gate (audit F-6/P1-7) validates that ALL
--   listed commission_ids are status='approved' BEFORE the RPC is
--   called. The RPC's filter (status='approved') is defense-in-depth:
--   a 'pending' commission slipping through would simply be skipped
--   (not flipped to 'paid' illegally).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.mark_commission_payout_paid(
  p_payout_id         text,
  p_tenant_id         text,
  p_payment_reference text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_payout        RECORD;
  v_updated_count int := 0;
  v_already_paid  int := 0;
  v_total_count   int := 0;
  v_result        jsonb;
BEGIN
  IF p_payout_id IS NULL OR p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'mark_commission_payout_paid: p_payout_id and p_tenant_id are required';
  END IF;

  -- 1) SELECT payout FOR UPDATE — serializes concurrent PUT calls on the
  --    same payout. The lock is held until COMMIT/ROLLBACK.
  SELECT id, status, commission_ids, payment_reference
    INTO v_payout
    FROM commission_payouts
    WHERE id = p_payout_id
      AND tenant_id = p_tenant_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'mark_commission_payout_paid: payout % not found for tenant %', p_payout_id, p_tenant_id;
  END IF;

  -- Idempotency: if the payout is already 'completed', this is a retry.
  -- The bulk UPDATE below would be a no-op anyway (commissions already
  -- paid), but we skip the payout UPDATE too so paid_at is preserved.
  IF v_payout.status = 'completed' THEN
    SELECT
      COUNT(*) FILTER (WHERE status = 'paid'),
      COUNT(*) FILTER (WHERE status <> 'paid')
      INTO v_already_paid, v_updated_count
    FROM deal_commissions
    WHERE tenant_id = p_tenant_id
      AND payout_reference = p_payout_id;
    v_total_count := v_already_paid + v_updated_count;
    RETURN jsonb_build_object(
      'payout_id', p_payout_id,
      'status', 'completed',
      'commission_count', v_already_paid,
      'already_paid_count', v_already_paid,
      'total_count', v_total_count,
      'idempotent_replay', true
    );
  END IF;

  -- 2) UPDATE payout row (mark completed + stamp paid_at + payment_reference).
  UPDATE commission_payouts SET
    status = 'completed',
    paid_at = now(),
    payment_reference = COALESCE(p_payment_reference, payment_reference),
    updated_at = now()
  WHERE id = p_payout_id AND tenant_id = p_tenant_id;

  -- 3) Bulk UPDATE deal_commissions (single statement = atomic). Filters
  --    by status='approved' — defense-in-depth so a stray 'pending'
  --    commission in the list can't be flipped to 'paid' (the route
  --    pre-check should have caught it, but this guarantees it at the
  --    DB layer). Tenant-scoped. Skips already-paid (idempotent retry).
  IF v_payout.commission_ids IS NOT NULL THEN
    UPDATE deal_commissions SET
      status = 'paid',
      paid_at = now(),
      payout_reference = p_payout_id,
      updated_at = now()
    WHERE id = ANY(v_payout.commission_ids)
      AND tenant_id = p_tenant_id
      AND status = 'approved';
    GET DIAGNOSTICS v_updated_count = ROW_COUNT;

    -- Count commissions that were already paid (idempotent retry case).
    SELECT COUNT(*) INTO v_already_paid
    FROM deal_commissions
    WHERE id = ANY(v_payout.commission_ids)
      AND tenant_id = p_tenant_id
      AND status = 'paid';

    v_total_count := COALESCE(array_length(v_payout.commission_ids, 1), 0);
  END IF;

  v_result := jsonb_build_object(
    'payout_id', p_payout_id,
    'status', 'completed',
    'commission_count', v_updated_count,
    'already_paid_count', v_already_paid,
    'total_count', v_total_count
  );
  RETURN v_result;
END;
$$;

-- SECURITY: GRANT to service_role only.
REVOKE EXECUTE ON FUNCTION public.mark_commission_payout_paid(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.mark_commission_payout_paid(text, text, text) TO service_role;

COMMENT ON FUNCTION public.mark_commission_payout_paid(text, text, text) IS
  'Atomic commission payout completion. Wraps payout status UPDATE + bulk deal_commissions status=paid UPDATE in one Postgres transaction. Closes audit 2d2-F3 + F20. Idempotent: no-op if payout already completed.';

-- ── Verification ───────────────────────────────────────────────────────────
-- SELECT p.proname, p.prosecdef, p.proconfig
-- FROM pg_proc p
-- JOIN pg_namespace n ON p.pronamespace = n.oid
-- WHERE n.nspname = 'public' AND p.proname = 'mark_commission_payout_paid';
-- Expected: prosecdef = true; proconfig = {search_path=public,pg_temp}
--
-- SELECT has_function_privilege('anon','mark_commission_payout_paid(text,text,text)','EXECUTE') AS anon_can,
--        has_function_privilege('authenticated','mark_commission_payout_paid(text,text,text)','EXECUTE') AS auth_can,
--        has_function_privilege('service_role','mark_commission_payout_paid(text,text,text)','EXECUTE') AS svc_can;
-- Expected: anon_can=false, auth_can=false, svc_can=true
