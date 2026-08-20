-- 044_marketplace.sql
-- ============================================================================
-- VELOS Marketplace — Phase 1: B2B commodity marketplace inside the portal.
--
-- Lets portal partners post buy/sell/auction/contract offers and respond
-- to others' posts with their own quotes. Phase 1 = posts + responses +
-- the negotiation/message tables (the negotiation room UI ships in a
-- later phase). All four tables are created here so the data model is
-- stable from day one.
--
-- Tables:
--   marketplace_posts         — public buy/sell listings
--   marketplace_responses     — counter-offers / quotes on a post
--   marketplace_negotiations  — private 1:1 chat rooms between two partners
--   marketplace_messages      — chat messages inside a negotiation
--
-- SECURITY MODEL
--   • Posts are tenant-scoped — only partners in the same tenant can browse
--     and respond. The application layer (src/lib/data/marketplace-store.ts)
--     sanitises the public listing shape (strips partner_id / tenant_id /
--     portal_access_id) so cross-tenant leakage is impossible at the API
--     boundary.
--   • The store enforces ownership before any UPDATE / DELETE: only the
--     post owner can edit / close / delete their post; only the post owner
--     can change a response's status (accept/reject/counter).
--   • Responses are visible to the post owner (received) and the responder
--     (sent). The store sanitises the partner_id field on read so the
--     responder's exact internal id does not leak to the post owner until
--     a negotiation is opened (Phase 2 contact-reveal).
--   • Negotiation messages are scoped by negotiation_id and the API layer
--     verifies the caller is a party to the negotiation before any read or
--     write.
--   • RLS is permissive (USING(true)) as defense-in-depth — service_role
--     bypasses RLS, and the API layer is the real participant check.
--     Mirrors the pattern in 006_document_verification_logs.sql.
--
-- IDEMPOTENCY
--   CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS makes this
--   safe to re-run. No data is ever deleted.
-- ============================================================================

-- ─── 1. marketplace_posts ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketplace_posts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL,
  partner_id      TEXT NOT NULL,             -- → partners.id (post owner)
  portal_access_id TEXT,                     -- → portal_access.id (creator session)

  -- Listing content
  post_type       TEXT NOT NULL DEFAULT 'sell'
                  CHECK (post_type IN ('buy','sell','auction','contract')),
  product_name    TEXT NOT NULL,
  product_category TEXT,
  product_subcategory TEXT,

  -- Quantity + price
  quantity        NUMERIC NOT NULL DEFAULT 0,
  unit           TEXT NOT NULL DEFAULT 'MT',
  target_price   NUMERIC,
  price_visible  BOOLEAN DEFAULT true,       -- false → "On request"
  currency       TEXT DEFAULT 'USD',
  price_type     TEXT DEFAULT 'fixed'
                  CHECK (price_type IN ('fixed','range','on_request')),
  price_max      NUMERIC,                    -- set when price_type = 'range'

  -- Delivery
  delivery_location TEXT,
  delivery_country   TEXT,                   -- ISO 3166-1 alpha-2
  delivery_date   TIMESTAMPTZ,
  incoterm        TEXT,                       -- EXW | FOB | CIF | ...
  origin_country  TEXT,                       -- ISO 3166-1 alpha-2
  packaging       TEXT,

  -- Specs / quality
  specifications  JSONB DEFAULT '{}',
  quality_specs   JSONB DEFAULT '[]',

  -- Misc terms
  payment_terms   TEXT,
  description     TEXT,

  -- Lifecycle + visibility
  status          TEXT DEFAULT 'active'
                  CHECK (status IN ('draft','active','closed','expired','flagged')),
  visibility      TEXT DEFAULT 'public'
                  CHECK (visibility IN ('public','private')),
  is_verified     BOOLEAN DEFAULT false,
  verification_level TEXT DEFAULT 'none'
                  CHECK (verification_level IN ('none','bronze','silver','gold','platinum')),

  -- Counters (denormalised for fast "popular" sort + card badges)
  views_count     INTEGER DEFAULT 0,
  responses_count INTEGER DEFAULT 0,

  -- Auto-expire (default 30 days; bumped by the route on create)
  expires_at      TIMESTAMPTZ DEFAULT (now() + interval '30 days'),

  -- Meta
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mp_tenant   ON marketplace_posts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_mp_status   ON marketplace_posts(status);
CREATE INDEX IF NOT EXISTS idx_mp_type     ON marketplace_posts(post_type);
CREATE INDEX IF NOT EXISTS idx_mp_category ON marketplace_posts(product_category);
CREATE INDEX IF NOT EXISTS idx_mp_partner  ON marketplace_posts(partner_id);
CREATE INDEX IF NOT EXISTS idx_mp_expires  ON marketplace_posts(expires_at) WHERE status = 'active';

