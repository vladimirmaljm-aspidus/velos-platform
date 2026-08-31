-- 077_mail_queue_entity_ref.sql
-- ============================================================================
-- AUDIT16 — mail_queue entity reference columns.
--
-- Background
-- ----------
-- The mail-queue Retry endpoint re-sends the stored subject/body to the
-- stored recipient. For document emails (invoice / proforma / offer / LOI)
-- the original PDF attachment was generated in-memory at send time and is
-- NOT persisted — a retried document email went out saying
-- "Please find attached …" with NO attachment.
--
-- Fix: nullable `entity_type` + `entity_id` columns on mail_queue. The
-- document send routes persist them (via sendEmail opts → upsertMailQueueEntry)
-- and the Retry endpoint regenerates the PDF from the reference before
-- re-sending. Rows written before this migration have NULLs — retry keeps
-- the legacy behaviour (plain re-send, no attachment) for those.
--
-- Safety: pure additive ALTER TABLE … ADD COLUMN IF NOT EXISTS (nullable,
-- no defaults, no locks beyond a brief ACCESS EXCLUSIVE on mail_queue which
-- is a low-traffic admin table). RLS policies unchanged (columns are only
-- visible through the existing tenant-scoped service-role queries).
-- ============================================================================

ALTER TABLE mail_queue
  ADD COLUMN IF NOT EXISTS entity_type text,
  ADD COLUMN IF NOT EXISTS entity_id text;

COMMENT ON COLUMN mail_queue.entity_type IS 'AUDIT16: business doc type (invoice/proforma/offer/loi) so Retry can regenerate the PDF attachment';
COMMENT ON COLUMN mail_queue.entity_id   IS 'AUDIT16: business doc id for attachment regeneration on retry';

-- Optional helper index: an admin filtering the queue by document
-- (e.g. "all failed emails for invoice X"). Cheap on this table size.
CREATE INDEX IF NOT EXISTS idx_mail_queue_entity
  ON mail_queue (entity_type, entity_id)
  WHERE entity_id IS NOT NULL;
