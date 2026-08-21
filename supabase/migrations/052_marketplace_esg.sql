-- Marketplace Phase 11 — ESG (Environmental, Social, Governance).
--
-- Backs the three ESG surfaces added in this phase:
--   • marketplace_esg_scores            — one row per company with the ESG
--                                         subscores + an overall letter
--                                         rating (AAA → CCC, S&P/MSCI-style)
--   • marketplace_sustainability_certs  — sustainability certification
--                                         ledger (FSC, RSPO, ISO 14001,
--                                         SA8000, Fairtrade, etc.) with
--                                         verification status
--   • marketplace_carbon_offsets        — carbon-offset purchases linked to
--                                         a shipment (tree planting,
--                                         renewable energy, methane capture,
--                                         direct air capture)
--
-- SECURITY MODEL
--   • partner_id is the canonical key for "who". It is stamped from the
--     auth context by the API route (the store never trusts a body-
--     supplied partner_id) — same convention as the rest of the
--     marketplace (marketplace_posts, marketplace_company_profiles, etc.).
--   • ESG scores are super-admin-set only (POST /api/admin/esg-score).
--     The auto-calculated provisional score (calculateESGScore in the
--     store) is a read-only helper that derives a score from the partner's
--     verified certifications; the super-admin can confirm or override it
--     before persisting.
--   • Sustainability certs: the owning partner can add their own certs
--     (POST /api/marketplace/esg/certs), starting verified = false. Only
--     super-admins can flip verified = true (PUT
--     /api/marketplace/esg/certs/[id] with verified: true — the route
--     enforces requireSuperAdmin). Unverified certs are visible on the
--     public profile but flagged so the viewer can distinguish them.
--   • Carbon offsets: the owning partner creates them (POST
--     /api/marketplace/esg/offsets). The status lifecycle is
--     pending → purchased → retired with `cancelled` as an off-ramp.
--     The certificate_url is stamped when the offset is retired.

-- ─── ESG scores ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS marketplace_esg_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id TEXT NOT NULL UNIQUE,
  environmental_score NUMERIC DEFAULT 0 CHECK (environmental_score >= 0 AND environmental_score <= 100),
  social_score NUMERIC DEFAULT 0 CHECK (social_score >= 0 AND social_score <= 100),
  governance_score NUMERIC DEFAULT 0 CHECK (governance_score >= 0 AND governance_score <= 100),
  overall_score NUMERIC DEFAULT 0,
  rating TEXT DEFAULT 'unrated' CHECK (rating IN ('unrated', 'ccc', 'b', 'bb', 'bbb', 'a', 'aa', 'aaa')),
  assessment_date TIMESTAMPTZ,
  assessed_by TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Sustainability certifications ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS marketplace_sustainability_certs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id TEXT NOT NULL,
  cert_type TEXT NOT NULL CHECK (cert_type IN ('fsc', 'rspo', 'msc', 'iso14001', 'iso45001', 'iso50001', 'sa8000', 'fairtrade', 'organic', 'global_gap', 'rainforest_alliance', 'carbon_neutral', 'b_corp')),
  cert_number TEXT,
  cert_issuer TEXT,
  valid_from TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  verified BOOLEAN DEFAULT false,
  verified_at TIMESTAMPTZ,
  document_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Carbon offset transactions ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS marketplace_carbon_offsets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id TEXT NOT NULL,
  shipment_id UUID REFERENCES marketplace_shipments(id),
  co2_tons NUMERIC NOT NULL,
  offset_cost NUMERIC,
  currency TEXT DEFAULT 'USD',
  offset_type TEXT CHECK (offset_type IN ('tree_planting', 'renewable_energy', 'methane_capture', 'direct_air_capture')),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'purchased', 'retired', 'cancelled')),
  certificate_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_esg_partner ON marketplace_esg_scores(partner_id);
CREATE INDEX IF NOT EXISTS idx_sc_partner ON marketplace_sustainability_certs(partner_id);
CREATE INDEX IF NOT EXISTS idx_co_partner ON marketplace_carbon_offsets(partner_id);
