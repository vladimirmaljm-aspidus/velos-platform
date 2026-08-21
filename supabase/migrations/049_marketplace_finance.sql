-- 049_marketplace_finance.sql
-- ============================================================================
-- VELOS Marketplace — Phase 7: finance (Letter of Credit, escrow, factoring,
-- trade-credit insurance, payment schedules).
--
-- Adds two tables:
--   • marketplace_financial_instruments — one row per L/C, escrow, factoring
--     arrangement, trade-credit insurance policy, or payment schedule.
--   • marketplace_payment_milestones     — the staged-payment rows backing a
--     `payment_schedule` instrument (advance → on_loading → on_arrival →
--     on_inspection_pass → on_delivery, with `manual` as a catch-all).
--
-- INSTRUMENT MODEL
--   The `instrument_type` discriminator drives which optional fields are
--   populated: L/C rows fill the `lc_*` block, escrow rows fill the
--   `escrow_*` block, factoring rows fill `factoring_*`, insurance rows
--   fill `insurance_*`, and payment schedules keep their stage list both as
--   a denormalised `payment_milestones` JSONB column on the instrument AND
--   as real rows in `marketplace_payment_milestones` (the JSONB column is
--   the immutable snapshot of the agreed schedule; the rows are the live
--   payment ledger with per-milestone status + paid_date + reference #).
--
--   The instrument lifecycle:
--     draft → submitted → approved → active → completed
--   with `rejected` (after submitted), `disputed` (after active), and
--   `released` / `refunded` as the escrow-specific terminal states.
--
-- SECURITY MODEL
--   • RLS is permissive (USING(true)) as defense-in-depth — service_role
--     bypasses RLS, and the API layer is the real participant check.
--     Mirrors 044/046/047_marketplace_*.sql.
--   • Instruments are tenant-scoped via the FK chain instrument →
--     marketplace_posts → tenant. The store filters by tenant_id and
--     partner_id at read time.
--   • The post_id / negotiation_id columns are nullable so an instrument
--     may be created standalone (e.g. a factoring arrangement negotiated
--     outside of a marketplace post).
--
-- IDEMPOTENCY
--   CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS make this
--   safe to re-run. No data is ever deleted.
-- ============================================================================

-- ─── 1. marketplace_financial_instruments ──────────────────────────────────
CREATE TABLE IF NOT EXISTS marketplace_financial_instruments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL,
  partner_id      TEXT NOT NULL,              -- → partners.id (owning partner)

  -- Optional marketplace context
  post_id         UUID REFERENCES marketplace_posts(id),
  negotiation_id  UUID REFERENCES marketplace_negotiations(id),

  -- Discriminator
  instrument_type TEXT NOT NULL CHECK (instrument_type IN (
    'letter_of_credit', 'escrow', 'factoring',
    'trade_credit_insurance', 'payment_schedule'
  )),

  -- Lifecycle status (denormalised; per-instrument)
  status          TEXT DEFAULT 'draft'
                  CHECK (status IN (
                    'draft', 'submitted', 'approved', 'active',
                    'completed', 'rejected', 'disputed', 'released', 'refunded'
                  )),

  -- Common monetary fields
  amount          NUMERIC NOT NULL,           -- face value / amount held
  currency        TEXT DEFAULT 'USD',

  -- L/C specific
  lc_type              TEXT CHECK (lc_type IN (
                         'irrevocable', 'revocable', 'confirmed', 'unconfirmed',
                         'transferable', 'back_to_back', 'standby'
                       )),
  lc_issuing_bank      TEXT,
  lc_advising_bank     TEXT,
  lc_expiry_date      TIMESTAMPTZ,
  lc_documents_required JSONB DEFAULT '[]'::jsonb,  -- array of doc codes

  -- Escrow specific
  escrow_release_condition TEXT CHECK (escrow_release_condition IN (
                             'delivery_confirmation', 'inspection_pass',
                             'both_parties_confirm', 'manual'
                           )),
  escrow_held_until   TIMESTAMPTZ,            -- auto-release deadline

  -- Factoring specific
  factoring_company      TEXT,
  factoring_discount_rate NUMERIC,             -- % of invoice amount
  factoring_advance_rate  NUMERIC,             -- % advanced up front

  -- Insurance specific
  insurance_provider   TEXT,
  insurance_coverage   NUMERIC,                -- % of insured amount covered
  insurance_premium    NUMERIC,                -- annual premium in `currency`

  -- Payment schedule snapshot (immutable agreed plan; live ledger is in
  -- marketplace_payment_milestones)
  payment_milestones   JSONB DEFAULT '[]'::jsonb,

  -- Common
  counterparty_partner_id TEXT,                 -- → partners.id
  terms                TEXT,
  documents            JSONB DEFAULT '[]'::jsonb,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 2. marketplace_payment_milestones ────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketplace_payment_milestones (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_id   UUID NOT NULL REFERENCES marketplace_financial_instruments(id) ON DELETE CASCADE,
  sequence        INTEGER NOT NULL,             -- 1-based ordering
  description     TEXT NOT NULL,
  percentage      NUMERIC NOT NULL,             -- % of instrument.amount
  amount          NUMERIC,                      -- optional override (else = percentage × amount)
  trigger_condition TEXT CHECK (trigger_condition IN (
                       'contract_signed', 'advance_payment', 'on_loading',
                       'on_departure', 'on_arrival', 'on_inspection_pass',
                       'on_delivery', 'manual'
                     )),
  status          TEXT DEFAULT 'pending'
                  CHECK (status IN (
                    'pending', 'due', 'paid', 'overdue', 'cancelled'
                  )),
  due_date        TIMESTAMPTZ,
  paid_date       TIMESTAMPTZ,
  reference_number TEXT,                        -- bank transfer / cheque ref
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 3. Indexes ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_fi_partner ON marketplace_financial_instruments(partner_id);
CREATE INDEX IF NOT EXISTS idx_fi_type   ON marketplace_financial_instruments(instrument_type);
CREATE INDEX IF NOT EXISTS idx_fi_status  ON marketplace_financial_instruments(status);
CREATE INDEX IF NOT EXISTS idx_pm_instrument ON marketplace_payment_milestones(instrument_id);
CREATE INDEX IF NOT EXISTS idx_pm_status     ON marketplace_payment_milestones(status);
CREATE INDEX IF NOT EXISTS idx_pm_due_date   ON marketplace_payment_milestones(due_date);

-- ─── 4. RLS — permissive (service_role writes; API layer enforces ownership) ─
ALTER TABLE marketplace_financial_instruments ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_payment_milestones      ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['marketplace_financial_instruments','marketplace_payment_milestones'] LOOP
    BEGIN
      EXECUTE format('CREATE POLICY %I ON %I USING (true) WITH CHECK (true)',
                     t || '_service_role_all', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $$;

-- ─── 5. updated_at trigger ────────────────────────────────────────────────
-- Reuse the public.set_updated_at() function from 044_marketplace.sql — it
-- is CREATE OR REPLACE so this migration is safe even if 044 was applied
-- later. (Same idempotent pattern as 047_marketplace_logistics.sql.)
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fi_updated ON marketplace_financial_instruments;
CREATE TRIGGER trg_fi_updated BEFORE UPDATE ON marketplace_financial_instruments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_pm_updated ON marketplace_payment_milestones;
CREATE TRIGGER trg_pm_updated BEFORE UPDATE ON marketplace_payment_milestones
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
