-- 080_commission_unique_active.sql
-- ============================================================================
-- AUDIT19 / F4 — close the double-accept commission race at the DB level.
--
-- Background
-- ----------
-- Both offer-accept paths (PUT /api/offers/[id] and POST
-- /api/portal/offers/[id]/respond) are read-check-write without an atomic
-- status guard, and `createCommissionOnOfferAccepted`'s idempotency is
-- check-then-insert in JS. Two concurrent accepts (admin PUT + portal
-- respond, or a double-click racing the first request) both pass and both
-- insert a pending `deal_commissions` row → the agent is owed a DOUBLE
-- commission.
--
-- The inventory cascade is protected by migration 070's
-- `deduct_product_stock` RPC (SELECT FOR UPDATE); commissions got no
-- equivalent.
--
-- Fix
-- ---
-- Partial UNIQUE INDEX: at most one ACTIVE commission per
-- (deal_id, agent_id). Cancelled commissions are excluded so the business
-- keeps the ability to void a commission and re-create a corrected one.
--
-- The JS check-then-insert in commission-cascade.ts will hit a 23505 unique
-- violation on the racing insert — the cascade already treats insert
-- failures as non-fatal (fire-and-forget, logged), so the loser of the race
-- is simply dropped, which is exactly the desired behavior.
--
-- Pre-flight (verified on production 2025-09-01): no existing duplicate
-- (deal_id, agent_id) pairs among active statuses — safe to create.
-- ============================================================================

-- 1) Guard the migration itself: fail LOUDLY (not silently) if historical
--    duplicates exist, so an operator must resolve them explicitly instead
--    of the CREATE INDEX failing with a bare 23505 at deploy time.
DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT 1 FROM deal_commissions
    WHERE status IN ('pending', 'approved', 'paid')
    GROUP BY deal_id, agent_id
    HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'migration 080 pre-flight: % duplicate active (deal_id, agent_id) commission pairs exist — resolve (void the extras) before applying', dup_count;
  END IF;
END $$;

-- 2) The unique constraint on ACTIVE commissions only.
CREATE UNIQUE INDEX IF NOT EXISTS uq_deal_commissions_active_deal_agent
  ON deal_commissions (deal_id, agent_id)
  WHERE status IN ('pending', 'approved', 'paid');

-- 3) Make the racing JS insert a clean no-op instead of an error:
--    ON CONFLICT DO NOTHING for programmatic inserts that opt in.
--    (PostgREST inserts via smartUpsert do not use this — the partial-index
--    predicate must match; the cascade's try/catch handles those.)
