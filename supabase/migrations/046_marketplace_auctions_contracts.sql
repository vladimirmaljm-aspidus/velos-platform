-- 046_marketplace_auctions_contracts.sql
-- ============================================================================
-- VELOS Marketplace — Phase 4: auctions, long-term contracts, smart pricing.
--
-- Extends marketplace_posts with auction-specific columns and adds three new
-- tables:
--   • marketplace_auction_bids         — bid history on an auction post
--   • marketplace_contracts            — long-term supply contracts
--   • marketplace_contract_deliveries  — scheduled delivery milestones
--
-- AUCTION MODEL
--   An auction post is a marketplace_posts row whose post_type='auction' and
--   whose auction_type ∈ {english, dutch, sealed}.
--     - english: ascending-bid auction. Each bid must be ≥
--       (current_price + auction_min_increment). auction_current_price is
--       updated on every successful bid. Highest bid at auction_ends wins.
--     - dutch: descending-bid auction. The price starts at
--       auction_start_price and drops by a configurable step each tick until
--       a bidder accepts the current price. The first bid wins and the
--       auction ends immediately.
--     - sealed: bidders submit exactly one bid before auction_end. Bids are
--       hidden from other bidders (the list endpoint returns only the
--       caller's own bid). Highest bid at auction_end wins (subject to
--       reserve price).
--
--   The auction_winner_id column is set when processAuctionEnd() runs at
--   auction_ends_at. Until then it is NULL.
--
-- CONTRACT MODEL
--   A contract post is marketplace_posts.post_type='contract'. A contract row
--   stores the master agreement (total quantity, frequency, start/end dates,
--   price model). marketplace_contract_deliveries stores the recurring
--   schedule items — generated at contract creation from the frequency +
--   start_date + end_date. The "Mark Delivered" button on the UI updates
--   one row at a time; recalculateContractProgress() re-aggregates
--   delivered_quantity on the parent contract.
--
-- SECURITY MODEL
--   • RLS is permissive (USING(true)) as defense-in-depth — service_role
--     bypasses RLS, and the API layer is the real participant check.
--     Mirrors 044_marketplace.sql + 006_document_verification_logs.sql.
--   • Bids strip the partner_id when surfaced to OTHER bidders in a sealed
--     auction (handled at the API layer — the store returns the raw row).
--   • Contracts are scoped by tenant_id via the FK chain
--     contract → post → tenant; the store filters by tenant_id at read time.
--
-- IDEMPOTENCY
--   ALTER TABLE ADD COLUMN IF NOT EXISTS + CREATE TABLE IF NOT EXISTS +
--   CREATE INDEX IF NOT EXISTS make this safe to re-run. No data is ever
--   deleted.
-- ============================================================================

-- ─── 1. Auction columns on marketplace_posts ──────────────────────────────
ALTER TABLE marketplace_posts ADD COLUMN IF NOT EXISTS auction_type TEXT
  CHECK (auction_type IN ('english', 'dutch', 'sealed'));
ALTER TABLE marketplace_posts ADD COLUMN IF NOT EXISTS auction_start_price NUMERIC;
ALTER TABLE marketplace_posts ADD COLUMN IF NOT EXISTS auction_current_price NUMERIC;
ALTER TABLE marketplace_posts ADD COLUMN IF NOT EXISTS auction_reserve_price NUMERIC;
ALTER TABLE marketplace_posts ADD COLUMN IF NOT EXISTS auction_ends_at TIMESTAMPTZ;
ALTER TABLE marketplace_posts ADD COLUMN IF NOT EXISTS auction_winner_id TEXT;
ALTER TABLE marketplace_posts ADD COLUMN IF NOT EXISTS auction_min_increment NUMERIC DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_mp_auction_ends
  ON marketplace_posts(auction_ends_at)
  WHERE post_type = 'auction' AND status = 'active';
CREATE INDEX IF NOT EXISTS idx_mp_auction_type
  ON marketplace_posts(auction_type)
  WHERE post_type = 'auction';

-- ─── 2. marketplace_auction_bids ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketplace_auction_bids (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id         UUID NOT NULL REFERENCES marketplace_posts(id) ON DELETE CASCADE,
  partner_id      TEXT NOT NULL,             -- → partners.id (bidder)
  bid_amount      NUMERIC NOT NULL,
  currency        TEXT DEFAULT 'USD',
  is_winning      BOOLEAN DEFAULT false,     -- set when auction ends
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ab_post    ON marketplace_auction_bids(post_id);
CREATE INDEX IF NOT EXISTS idx_ab_partner ON marketplace_auction_bids(partner_id);
CREATE INDEX IF NOT EXISTS idx_ab_post_amount
  ON marketplace_auction_bids(post_id, bid_amount DESC);

-- ─── 3. marketplace_contracts ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketplace_contracts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id             UUID NOT NULL REFERENCES marketplace_posts(id) ON DELETE CASCADE,

  -- Master agreement terms
  total_quantity      NUMERIC NOT NULL,
  delivered_quantity  NUMERIC DEFAULT 0,     -- aggregated from deliveries
  frequency           TEXT CHECK (frequency IN ('monthly', 'quarterly', 'weekly', 'custom')),
  start_date          TIMESTAMPTZ NOT NULL,
  end_date            TIMESTAMPTZ NOT NULL,
  price_type          TEXT CHECK (price_type IN ('fixed', 'floating', 'indexed')),
  status              TEXT DEFAULT 'active'
                      CHECK (status IN ('active', 'completed', 'cancelled', 'breached')),

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mc_post   ON marketplace_contracts(post_id);
CREATE INDEX IF NOT EXISTS idx_mc_status ON marketplace_contracts(status);

-- ─── 4. marketplace_contract_deliveries ───────────────────────────────────
CREATE TABLE IF NOT EXISTS marketplace_contract_deliveries (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id         UUID NOT NULL REFERENCES marketplace_contracts(id) ON DELETE CASCADE,
  scheduled_date      TIMESTAMPTZ NOT NULL,
  quantity            NUMERIC NOT NULL,
  status              TEXT DEFAULT 'pending'
                      CHECK (status IN ('pending', 'delivered', 'partial', 'missed')),
  delivered_quantity  NUMERIC DEFAULT 0,
  notes               TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cd_contract ON marketplace_contract_deliveries(contract_id);
CREATE INDEX IF NOT EXISTS idx_cd_date     ON marketplace_contract_deliveries(scheduled_date);

-- ─── 5. RLS — permissive (service_role writes; API layer enforces ownership) ─
ALTER TABLE marketplace_auction_bids        ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_contracts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_contract_deliveries ENABLE ROW LEVEL SECURITY;

-- Mirrors 044_marketplace.sql: permissive USING(true) so the service_role
-- (which bypasses RLS) is the only reader/writer in practice.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['marketplace_auction_bids','marketplace_contracts','marketplace_contract_deliveries'] LOOP
    BEGIN
      EXECUTE format('CREATE POLICY %I ON %I USING (true) WITH CHECK (true)',
                     t || '_service_role_all', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $$;

-- ─── 6. updated_at triggers ────────────────────────────────────────────────
-- Reuse the public.set_updated_at() function from 044_marketplace.sql — it is
-- CREATE OR REPLACE so this migration is safe even if 044 was applied later.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mc_updated ON marketplace_contracts;
CREATE TRIGGER trg_mc_updated BEFORE UPDATE ON marketplace_contracts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_cd_updated ON marketplace_contract_deliveries;
CREATE TRIGGER trg_cd_updated BEFORE UPDATE ON marketplace_contract_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