-- ─── 2. marketplace_responses ──────────────────────────────────────────────
-- A "response" is an offer from one partner on another's post. The post
-- owner can accept / reject / counter it (status field). Accepting opens
-- a negotiation room (Phase 2).
CREATE TABLE IF NOT EXISTS marketplace_responses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id         UUID NOT NULL REFERENCES marketplace_posts(id) ON DELETE CASCADE,
  tenant_id       TEXT NOT NULL,
  partner_id      TEXT NOT NULL,             -- → partners.id (responder)
  portal_access_id TEXT,

  -- The responder's proposed terms
  quantity        NUMERIC,
  unit_price      NUMERIC,
  currency        TEXT DEFAULT 'USD',
  delivery_date   TIMESTAMPTZ,
  delivery_location TEXT,
  incoterm        TEXT,
  payment_terms   TEXT,

  -- Message + status
  message         TEXT,                       -- free-text cover note
  status          TEXT DEFAULT 'sent'
                  CHECK (status IN ('sent','viewed','accepted','rejected','expired','countered')),
  contact_revealed BOOLEAN DEFAULT false,    -- true once both sides accept
  is_counter      BOOLEAN DEFAULT false,
  parent_response_id UUID REFERENCES marketplace_responses(id),

  -- Meta
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mr_post    ON marketplace_responses(post_id);
CREATE INDEX IF NOT EXISTS idx_mr_partner ON marketplace_responses(partner_id);
CREATE INDEX IF NOT EXISTS idx_mr_status  ON marketplace_responses(status);

-- ─── 3. marketplace_negotiations ───────────────────────────────────────────
-- 1:1 negotiation room between the post owner and a responder. Created in
-- Phase 2 when a response is accepted. Messages live in marketplace_messages.
CREATE TABLE IF NOT EXISTS marketplace_negotiations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id         UUID NOT NULL REFERENCES marketplace_posts(id) ON DELETE CASCADE,
  response_id     UUID REFERENCES marketplace_responses(id),

  -- Participants (1:1 — both must be partners on this tenant)
  tenant_id_a     TEXT NOT NULL,
  partner_id_a    TEXT NOT NULL,             -- → partners.id (initiator)
  tenant_id_b     TEXT NOT NULL,
  partner_id_b    TEXT NOT NULL,             -- → partners.id (counterparty)

  -- Lifecycle
  status          TEXT DEFAULT 'active'
                  CHECK (status IN ('active','accepted','rejected','expired','cancelled')),
  contact_revealed BOOLEAN DEFAULT false,

  last_message_at TIMESTAMPTZ,                -- bumped on every new message

  -- Meta
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mn_post       ON marketplace_negotiations(post_id);
CREATE INDEX IF NOT EXISTS idx_mn_partner_a   ON marketplace_negotiations(partner_id_a);
CREATE INDEX IF NOT EXISTS idx_mn_partner_b   ON marketplace_negotiations(partner_id_b);

-- ─── 4. marketplace_messages ───────────────────────────────────────────────
-- Chat messages inside a negotiation room. Phase 1 ships the table so the
-- API can read/write it; the in-portal negotiation room UI is Phase 2.
CREATE TABLE IF NOT EXISTS marketplace_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negotiation_id  UUID NOT NULL REFERENCES marketplace_negotiations(id) ON DELETE CASCADE,
  sender_partner_id TEXT NOT NULL,            -- → partners.id

  message         TEXT,
  message_type    TEXT DEFAULT 'text'
                  CHECK (message_type IN ('text','offer','counter_offer','accept','reject','document','system')),
  offer_data      JSONB,                       -- structured payload for offer/counter_offer
  attachment_url  TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mm_negotiation ON marketplace_messages(negotiation_id);

-- ─── 5. RLS — permissive (service_role writes; API layer enforces ownership) ─
ALTER TABLE marketplace_posts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_responses    ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_negotiations ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_messages     ENABLE ROW LEVEL SECURITY;

-- Mirrors 006_document_verification_logs.sql: permissive USING(true) so the
-- service_role (which bypasses RLS) is the only reader/writer in practice.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['marketplace_posts','marketplace_responses','marketplace_negotiations','marketplace_messages'] LOOP
    BEGIN
      EXECUTE format('CREATE POLICY %I ON %I USING (true) WITH CHECK (true)',
                     t || '_service_role_all', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $$;

-- ─── 6. updated_at triggers ────────────────────────────────────────────────
-- Postgres now() trigger keeps updated_at fresh on every UPDATE. Mirrors
-- the touch_updated_at() pattern used across the schema.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mp_updated ON marketplace_posts;
CREATE TRIGGER trg_mp_updated BEFORE UPDATE ON marketplace_posts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_mr_updated ON marketplace_responses;
CREATE TRIGGER trg_mr_updated BEFORE UPDATE ON marketplace_responses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_mn_updated ON marketplace_negotiations;
CREATE TRIGGER trg_mn_updated BEFORE UPDATE ON marketplace_negotiations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
