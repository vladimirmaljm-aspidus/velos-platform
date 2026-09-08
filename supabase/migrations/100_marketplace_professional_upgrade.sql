-- 100_marketplace_professional_upgrade.sql — Marketplace professional
-- upgrade: category data normalisation + saved searches (alert backend).
--
-- PART 1 — CATEGORY DATA NORMALISATION (fix, pre-099 data):
--   Posts created before migration 099's curated taxonomy wiring store
--   product_category as STATIC CODES from src/lib/data/reference.ts
--   (AGRI, FOOD, SUGAR, GRAIN, OIL, METAL, CHEM, CMT, ENERGY, TEXTILE,
--   MACHINERY, PACKAGING, OTHER), while the seeded taxonomy in
--   marketplace_categories (migration 054) — and the create-post form +
--   browse filters that consume it since 099 — store NAMES + slugs
--   (Metals, Agriculture, Energy, Chemicals, Construction,
--   Food & Beverage, Textiles, Machinery, Electronics, Other). A post
--   still carrying 'AGRI' never matches the browse filter for
--   'Agriculture', so pre-099 listings silently vanish from every
--   filtered view. This migration rewrites every legacy code to the
--   taxonomy NAME (the value posts must store). Each UPDATE is guarded
--   with WHERE product_category = 'CODE' so re-running is a no-op and
--   posts already storing taxonomy names are untouched.
--
-- PART 2 — SAVED SEARCHES (new table):
--   Portal clients can save a marketplace filter set (search text,
--   post_type, product_category, country) and opt into alerts: when a
--   new post matches, createMarketplacePost fires an in-app notification
--   (fire-and-forget — alert failures never block post creation).
--   Rows are per (tenant, portal_access) with an optional partner_id
--   notification target; the filters JSONB is validated at the API/store
--   layer (key whitelist: search / post_type / product_category /
--   country, string values, search ≤ 100 chars).
--
--   TYPE NOTE — deliberate deviation from the task DDL: tenant_id /
--   portal_access_id / partner_id are TEXT (cuid), not UUID. Portal and
--   tenant ids are cuid strings in portal_access / partners /
--   marketplace_posts (Prisma String @default(cuid())) — migration 098
--   typed the watchlist ids as UUID and every call from a real portal
--   partner 500'd with `invalid input syntax for type uuid` until 099
--   Part 1 re-typed them to TEXT. This migration uses TEXT from the
--   start (FK to portal_access(id) still valid — that column is TEXT).
--
-- RLS posture: service_role-only, identical to migration 076 / 099
-- (the app uses the service-role client; anon/authenticated stay locked
-- out of marketplace_* tables).
--
-- Idempotent: safe to re-run. No data is deleted.

-- ═══ PART 1 — Legacy category codes → taxonomy names ═══════════════════════

-- Mapping (reference.ts code → marketplace_categories.name, migration 054):
--   AGRI     → Agriculture
--   FOOD     → Food & Beverage
--   SUGAR    → Food & Beverage
--   GRAIN    → Agriculture
--   OIL      → Agriculture
--   METAL    → Metals
--   CHEM     → Chemicals
--   CMT      → Construction
--   ENERGY   → Energy
--   TEXTILE  → Textiles
--   MACHINERY→ Machinery
--   PACKAGING→ Other
--   OTHER    → Other
UPDATE public.marketplace_posts SET product_category = 'Agriculture'    WHERE product_category = 'AGRI';
UPDATE public.marketplace_posts SET product_category = 'Food & Beverage' WHERE product_category = 'FOOD';
UPDATE public.marketplace_posts SET product_category = 'Food & Beverage' WHERE product_category = 'SUGAR';
UPDATE public.marketplace_posts SET product_category = 'Agriculture'    WHERE product_category = 'GRAIN';
UPDATE public.marketplace_posts SET product_category = 'Agriculture'    WHERE product_category = 'OIL';
UPDATE public.marketplace_posts SET product_category = 'Metals'         WHERE product_category = 'METAL';
UPDATE public.marketplace_posts SET product_category = 'Chemicals'      WHERE product_category = 'CHEM';
UPDATE public.marketplace_posts SET product_category = 'Construction'   WHERE product_category = 'CMT';
UPDATE public.marketplace_posts SET product_category = 'Energy'         WHERE product_category = 'ENERGY';
UPDATE public.marketplace_posts SET product_category = 'Textiles'       WHERE product_category = 'TEXTILE';
UPDATE public.marketplace_posts SET product_category = 'Machinery'      WHERE product_category = 'MACHINERY';
UPDATE public.marketplace_posts SET product_category = 'Other'          WHERE product_category = 'PACKAGING';
UPDATE public.marketplace_posts SET product_category = 'Other'          WHERE product_category = 'OTHER';

-- ═══ PART 2 — marketplace_saved_searches ══════════════════════════════════

CREATE TABLE IF NOT EXISTS public.marketplace_saved_searches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  portal_access_id TEXT NOT NULL REFERENCES portal_access(id) ON DELETE CASCADE,
  partner_id TEXT,
  name TEXT NOT NULL,
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {search?, post_type?, product_category?, country?}
  alert_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_saved_searches_tenant ON marketplace_saved_searches(tenant_id);
CREATE INDEX IF NOT EXISTS idx_saved_searches_access ON marketplace_saved_searches(portal_access_id);
-- Partial index for the createMarketplacePost alert scan (tenant + alert).
CREATE INDEX IF NOT EXISTS idx_saved_searches_alerts
  ON marketplace_saved_searches(tenant_id) WHERE alert_enabled;

-- RLS — service_role only (migration 076 posture): the app talks to this
-- table exclusively through the service-role client (RLS bypass); anon /
-- authenticated clients get 42501 when they try to read or write. FORCE
-- ROW LEVEL SECURITY keeps even the table owner subject to the policy.
ALTER TABLE public.marketplace_saved_searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_saved_searches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS marketplace_saved_searches_service_role_only ON public.marketplace_saved_searches;
CREATE POLICY marketplace_saved_searches_service_role_only
  ON public.marketplace_saved_searches
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ═══ VERIFICATION ═════════════════════════════════════════════════════════
DO $$
BEGIN
  RAISE NOTICE '100 verification';
  IF EXISTS (
    SELECT 1 FROM public.marketplace_posts
    WHERE product_category IN
      ('AGRI','FOOD','SUGAR','GRAIN','OIL','METAL','CHEM','CMT','ENERGY',
       'TEXTILE','MACHINERY','PACKAGING','OTHER')
  ) THEN RAISE EXCEPTION 'FAIL: legacy category codes remain in marketplace_posts'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='marketplace_saved_searches'
  ) THEN RAISE EXCEPTION 'FAIL: marketplace_saved_searches missing'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='marketplace_saved_searches'
      AND policyname='marketplace_saved_searches_service_role_only'
  ) THEN RAISE EXCEPTION 'FAIL: saved_searches service_role policy missing'; END IF;
  RAISE NOTICE '100 OK';
END $$;
