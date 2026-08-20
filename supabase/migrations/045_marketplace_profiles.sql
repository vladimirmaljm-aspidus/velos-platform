-- 045_marketplace_profiles.sql
-- ============================================================================
-- VELOS Marketplace — Phase 3: company profiles, ratings, verification tiers.
--
-- Three tables:
--   marketplace_company_profiles — public-facing company page per partner.
--     Stores the rich marketing copy (description, year established,
--     employees, certifications, export markets, main products), the
--     verification tier assigned by a super-admin (none/bronze/silver/gold/
--     platinum), and denormalised counters for the rating summary + deal
--     success rate.
--   marketplace_reviews         — 1–5 star ratings left by a partner on
--     another partner after a completed deal. The reviewed company can
--     post a single public response_text on each review.
--   marketplace_follows         — follower/followed relationship between two
--     partners. Used by the company profile page's "Follow" button + the
--     "Who I follow" / "Who follows me" lists.
--
-- SECURITY MODEL
--   • RLS is permissive (USING(true)) as defense-in-depth — service_role
--     bypasses RLS, and the API layer is the real participant check.
--     Mirrors 044_marketplace.sql + 006_document_verification_logs.sql.
--   • Public profile reads strip tenant_id (the API layer keeps it for
--     the JOIN to partners). Reviews strip the reviewer's partner_id when
--     surfaced publicly; the reviewed company's id is shown because the
--     caller navigated to that company's page.
--   • Verification tier changes are admin-only (POST /api/admin/verify-partner)
--     and stamp verified_by + verified_at.
--
-- IDEMPOTENCY
--   CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS makes this safe
--   to re-run. No data is ever deleted.
-- ============================================================================

-- ─── 1. marketplace_company_profiles ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketplace_company_profiles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL,
  partner_id      TEXT NOT NULL,             -- → partners.id (unique)

  -- Marketing copy
  company_description TEXT,
  year_established INTEGER,
  number_of_employees TEXT,                   -- free-text band: "1-10", "11-50", etc.
  website         TEXT,
  linkedin_url    TEXT,
  certifications  JSONB DEFAULT '[]',         -- [{ name, issuer, year }]
  export_markets  JSONB DEFAULT '[]',         -- ["US","DE","AE", ...] ISO alpha-2
  main_products   JSONB DEFAULT '[]',         -- [{ name, category }]

  -- Verification tier (set by a super-admin via POST /api/admin/verify-partner)
  verification_level TEXT DEFAULT 'none'
                  CHECK (verification_level IN ('none','bronze','silver','gold','platinum')),
  verified_at     TIMESTAMPTZ,
  verified_by     TEXT,                        -- username of the super-admin

  -- Denormalised counters (kept on the profile row so the public page can
  -- render without joins)
  total_posts     INTEGER DEFAULT 0,
  total_responses INTEGER DEFAULT 0,
  successful_deals INTEGER DEFAULT 0,
  rating_average  NUMERIC DEFAULT 0,           -- 0.00 – 5.00
  rating_count    INTEGER DEFAULT 0,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(partner_id)
);

CREATE INDEX IF NOT EXISTS idx_mcp_partner ON marketplace_company_profiles(partner_id);
CREATE INDEX IF NOT EXISTS idx_mcp_tenant  ON marketplace_company_profiles(tenant_id);
CREATE INDEX IF NOT EXISTS idx_mcp_verify ON marketplace_company_profiles(verification_level);

-- ─── 2. marketplace_reviews ─────────────────────────────────────────────────
-- One review per (reviewer, reviewed, post_id). A partner may review the
-- same counterparty on different posts; (reviewer, reviewed, NULL) is allowed
-- by the UNIQUE constraint because NULL never equals NULL in SQL.
CREATE TABLE IF NOT EXISTS marketplace_reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewer_partner_id TEXT NOT NULL,           -- → partners.id (reviewer)
  reviewed_partner_id TEXT NOT NULL,           -- → partners.id (reviewed)
  post_id         UUID REFERENCES marketplace_posts(id) ON DELETE SET NULL,
  rating          INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  review_text     TEXT,
  response_text   TEXT,                         -- company's public reply
  response_at     TIMESTAMPTZ,
  is_public       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(reviewer_partner_id, reviewed_partner_id, post_id)
);

CREATE INDEX IF NOT EXISTS idx_mr_reviewed ON marketplace_reviews(reviewed_partner_id);
CREATE INDEX IF NOT EXISTS idx_mr_reviewer ON marketplace_reviews(reviewer_partner_id);
CREATE INDEX IF NOT EXISTS idx_mr_post    ON marketplace_reviews(post_id);

-- ─── 3. marketplace_follows ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketplace_follows (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_partner_id TEXT NOT NULL,           -- → partners.id
  followed_partner_id TEXT NOT NULL,           -- → partners.id
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(follower_partner_id, followed_partner_id)
);

CREATE INDEX IF NOT EXISTS idx_mf_followed ON marketplace_follows(followed_partner_id);
CREATE INDEX IF NOT EXISTS idx_mf_follower ON marketplace_follows(follower_partner_id);

-- ─── 4. RLS — permissive (service_role writes; API layer enforces ownership) ─
ALTER TABLE marketplace_company_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_reviews          ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_follows         ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['marketplace_company_profiles','marketplace_reviews','marketplace_follows'] LOOP
    BEGIN
      EXECUTE format('CREATE POLICY %I ON %I USING (true) WITH CHECK (true)',
                     t || '_service_role_all', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $$;

-- ─── 5. updated_at triggers (reuse set_updated_at() from 044_marketplace.sql)
DROP TRIGGER IF EXISTS trg_mcp_updated ON marketplace_company_profiles;
CREATE TRIGGER trg_mcp_updated BEFORE UPDATE ON marketplace_company_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
