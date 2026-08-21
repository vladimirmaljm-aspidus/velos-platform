-- 047_marketplace_logistics.sql
-- ============================================================================
-- VELOS Marketplace — Phase 6: logistics (shipment tracking, freight/customs
-- calculators, container loadability, carbon footprint).
--
-- Adds two tables:
--   • marketplace_shipments         — one shipment per booked transport
--   • marketplace_shipment_events   — chronological status / tracking events
--
-- SHIPMENT MODEL
--   A shipment is created when a marketplace post + negotiation have settled
--   into a deal and the seller has booked sea/land transport with a carrier.
--   The shipment carries the carrier name + tracking number, the container
--   identifier, the B/L number, the port pair (loading → discharge), the
--   vessel name, and the ETA/ATA timestamps for both departure and arrival.
--
--   The shipment lifecycle mirrors a real container's journey:
--     pending → booked → loading → in_transit → arrived_port → customs
--            → delivered
--   with `delayed` and `cancelled` as parallel terminal states. The
--   `status` column is the denormalised "current" status — the source of
--   truth is the `marketplace_shipment_events` history. Every status
--   transition inserts a row into the events table, and the API layer
--   updates `marketplace_shipments.status` to match the latest event.
--
-- SECURITY MODEL
--   • RLS is permissive (USING(true)) as defense-in-depth — service_role
--     bypasses RLS, and the API layer is the real participant check.
--     Mirrors 044_marketplace.sql + 046_marketplace_auctions_contracts.sql.
--   • Shipments are tenant-scoped via the FK chain shipment →
--     marketplace_posts → tenant. The store filters by tenant_id and
--     partner_id at read time.
--   • The post_id / negotiation_id columns are nullable so a shipment may
--     be created standalone (e.g. for freight enquiries before a
--     negotiation has been opened).
--
-- IDEMPOTENCY
--   CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS make this
--   safe to re-run. No data is ever deleted.
-- ============================================================================

-- ─── 1. marketplace_shipments ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketplace_shipments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL,
  partner_id      TEXT NOT NULL,              -- → partners.id (booking partner)

  -- Optional marketplace context
  post_id         UUID REFERENCES marketplace_posts(id),
  negotiation_id  UUID REFERENCES marketplace_negotiations(id),

  -- Lifecycle status (denormalised from shipment_events)
  status          TEXT DEFAULT 'pending'
                  CHECK (status IN (
                    'pending', 'booked', 'loading', 'in_transit',
                    'arrived_port', 'customs', 'delivered', 'delayed',
                    'cancelled'
                  )),

  -- Carrier + transport identifiers
  carrier_name            TEXT,
  carrier_tracking_number TEXT,
  container_number        TEXT,
  bill_of_lading_number   TEXT,

  -- Voyage
  loading_port      TEXT,
  discharge_port    TEXT,
  vessel_name       TEXT,
  estimated_departure TIMESTAMPTZ,
  actual_departure    TIMESTAMPTZ,
  estimated_arrival  TIMESTAMPTZ,
  actual_arrival      TIMESTAMPTZ,

  -- Cargo
  container_type   TEXT CHECK (container_type IN (
                    '20gp', '40gp', '40hc', '40ot', '40fr',
                    'lcl', 'bulk', 'tank'
                  )),
  gross_weight     NUMERIC,                  -- kg
  net_weight       NUMERIC,                  -- kg
  volume           NUMERIC,                  -- m³
  packages_count   INTEGER,
  temperature_controlled BOOLEAN DEFAULT false,
  notes            TEXT,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 2. marketplace_shipment_events ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketplace_shipment_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id  UUID NOT NULL REFERENCES marketplace_shipments(id) ON DELETE CASCADE,
  status       TEXT NOT NULL,                -- mirrors shipment.status values
  location     TEXT,                          -- port / city / terminal
  event_date   TIMESTAMPTZ NOT NULL DEFAULT now(),
  description  TEXT,
  created_by   TEXT                           -- partner_id or 'system'
);

-- ─── 3. Indexes ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_ms_partner  ON marketplace_shipments(partner_id);
CREATE INDEX IF NOT EXISTS idx_ms_status   ON marketplace_shipments(status);
CREATE INDEX IF NOT EXISTS idx_ms_tracking ON marketplace_shipments(carrier_tracking_number);
CREATE INDEX IF NOT EXISTS idx_mse_shipment ON marketplace_shipment_events(shipment_id);

-- ─── 4. RLS — permissive (service_role writes; API layer enforces ownership) ─
ALTER TABLE marketplace_shipments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_shipment_events ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['marketplace_shipments','marketplace_shipment_events'] LOOP
    BEGIN
      EXECUTE format('CREATE POLICY %I ON %I USING (true) WITH CHECK (true)',
                     t || '_service_role_all', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $$;

-- ─── 5. updated_at trigger on marketplace_shipments ─────────────────────────
-- Reuse the public.set_updated_at() function from 044_marketplace.sql — it
-- is CREATE OR REPLACE so this migration is safe even if 044 was applied
-- later.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ms_updated ON marketplace_shipments;
CREATE TRIGGER trg_ms_updated BEFORE UPDATE ON marketplace_shipments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
