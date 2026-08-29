-- 062_release_confirmations.sql
-- ============================================================================
-- VELOS Marketplace — Phase 7 finance: `release_confirmations` JSONB column
-- on `marketplace_financial_instruments`.
--
-- FIX-AUDIT2-CRIT / C4 — the `both_parties_confirm` escrow release condition
-- was advertised as a 2-phase commit ("both the owning partner AND the
-- counterparty must agree before funds are released") but the store
-- (`releaseEscrow` in src/lib/data/marketplace-finance-store.ts) immediately
-- flipped status="released" on a single call from EITHER party — defeating
-- the safety guarantee. Any single party could release the funds.
--
-- This migration adds the column the store uses to track per-party
-- confirmations. The column is a JSONB array of partner_ids. The store
-- appends the caller's partner_id on each confirmation call; the status is
-- only flipped to "released" when BOTH the owning partner AND the
-- counterparty are present in the array.
--
-- IDEMPOTENCY
--   ALTER TABLE … ADD COLUMN IF NOT EXISTS makes this safe to re-run. The
--   DEFAULT '[]'::jsonb is backfilled for existing rows so the store's
--   "append if not already present" logic sees an empty array (not NULL).
--
-- RLS
--   The column inherits the table's existing permissive RLS policy
--   (049_marketplace_finance.sql); service_role writes, API layer
--   enforces ownership. No policy change required.
-- ============================================================================

ALTER TABLE marketplace_financial_instruments
  ADD COLUMN IF NOT EXISTS release_confirmations JSONB DEFAULT '[]'::jsonb;

-- Backfill existing rows: any pre-existing instrument that predates this
-- migration gets an empty confirmation array (rather than NULL) so the
-- store's "append if not already present" logic works uniformly.
UPDATE marketplace_financial_instruments
   SET release_confirmations = '[]'::jsonb
 WHERE release_confirmations IS NULL;
