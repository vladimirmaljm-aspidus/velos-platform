-- 097_portal_referral_commissions.sql — Portal referral commissions
--
-- Purpose: registered portal users (partners with portal access) earn a
-- commission on business they REFER to the tenant ("I introduced company X,
-- deal Y was made with them, I get Z%"). This gives the portal a dedicated
-- section: view each commission (amount, product, referral contact,
-- conditions), submit the bank account for payouts, and SIGN the referral +
-- commission agreement in-app. Admins get full lifecycle control.
--
-- Design notes:
--   * Kept SEPARATE from the internal deal_commissions system (CommissionAgent
--     + ERP auto-journal) — this is a partner-facing referral concept with
--     its own agreement/bank/documents machinery. A row MAY cross-link an
--     existing entity via (ref_type, ref_id) for traceability.
--   * The lifecycle is a strict state machine the ADMIN drives:
--       pending → confirmed → approved → paid    (+ cancelled from any
--     non-paid state). "documents_complete" and the signed agreement are
--     prerequisites enforced at approve/mark-paid time (API layer).
--   * Agreement acceptance is recorded like the ToS consent (audit log +
--     signed_version + signed_at + IP/UA), pinned to the agreement row.
--   * Payout bank details are SENSITIVE: the IBAN is stored encrypted
--     (enc:-prefixed ciphertext, same field-encryption as partner emails);
--     a masked variant + HMAC are stored alongside for lookup/display.
--   * Documents per commission reuse portal_uploads (category 'commission',
--     new referral_id link column — same pattern as migration 092 rfq_id).
--
-- Idempotent: safe to re-run.

-- ─── 1. referral_commissions ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.referral_commissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  partner_id text NOT NULL,               -- the referring partner (portal user's company)
  -- The referral (who the partner introduced):
  referral_company text NOT NULL,
  referral_contact text,
  referral_email text,                    -- plaintext ok (operational contact, like partner fields are decrypted for admins)
  referral_phone text,
  -- The business the commission is tied to:
  ref_type text NOT NULL DEFAULT 'manual'
    CHECK (ref_type IN ('deal','offer','invoice','proforma','loi','rfq','manual')),
  ref_id text,
  ref_number text,                        -- human-readable doc number, e.g. OFF-2026-0014
  product text,                           -- goods the deal is about
  deal_value numeric(18,2),
  currency text NOT NULL DEFAULT 'USD',
  -- Commission terms for THIS entry:
  commission_type text NOT NULL DEFAULT 'revenue_percent'
    CHECK (commission_type IN ('revenue_percent','profit_percent','fixed','per_unit')),
  commission_rate numeric(12,4),
  commission_amount numeric(18,2) NOT NULL DEFAULT 0,
  conditions text,                        -- free-text conditions shown to the partner
  -- Lifecycle (admin-driven state machine):
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','approved','paid','cancelled')),
  deal_done boolean NOT NULL DEFAULT false,
  deal_done_at timestamptz,
  documents_complete boolean NOT NULL DEFAULT false,
  documents_checked_at timestamptz,
  documents_checked_by text,
  approved_by text,
  approved_at timestamptz,
  paid_at timestamptz,
  payout_reference text,
  paid_amount numeric(18,2),
  admin_notes text,
  -- Agreement snapshot (which terms the partner signed when this was created):
  agreement_version text,
  -- Meta:
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_referral_commissions_tenant_partner
  ON public.referral_commissions (tenant_id, partner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_referral_commissions_status
  ON public.referral_commissions (tenant_id, status);
-- One live link per referenced entity (two referral rows for the same offer
-- would double-pay the commission). Manual entries are exempt.
CREATE UNIQUE INDEX IF NOT EXISTS uq_referral_commissions_ref
  ON public.referral_commissions (tenant_id, ref_type, ref_id)
  WHERE ref_type <> 'manual' AND status <> 'cancelled';

-- ─── 2. referral_agreements (one per partner per tenant) ────────────────────
CREATE TABLE IF NOT EXISTS public.referral_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  partner_id text NOT NULL,
  -- Terms the partner signs:
  commission_type text NOT NULL DEFAULT 'revenue_percent'
    CHECK (commission_type IN ('revenue_percent','profit_percent','fixed','per_unit')),
  commission_rate numeric(12,4),
  commission_currency text NOT NULL DEFAULT 'USD',
  conditions text,                        -- custom clauses appended to the standard agreement text
  -- Version pinning (like VELOS-LEGAL-TOS): bump when terms change; partners
  -- re-sign the new version; old signatures stay pinned to their version.
  agreement_version text NOT NULL DEFAULT 'RA-1.0',
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_signature','signed','suspended','terminated')),
  activated_at timestamptz,
  -- Signature block (written ONLY by the portal sign route):
  signed_at timestamptz,
  signed_by_name text,
  signed_version text,
  signed_ip text,
  signed_user_agent text,
  signed_portal_access_id text,
  -- Meta:
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One agreement per (tenant, partner) — updates mutate the same row so the
-- lifecycle (draft → pending_signature → signed) stays queryable.
CREATE UNIQUE INDEX IF NOT EXISTS uq_referral_agreements_partner
  ON public.referral_agreements (tenant_id, partner_id);
CREATE INDEX IF NOT EXISTS idx_referral_agreements_status
  ON public.referral_agreements (tenant_id, status);

-- ─── 3. referral_payout_accounts (partner bank details) ────────────────────
CREATE TABLE IF NOT EXISTS public.referral_payout_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  partner_id text NOT NULL,
  beneficiary_name text NOT NULL,
  bank_name text,
  -- IBAN stored ENCRYPTED (enc:… ciphertext, field-encryption module):
  iban_enc text NOT NULL,
  iban_masked text NOT NULL,              -- e.g. "DE89 •••• •••• •••• 3000" for lists
  iban_hmac text,                         -- equality lookup without decryption
  swift_bic text,
  account_currency text,
  country text,
  additional_instructions text,
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','verified','rejected')),
  verified_by text,
  verified_at timestamptz,
  -- Meta:
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_referral_payout_accounts_partner
  ON public.referral_payout_accounts (tenant_id, partner_id);
CREATE INDEX IF NOT EXISTS idx_referral_payout_accounts_status
  ON public.referral_payout_accounts (tenant_id, status);

-- ─── 4. portal_uploads: link uploads to a commission entry ─────────────────
--   Same pattern as migration 092 (rfq_id): the column is written ONLY by the
--   server (POST /api/portal/referrals/attachments links after validating
--   ownership), downloads reuse the existing permission-checked surfaces.
ALTER TABLE public.portal_uploads
  ADD COLUMN IF NOT EXISTS referral_id text;

CREATE INDEX IF NOT EXISTS idx_portal_uploads_referral
  ON public.portal_uploads (referral_id)
  WHERE referral_id IS NOT NULL AND deleted_at IS NULL;

--   The category CHECK constraint predates this migration and does not know
--   the new 'commission' category — extend it (drop + re-add, idempotent:
--   the re-add matches the exact target definition).
ALTER TABLE public.portal_uploads DROP CONSTRAINT IF EXISTS portal_uploads_category_check;
ALTER TABLE public.portal_uploads ADD CONSTRAINT portal_uploads_category_check
  CHECK (category = ANY (ARRAY['kyc'::text, 'rfq'::text, 'message'::text, 'general'::text, 'other'::text, 'commission'::text]));

-- ─── 5. Row-level security ─────────────────────────────────────────────────
--   Server-side only: the app talks to Supabase with the service-role key
--   (bypasses RLS), but RLS still guards direct anon/authenticated access.
ALTER TABLE public.referral_commissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_payout_accounts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'referral_commissions'
      AND policyname = 'svc_referral_commissions_all'
  ) THEN
    CREATE POLICY svc_referral_commissions_all ON public.referral_commissions
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'referral_agreements'
      AND policyname = 'svc_referral_agreements_all'
  ) THEN
    CREATE POLICY svc_referral_agreements_all ON public.referral_agreements
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'referral_payout_accounts'
      AND policyname = 'svc_referral_payout_accounts_all'
  ) THEN
    CREATE POLICY svc_referral_payout_accounts_all ON public.referral_payout_accounts
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ─── 6. Ops summary ────────────────────────────────────────────────────────
SELECT 'referral_commissions' AS table_name, count(*) AS rows FROM public.referral_commissions
UNION ALL SELECT 'referral_agreements', count(*) FROM public.referral_agreements
UNION ALL SELECT 'referral_payout_accounts', count(*) FROM public.referral_payout_accounts;
