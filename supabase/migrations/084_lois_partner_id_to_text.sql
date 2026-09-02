-- 084_lois_partner_id_to_text.sql
-- ============================================================================
-- VELOS — Fix lois.partner_id type mismatch (P0, "LOI not visible in portal").
--
-- Problem
-- -------
-- The `lois` table shipped in 064 with `partner_id uuid NOT NULL`. But
-- `public.partners.id` is TEXT — partner ids are generated app-side and are
-- a MIX of cuids (e.g. "mri8tmtfi8nirc") and legacy UUIDs. Every sibling
-- document table already stores partner_id as text:
--     offers.partner_id        text
--     proformas.partner_id     text
--     invoices.partner_id      text
--     document_register.partner_id  text
-- Only `lois` is uuid.
--
-- Consequence: for any partner whose id is a cuid (the majority of real
-- partners, incl. Aspidus DMCC "mri8tmtfi8nirc"):
--   • GET /api/portal/lois?partner_id=<cuid> → Postgres 22P02
--     "invalid input syntax for type uuid" → HTTP 500 → the client sees NO
--     LOIs in the portal (exactly the reported bug: "we added LOI but the
--     client still can't see it in the portal").
--   • Admin-side LOI creation for such partners fails the same way
--     (INSERT with a non-uuid partner_id is rejected by PostgREST).
--
-- Fix
-- ---
-- Widen the column to text, matching every other partner-referencing table.
-- `USING partner_id::text` keeps existing (uuid) rows readable — a UUID
-- value casts to its canonical lowercase text form, which is exactly how
-- those same ids already appear in offers/proformas/invoices.
--
-- No FK exists on lois.partner_id (verified on production: only lois_pkey),
-- so the ALTER needs no DROP CONSTRAINT. Postgres rebuilds the dependent
-- index (lois_partner_id_idx) automatically as part of the type change.
--
-- Existing RLS policies / grants / triggers are column-type agnostic
-- (they only reference tenant_id / id), so they are untouched.
-- ============================================================================

-- 1) Widen partner_id uuid → text (idempotent guard: skip if already text).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name  = 'lois'
      AND column_name = 'partner_id'
      AND data_type   = 'uuid'
  ) THEN
    ALTER TABLE public.lois
      ALTER COLUMN partner_id TYPE text USING partner_id::text;
    RAISE NOTICE 'lois.partner_id widened uuid -> text';
  ELSE
    RAISE NOTICE 'lois.partner_id is already % — nothing to do',
      (SELECT data_type FROM information_schema.columns
       WHERE table_schema='public' AND table_name='lois' AND column_name='partner_id');
  END IF;
END
$$;

-- 2) Defensive re-check of the helper index (Postgres recreates it during the
--    ALTER; this is a no-op IF NOT EXISTS so it also covers deployments where
--    the index was somehow dropped).
CREATE INDEX IF NOT EXISTS lois_partner_id_idx ON public.lois (partner_id);
