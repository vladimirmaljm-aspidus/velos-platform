-- 092_portal_rfq_attachments.sql — RFQ attachments link
--
-- Purpose: portal clients can attach specification documents (PDF spec
-- sheets, photos, lab analyses, Excel quantity breakdowns…) to an RFQ at
-- submission time, so the sales team knows EXACTLY which specification
-- and how the client needs the goods.
--
-- Design notes:
--   * portal_uploads already exists (category 'rfq' was already an allowed
--     upload category — the rows just had no link to any RFQ). This
--     migration adds the missing link column: `rfq_id`.
--   * One upload belongs to at most one RFQ (a spec sheet is uploaded FOR
--     a specific request). Re-linking simply overwrites the column.
--   * The link is written exclusively by the server (POST /api/portal/rfqs),
--     which validates that every attachment_id belongs to the caller's
--     tenant + partner and is not soft-deleted BEFORE linking.
--   * Downloads reuse the two existing, permission-checked surfaces:
--       - portal side: /api/portal/attachments/[id]  (uploader's partner)
--       - admin  side: /api/portal-uploads/[id]/download (tenant admins)
--
-- Idempotent: safe to re-run.

ALTER TABLE public.portal_uploads
  ADD COLUMN IF NOT EXISTS rfq_id text;

-- Faster "attachments for these RFQs" joins in the list/detail endpoints.
CREATE INDEX IF NOT EXISTS idx_portal_uploads_rfq
  ON public.portal_uploads (rfq_id)
  WHERE rfq_id IS NOT NULL AND deleted_at IS NULL;

COMMENT ON COLUMN public.portal_uploads.rfq_id IS
  'FK-ish link to portal_rfqs.id — set server-side only when the RFQ is created (POST /api/portal/rfqs validates tenant+partner ownership of the upload row first).';
