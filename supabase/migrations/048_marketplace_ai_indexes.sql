-- 048_marketplace_ai_indexes.sql
-- ============================================================================
-- VELOS Marketplace — Phase 5: AI features (risk scoring, OCR, price prediction).
--
-- Phase 5 ships NO new tables — the AI features (risk scoring, OCR document
-- parsing, price prediction) are derived at request time from existing
-- Phase 1–4 tables (marketplace_posts, marketplace_responses,
-- marketplace_company_profiles, marketplace_auction_bids, marketplace_contracts).
--
-- This migration adds the supporting INDEXES the Phase 5 API routes rely on
-- for fast, tenant-scoped reads at request time:
--
--   • idx_mp_partner_tenant_recent — backs the risk-scoring route's
--     "partner's lifetime post count + last-24h post count" lookups.
--     Both `count(*)` queries filter by (partner_id, tenant_id) and the
--     24h variant adds `created_at >= <since24h>`. A composite index
--     on (partner_id, tenant_id, created_at DESC) lets the planner do an
--     index-only scan + range read.
--
--   • idx_mp_sell_product_recent — backs the price-prediction route's
--     "comparable sell posts in the last 90 days" lookup. The query
--     filters by (tenant_id, post_type='sell', product_name ILIKE %x%,
--     created_at >= <since90d>). The composite index on (tenant_id,
--     post_type, created_at DESC) WHERE post_type='sell' is a partial
--     index — it covers only sell posts (auction / contract / buy rows
--     are skipped at storage time), keeping the index small.
--
--   • idx_mr_post_unitprice_recent — backs the price-prediction route's
--     "responses on those comparable posts" lookup. The query filters
--     by post_id IN (...) AND unit_price IS NOT NULL. A partial index
--     WHERE unit_price IS NOT NULL keeps the index small (rows without
--     a counter-offer price are skipped).
--
--   • idx_mp_expires_active_phase5 — backs the auction-sweep cron's
--     "active posts whose expires_at has passed" lookup. A partial
--     index WHERE status='active' keeps the index small (closed /
--     expired / draft rows are skipped).
--
--   • idx_mp_auction_dutch_active — backs the auction-sweep cron's
--     "active dutch auctions still running" lookup. A partial index
--     WHERE post_type='auction' AND status='active' AND auction_type='dutch'
--     keeps the index tiny (dutch auctions are rare; an active one
--     at most one row at a time per tenant).
--
-- SECURITY MODEL
--   No new tables → no new RLS policies. The existing
--   marketplace_posts / marketplace_responses RLS policies (permissive
--   USING(true) with service_role bypass) cover every read the new
--   routes do. The Phase 5 API routes are the participant check — they
--   verify the caller's portal session + tenant before reading.
--
-- IDEMPOTENCY
--   CREATE INDEX IF NOT EXISTS makes this safe to re-run.
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_mp_partner_tenant_recent
  ON marketplace_posts(partner_id, tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mp_sell_product_recent
  ON marketplace_posts(tenant_id, created_at DESC)
  WHERE post_type = 'sell';

CREATE INDEX IF NOT EXISTS idx_mr_post_unitprice_recent
  ON marketplace_responses(post_id, created_at DESC)
  WHERE unit_price IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mp_expires_active_phase5
  ON marketplace_posts(expires_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_mp_auction_dutch_active
  ON marketplace_posts(auction_ends_at)
  WHERE post_type = 'auction' AND status = 'active' AND auction_type = 'dutch';
