-- 064_loi_documents.sql
-- ============================================================================
-- VELOS — Letter of Intent (LOI) document type.
--
-- Background
-- ----------
-- A Letter of Intent is a formal document expressing a buyer's intent to
-- purchase goods from a seller, specifying the product, quantity, price,
-- delivery terms, and validity period. It's a pre-contract document used
-- in B2B trade to signal serious buying intent before a formal contract
-- or purchase order.
--
-- This migration adds the `lois` table + supporting sequence + RLS policies.
-- The LOI is also registered in the existing `document_register` table
-- (type = 'loi') for unified document tracking + verification workflow.
-- ============================================================================

-- ── lois table ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lois (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  number          text NOT NULL,        -- e.g. LOI-2026-001
  partner_id      uuid NOT NULL,        -- the seller partner (recipient of the LOI)
  buyer_name      text NOT NULL,        -- the buyer's legal name (issuing party)
  buyer_address   text,                 -- buyer's address
  buyer_contact   text,                 -- buyer's contact person + email/phone
  subject         text NOT NULL,        -- e.g. "Letter of Intent — Purchase of Arabica Coffee"
  product_name    text NOT NULL,        -- the product being purchased
  product_description text,            -- detailed product description / specs
  hs_code         text,                 -- HS code for customs
  origin_country  text,                 -- ISO alpha-2 country of origin
  quantity        numeric(20,3) NOT NULL,    -- quantity to purchase
  unit            text NOT NULL,        -- unit of measure (MT, KG, L, etc.)
  unit_price      numeric(20,2) NOT NULL,   -- price per unit
  currency        text NOT NULL DEFAULT 'USD',
  total_value     numeric(20,2) NOT NULL,   -- quantity * unit_price (server-computed)
  delivery_terms  text,                 -- incoterm + delivery location
  delivery_date   date,                 -- expected delivery date
  payment_terms   text,                 -- e.g. "30% advance, 70% on B/L"
  validity_until  date NOT NULL,        -- LOI is valid until this date
  status          text NOT NULL DEFAULT 'draft',  -- draft | sent | accepted | rejected | expired | cancelled
  notes           text,                 -- additional terms / conditions
  terms_text      text,                 -- the full LOI body text (legal-style paragraphs)
  sent_at         timestamptz,          -- when the LOI was emailed to the seller
  responded_at    timestamptz,          -- when the seller accepted/rejected
  created_by      uuid,                 -- the admin who created the LOI
  deal_id         uuid,                 -- optional link to a deal (for pipeline tracking)
  offer_id        uuid,                 -- optional link to an offer (if LOI leads to an offer)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Per-tenant unique number (one LOI number per tenant per year)
CREATE UNIQUE INDEX IF NOT EXISTS lois_tenant_number_unique
  ON public.lois (tenant_id, number);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS lois_tenant_id_idx ON public.lois (tenant_id);
CREATE INDEX IF NOT EXISTS lois_partner_id_idx ON public.lois (partner_id);
CREATE INDEX IF NOT EXISTS lois_status_idx ON public.lois (status);
CREATE INDEX IF NOT EXISTS lois_created_at_idx ON public.lois (created_at DESC);
CREATE INDEX IF NOT EXISTS lois_deal_id_idx ON public.lois (deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS lois_offer_id_idx ON public.lois (offer_id) WHERE offer_id IS NOT NULL;

-- ── RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE public.lois ENABLE ROW LEVEL SECURITY;

-- Tenant users can read + write their own tenant's LOIs.
-- Super-admins bypass RLS (they have service_role).
CREATE POLICY "lois_tenant_select"
  ON public.lois FOR SELECT
  USING (
    auth.role() = 'service_role'
    OR tenant_id::text = (
      SELECT tenant_id::text FROM public.users
      WHERE id::text = auth.uid()::text
      LIMIT 1
    )
  );

CREATE POLICY "lois_tenant_insert"
  ON public.lois FOR INSERT
  WITH CHECK (
    auth.role() = 'service_role'
    OR tenant_id::text = (
      SELECT tenant_id::text FROM public.users
      WHERE id::text = auth.uid()::text
      LIMIT 1
    )
  );

CREATE POLICY "lois_tenant_update"
  ON public.lois FOR UPDATE
  USING (
    auth.role() = 'service_role'
    OR tenant_id::text = (
      SELECT tenant_id::text FROM public.users
      WHERE id::text = auth.uid()::text
      LIMIT 1
    )
  );

CREATE POLICY "lois_tenant_delete"
  ON public.lois FOR DELETE
  USING (
    auth.role() = 'service_role'
    OR tenant_id::text = (
      SELECT tenant_id::text FROM public.users
      WHERE id::text = auth.uid()::text
      LIMIT 1
    )
  );

-- ── Grant ────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lois TO service_role;
GRANT USAGE, SELECT ON public.lois TO anon, authenticated;

-- ── updated_at trigger ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lois_touch_updated_at ON public.lois;
CREATE TRIGGER lois_touch_updated_at
  BEFORE UPDATE ON public.lois
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── LOI number sequence ─────────────────────────────────────────────────
-- Add 'loi' to the doc_number_allocations doc_type values. The
-- get_next_doc_number RPC (migration 063) handles any doc_type string,
-- so no function change needed — just insert the first allocation row
-- on demand when the first LOI is created.

-- ── document_register type extension ────────────────────────────────────
-- The document_register table's `type` column is text (not enum-constrained
-- in the app layer — DocumentType union includes 'other' as a catch-all).
-- We register LOIs in document_register with type='loi' so they appear in
-- the unified document register + verification workflow. No schema change
-- needed to document_register (type is text).
