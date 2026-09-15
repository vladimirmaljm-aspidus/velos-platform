-- 102_credit_collections.sql — Credit & Collections module
--
-- Purpose: give the finance team a collections workbench over the existing
-- invoices + partners data:
--   • partners get credit-control columns (credit_limit / credit_currency /
--     on_hold / hold_reason) — set from the new Credit & Collections view
--     via the existing PUT /api/partners/[id] whitelist;
--   • a new `collection_reminders` table records the dunning ladder
--     (stage 1 gentle → 2 firm → 3 final) plus free-form collection notes,
--     per (tenant, partner, invoice).
--
-- Design notes:
--   * TYPE DEVIATION from the original spec (which asked for uuid columns
--     with FKs): the live core tables use TEXT ids — partners.id is TEXT
--     (migration 084: partner ids are a mix of cuids and legacy uuids),
--     invoices.id is TEXT (record_invoice_payment RPCs compare id = text),
--     tenants.id is TEXT (migration 003 already ships
--     `tenant_id TEXT REFERENCES tenants(id)`). A uuid column would break
--     inserts for every cuid partner and an FK to a text PK would fail at
--     CREATE time — the exact bug class migrations 084 / 099 had to fix.
--     Reference columns are therefore TEXT, with FKs only where the
--     referenced PK is known TEXT (partners / tenants / invoices).
--   * `sent_by` is TEXT WITHOUT an FK: evidence for users.id is split
--     (migration 039 used a uuid FK, the store's upsertUser comment says
--     gen_random_uuid()::text). A plain TEXT column stores either shape
--     safely; the value is the acting user's id from the auth context.
--   * Money uses numeric(18,2) like every other amount column (097).
--
-- Idempotent: safe to re-run.

-- ─── 1. partners: credit-control columns ────────────────────────────────────

ALTER TABLE public.partners
  ADD COLUMN IF NOT EXISTS credit_limit numeric(18,2),      -- NULL = no limit set
  ADD COLUMN IF NOT EXISTS credit_currency text,            -- ISO 4217 (validated at the API layer)
  ADD COLUMN IF NOT EXISTS on_hold boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hold_reason text;

-- ─── 2. collection_reminders ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.collection_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  partner_id text NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  -- NULL = partner-level reminder (not tied to a specific invoice).
  -- SET NULL keeps the reminder history when the invoice is deleted.
  invoice_id text REFERENCES invoices(id) ON DELETE SET NULL,
  -- Dunning ladder: 1 = gentle, 2 = firm, 3 = final.
  stage integer NOT NULL DEFAULT 1 CHECK (stage BETWEEN 1 AND 3),
  kind text NOT NULL DEFAULT 'reminder' CHECK (kind IN ('reminder','note')),
  note text,
  sent_by text,                                             -- acting user id (see header note)
  sent_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collection_reminders_tenant_partner
  ON public.collection_reminders (tenant_id, partner_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_collection_reminders_invoice
  ON public.collection_reminders (invoice_id) WHERE invoice_id IS NOT NULL;

-- ─── 3. Row-level security ─────────────────────────────────────────────────
--   Server-side only: the app talks to Supabase with the service-role key
--   (bypasses RLS), but RLS still guards direct anon/authenticated access.
--   Same posture as migration 097.
ALTER TABLE public.collection_reminders ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'collection_reminders'
      AND policyname = 'svc_collection_reminders_all'
  ) THEN
    CREATE POLICY svc_collection_reminders_all ON public.collection_reminders
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ─── 4. Ops summary ────────────────────────────────────────────────────────
SELECT 'collection_reminders' AS table_name, count(*) AS rows FROM public.collection_reminders;
