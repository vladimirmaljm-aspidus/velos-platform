-- 103_document_nature.sql
-- Feature: Document Nature — GOODS vs SERVICES.
--
-- Business context: the platform was built trade-first: every offer /
-- proforma / invoice assumed physical goods (HS codes, origin country,
-- incoterms, POL/POD, vessel, container, packaging). Tenants that sell
-- SERVICES (consulting, logistics services, agency retainers…) need a
-- different document: no HS/origin columns, no shipping trade-terms grid —
-- instead a service period, service location and time-based quantities.
--
-- This migration adds:
--   • nature            — 'goods' | 'services' (NOT NULL, default 'goods'
--                          so every legacy row reads as goods = unchanged
--                          behaviour)
--   • service_start     — overall service period start (ISO date string)
--   • service_end       — overall service period end (ISO date string)
--   • service_location  — where the service is/was provided (free text)
-- on the three commercial document tables (offers, proformas, invoices).
--
-- Per-line service data (service_period_from / service_period_to) lives in
-- the items JSONB — no schema change needed there.

ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS nature text NOT NULL DEFAULT 'goods'
    CHECK (nature IN ('goods', 'services')),
  ADD COLUMN IF NOT EXISTS service_start text,
  ADD COLUMN IF NOT EXISTS service_end text,
  ADD COLUMN IF NOT EXISTS service_location text;

ALTER TABLE public.proformas
  ADD COLUMN IF NOT EXISTS nature text NOT NULL DEFAULT 'goods'
    CHECK (nature IN ('goods', 'services')),
  ADD COLUMN IF NOT EXISTS service_start text,
  ADD COLUMN IF NOT EXISTS service_end text,
  ADD COLUMN IF NOT EXISTS service_location text;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS nature text NOT NULL DEFAULT 'goods'
    CHECK (nature IN ('goods', 'services')),
  ADD COLUMN IF NOT EXISTS service_start text,
  ADD COLUMN IF NOT EXISTS service_end text,
  ADD COLUMN IF NOT EXISTS service_location text;

-- List filtering (toolbar "All / Goods / Services" filter).
CREATE INDEX IF NOT EXISTS idx_offers_nature    ON public.offers (tenant_id, nature);
CREATE INDEX IF NOT EXISTS idx_proformas_nature ON public.proformas (tenant_id, nature);
CREATE INDEX IF NOT EXISTS idx_invoices_nature  ON public.invoices (tenant_id, nature);
