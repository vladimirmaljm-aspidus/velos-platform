-- 054_marketplace_admin.sql
-- ============================================================================
-- VELOS Marketplace — Super-admin management tables (task UI-2).
--
-- Adds the cross-tenant management surfaces used by the super-admin
-- marketplace panel:
--
--   • marketplace_categories — curated taxonomy of product categories shown
--     in the marketplace browse filters + post-create dropdown. Posts still
--     carry a free-text product_category column (migration 044); this table
--     is the canonical list the admin curates and the create-post form
--     validates against. Featured categories bubble to the top of the
--     browse page; sort_order controls the rest.
--
--   • marketplace_blacklist — platform-level block list of companies
--     (partners) that are forbidden from posting on the marketplace. The
--     marketplace-create-post API checks this table before allowing a
--     partner to publish. A blacklisted partner's existing posts are
--     surfaced to the admin for mass-flagging.
--
-- Schema additions to existing tables (idempotent ALTERs):
--   • marketplace_posts.is_featured           — featured on the browse page
--   • marketplace_reviews.is_flagged          — admin-flagged for review
--   • marketplace_reviews.flagged_by         — username of the admin
--   • marketplace_reviews.flagged_reason      — short reason text
--   • marketplace_reviews.flagged_at           — when the flag was set
--
-- SECURITY MODEL
--   • RLS is permissive (USING(true)) as defense-in-depth — service_role
--     bypasses RLS, and the API layer (requireSuperAdmin) is the real
--     gate. Mirrors 044_marketplace.sql + 045_marketplace_profiles.sql.
--
-- IDEMPOTENCY
--   CREATE TABLE IF NOT EXISTS + ALTER TABLE ADD COLUMN IF NOT EXISTS make
--   this safe to re-run. No data is ever deleted.
-- ============================================================================

-- ─── 1. marketplace_categories ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketplace_categories (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL,
  parent_id       UUID REFERENCES marketplace_categories(id) ON DELETE SET NULL,
  icon            TEXT,                          -- lucide icon name (optional)
  sort_order      INTEGER NOT NULL DEFAULT 0,
  is_featured     BOOLEAN NOT NULL DEFAULT false,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(slug)
);

CREATE INDEX IF NOT EXISTS idx_mc_parent  ON marketplace_categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_mc_active  ON marketplace_categories(is_active);
CREATE INDEX IF NOT EXISTS idx_mc_featured ON marketplace_categories(is_featured);

-- Seed the table with a small starter taxonomy so the admin panel has
-- something to render on first open. Use INSERT … ON CONFLICT DO NOTHING
-- so re-running the migration never dupes.
INSERT INTO marketplace_categories (name, slug, sort_order, is_featured) VALUES
  ('Metals',        'metals',        1, true),
  ('Agriculture',   'agriculture',   2, true),
  ('Energy',        'energy',        3, false),
  ('Chemicals',     'chemicals',     4, false),
  ('Construction',  'construction',  5, false),
  ('Food & Beverage','food-beverage', 6, false),
  ('Textiles',      'textiles',      7, false),
  ('Machinery',     'machinery',     8, false),
  ('Electronics',   'electronics',   9, false),
  ('Other',         'other',        99, false)
ON CONFLICT (slug) DO NOTHING;

-- ─── 2. marketplace_blacklist ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketplace_blacklist (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id      TEXT NOT NULL,                 -- → partners.id
  partner_name    TEXT,                           -- snapshot of company name
  reason          TEXT,                           -- short admin note
  blocked_by      TEXT,                           -- username of the admin
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(partner_id)
);

CREATE INDEX IF NOT EXISTS idx_mb_active ON marketplace_blacklist(active);
CREATE INDEX IF NOT EXISTS idx_mb_partner ON marketplace_blacklist(partner_id);

-- ─── 3. marketplace_posts.is_featured ───────────────────────────────────────
-- Safe ALTER — IF NOT EXISTS guards repeated runs.
ALTER TABLE marketplace_posts
  ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_mp_featured ON marketplace_posts(is_featured) WHERE is_featured = true;

-- ─── 4. marketplace_reviews flagging columns ───────────────────────────────
ALTER TABLE marketplace_reviews
  ADD COLUMN IF NOT EXISTS is_flagged     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS flagged_by     TEXT,
  ADD COLUMN IF NOT EXISTS flagged_reason TEXT,
  ADD COLUMN IF NOT EXISTS flagged_at     TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_mr_flagged ON marketplace_reviews(is_flagged) WHERE is_flagged = true;

-- ─── 5. RLS + triggers on the new tables ────────────────────────────────────
ALTER TABLE marketplace_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_blacklist  ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['marketplace_categories','marketplace_blacklist'] LOOP
    BEGIN
      EXECUTE format('CREATE POLICY %I ON %I USING (true) WITH CHECK (true)',
                     t || '_service_role_all', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS trg_mc_updated ON marketplace_categories;
CREATE TRIGGER trg_mc_updated BEFORE UPDATE ON marketplace_categories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_mb_updated ON marketplace_blacklist;
CREATE TRIGGER trg_mb_updated BEFORE UPDATE ON marketplace_blacklist
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
