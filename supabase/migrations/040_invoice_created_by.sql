-- 040_invoice_created_by.sql
-- ============================================================================
-- Add `created_by` column to invoices (P1-1 / Feature 2 — SoD matrix).
--
-- Background
-- ----------
-- Separation-of-Duties (SoD) check for the invoice approval flow requires
-- knowing WHO created the invoice being approved (sent). The invoices
-- table previously had no `created_by` / `owner_id` column — the audit
-- comment in migration 002_add_rpc_functions.sql explicitly notes
-- "invoices has no owner_id column". The creator was only recoverable
-- by joining against audit_logs (action='invoice.create', entity_id),
-- which is slow and fragile (audit_logs is append-only per migration
-- 010 but the join semantics drift if the action string changes).
--
-- This migration adds the column nullable so existing rows are not
-- blocked, and backfills it from audit_logs (best-effort — rows that
-- have no audit trail stay NULL, which the SoD check interprets as
-- "fail open" — do not block a legacy-row approval).
--
-- After this migration:
--   • POST /api/invoices sets `created_by = auth.user.id`.
--   • PUT /api/invoices/[id] consults `existing.created_by` for the
--     SoD check (creator === approver → 403 unless super_admin).
-- ============================================================================

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS created_by UUID;

-- ─── Backfill from audit_logs ───────────────────────────────────────────────
-- Find the FIRST invoice.create audit entry for each invoice (the
-- earliest = the original creator — a later invoice.create audit entry
-- would be a revision / re-creation by a different user, which we
-- don't want to attribute). Uses DISTINCT ON for Postgres-friendly
-- "first row per group" semantics.
UPDATE public.invoices inv
SET created_by = (
  SELECT a.user_id
  FROM public.audit_logs a
  WHERE a.action = 'invoice.create'
    AND a.entity_type = 'invoice'
    AND a.entity_id = inv.id
    AND a.user_id IS NOT NULL
  ORDER BY a.created_at ASC
  LIMIT 1
)
WHERE inv.created_by IS NULL;

-- ─── Index for "list invoices by creator" queries ─────────────────────────
CREATE INDEX IF NOT EXISTS invoices_created_by_idx
  ON public.invoices (tenant_id, created_by)
  WHERE created_by IS NOT NULL;

-- ─── Verify ────────────────────────────────────────────────────────────────
SELECT
  COUNT(*) AS total_invoices,
  COUNT(*) FILTER (WHERE created_by IS NOT NULL) AS with_creator,
  COUNT(*) FILTER (WHERE created_by IS NULL) AS without_creator
FROM public.invoices;
