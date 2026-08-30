-- 073_bank_txn_idempotency.sql
-- ============================================================================
-- HIGH FIX — audit 2d2-F17 (round 2)
--
-- PROBLEM
--   `src/app/api/erp/bank-transactions/route.ts` (POST) accepts
--   `{ bank_account_id, amount, reference, transaction_type, date }`
--   and INSERTs a new erp_bank_transactions row WITHOUT any
--   idempotency check. A client retrying due to a network glitch
--   creates a DUPLICATE transaction with identical
--   (bank_account_id, reference, amount, date). The bank ledger
--   shows 2× the credit. The cumulative-txn lookup in record-payment
--   (now via migration 071's record_invoice_payment RPC) sums BOTH —
--   invoice marked "paid" earlier than expected (or even double-paid
--   if the duplicated amount exceeds the invoice total).
--
--   The existing route at lines 80-96 validates that bank_account_id
--   belongs to the caller's tenant (cross-tenant guard) — but does
--   NOTHING to dedupe retries on the SAME tenant's bank_account.
--
-- FIX
--   Add a partial UNIQUE index on erp_bank_transactions
--   `(tenant_id, bank_account_id, reference, amount, date)`
--   WHERE reference IS NOT NULL. Postgres treats NULLs as distinct
--   in UNIQUE constraints, so without the partial-index filter a row
--   with reference=NULL would block legitimate NULL-NULL duplicates.
--   The partial index only fires when the caller supplied a reference
--   (the only case where idempotency can be reasonably asserted).
--
--   The route is updated to catch the unique-violation (PSQL 23505)
--   and return 409 with the existing txn id so the client can treat
--   the duplicate as a successful replay.
--
-- SECURITY
--   No SECURITY DEFINER function is created — this is a pure index
--   migration. The idempotency is enforced at the DB constraint layer
--   (cheaper + safer than a SELECT-then-INSERT application pattern,
--   which would still be subject to TOCTOU under concurrent calls).
--
-- IDEMPOTENCY
--   CREATE INDEX IF NOT EXISTS — safe to re-run.
--
-- ADDITIVE
--   No data is deleted or modified. Adding a UNIQUE constraint to a
--   table with existing data will FAIL if there are already duplicates
--   — the verification SELECT below should be run first to confirm
--   no duplicates exist (today the live DB has none per the audit).
-- ============================================================================

-- ── Pre-flight: verify no duplicate (tenant_id, bank_account_id, reference, amount, date) ──
-- combinations exist BEFORE adding the UNIQUE index. If this returns
-- any rows, the index creation below will FAIL — those duplicates must
-- be reconciled first (manual operator action).
-- ============================================================================
-- SELECT tenant_id, bank_account_id, reference, amount, date, count(*)
-- FROM erp_bank_transactions
-- WHERE reference IS NOT NULL
-- GROUP BY tenant_id, bank_account_id, reference, amount, date
-- HAVING count(*) > 1;
-- Expected: 0 rows (live DB has no duplicates today per audit 2d2-F17).
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS erp_bank_transactions_idempotency_key
  ON public.erp_bank_transactions (
    tenant_id, bank_account_id, reference, amount, date
  )
  WHERE reference IS NOT NULL;

COMMENT ON INDEX public.erp_bank_transactions_idempotency_key IS
  'Partial UNIQUE index enforcing idempotency on erp_bank_transactions for retried POSTs. (tenant_id, bank_account_id, reference, amount, date) tuple must be unique when reference is non-NULL. Audit 2d2-F17.';

-- ── Verification ───────────────────────────────────────────────────────────
-- SELECT indexname, indexdef
-- FROM pg_indexes
-- WHERE tablename = 'erp_bank_transactions'
--   AND indexname = 'erp_bank_transactions_idempotency_key';
-- Expected: one row with "CREATE UNIQUE INDEX ... WHERE (reference IS NOT NULL)"
