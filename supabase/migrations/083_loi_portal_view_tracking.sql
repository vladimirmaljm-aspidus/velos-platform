-- 083_loi_portal_view_tracking.sql
-- ============================================================================
-- VELOS — LOI portal visibility (BUILD-LOI-PORTAL).
--
-- Background
-- ----------
-- LOIs exist in the admin app (create / send / PDF) since migrations
-- 064–066, but the CLIENT PORTAL had no LOI module at all — a partner who
-- received a Letter of Intent by email had nowhere to see it, download it
-- or respond to it in the portal.
--
-- This migration adds the same view-tracking columns that offers /
-- invoices / proformas already carry, so the new portal LOI endpoints can:
--   • stamp viewed_at ONCE on the first open (detail sheet or PDF)
--   • record viewed_by_email (the portal_access email, decrypted app-side)
--   • increment view_count on every open
--
-- NOTE — status semantics: unlike proformas, the LOI state machine has NO
-- "viewed" status (draft | sent | accepted | rejected | expired |
-- cancelled). Viewing an LOI therefore leaves the status at "sent"; the
-- mark-viewed helper skips the status promotion for the lois table.
-- ============================================================================

ALTER TABLE public.lois
  ADD COLUMN IF NOT EXISTS viewed_at timestamptz;

ALTER TABLE public.lois
  ADD COLUMN IF NOT EXISTS viewed_by_email text;

ALTER TABLE public.lois
  ADD COLUMN IF NOT EXISTS view_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.lois.viewed_at IS
  'First time the portal partner opened this LOI (detail sheet or PDF). Set once; never overwritten.';
COMMENT ON COLUMN public.lois.viewed_by_email IS
  'portal_access.portal_email of the most recent viewer (stored decrypted by the app).';
COMMENT ON COLUMN public.lois.view_count IS
  'Total number of portal opens (detail sheet + PDF downloads).';

CREATE INDEX IF NOT EXISTS lois_viewed_at_idx
  ON public.lois (tenant_id, viewed_at DESC)
  WHERE viewed_at IS NOT NULL;
