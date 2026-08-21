-- 007_trade_calc_commission.sql
-- ============================================================================
-- Add commission tracking columns to the `trade_calculations` table.
--
-- WHY
--   The offer-preview endpoint (src/app/api/trade-calculator/[id]/offer-preview/
--   route.ts) reads `c.commission_agent_id`, `c.commission_type`, and
--   `c.commission_rate` from the trade_calculation row to auto-track commission
--   obligations when an offer is created from a calculation (Fix 2 chain).
--   The columns were missing from the live schema
--   (supabase-schema-live.sql:1439-1469), so the metadata was always null/0
--   and the downstream "auto-track commission on offer create" block in
--   POST /api/offers (which requires BOTH `_trade_calc_id && _commission_agent_id`)
--   never fired. End-to-end commission tracking from trade-calc → offer → deal
--   → commission was broken for trade-calc-derived offers.
--
-- IDEMPOTENCY
--   ALTER TABLE ... ADD COLUMN IF NOT EXISTS — safe to re-run. No data lost.
-- ============================================================================

ALTER TABLE trade_calculations ADD COLUMN IF NOT EXISTS commission_agent_id TEXT;
ALTER TABLE trade_calculations ADD COLUMN IF NOT EXISTS commission_type TEXT;
ALTER TABLE trade_calculations ADD COLUMN IF NOT EXISTS commission_rate REAL DEFAULT 0;

COMMENT ON COLUMN trade_calculations.commission_agent_id IS
  'Optional FK to commission_agents.id. When set, offers created from this '
  'calculation auto-track a commission obligation on accept (Fix 2 chain).';
COMMENT ON COLUMN trade_calculations.commission_type IS
  'Commission basis: "percent" or "fixed_amount". Mirrors deal_commissions.type.';
COMMENT ON COLUMN trade_calculations.commission_rate IS
  'Commission rate: percent value (e.g. 2.5 = 2.5%) when commission_type=percent, '
  'or fixed amount in sell_currency when commission_type=fixed_amount.';
