-- 079_proforma_created_by.sql
-- ============================================================================
-- AUDIT18: add `created_by` column to proformas (SoD parity with invoices).
--
-- Background
-- ----------
-- audit17 added the Separation-of-Duties check ("the creator of a finance
-- document cannot send/approve it") to /api/invoices/[id]/send (created_by,
-- migration 040) and /api/offers/[id]/send (owner_id). The proforma send
-- route was missed: a proforma's creator could still send (= approve) their
-- own proforma, bypassing the SoD matrix that invoices and offers enforce.
--
-- The proformas table has no created_by / owner_id column (verified against
-- production information_schema), so the SoD check could not even be
-- implemented. This migration mirrors migration 040 exactly: nullable column
-- + best-effort backfill from audit_logs (rows without an audit trail stay
-- NULL → the SoD check fails open for legacy rows, same as invoices).
--
-- After this migration:
--   • POST /api/proformas sets `created_by = auth.user.id`.
--   • POST /api/proformas/[id]/send runs assertNoSoDViolation against
--     proforma.created_by (parity with the invoice send route).
-- ============================================================================

ALTER TABLE public.proformas
  ADD COLUMN IF NOT EXISTS created_by UUID;

-- ─── Backfill from audit_logs (first proforma.create entry per proforma) ──
UPDATE public.proformas pro
SET created_by = (
  SELECT a.user_id::uuid
  FROM public.audit_logs a
  WHERE a.action = 'proforma.create'
    AND a.entity_type = 'proforma'
    AND a.entity_id = pro.id
    AND a.user_id IS NOT NULL
  ORDER BY a.created_at ASC
  LIMIT 1
)
WHERE pro.created_by IS NULL;

-- ─── Index for "list proformas by creator" queries ────────────────────────
CREATE INDEX IF NOT EXISTS proformas_created_by_idx
  ON public.proformas (created_by)
  WHERE created_by IS NOT NULL;

-- RLS: the column is tenant-row metadata; the existing per-table RLS
-- policies already cover row access — no new policy needed for a nullable
-- UUID column that never carries cross-tenant references.
