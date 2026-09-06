-- 091_portal_events.sql — PARTNER-360 activity intelligence
--
-- Purpose: per-partner event stream for the admin Partner 360 view
-- ("what did this partner view / search / download / buy on the marketplace").
--
-- Design notes:
--   * audit_logs already records portal.login / portal.location rows, and
--     offers/lois/invoices/proformas carry viewed_at + view_count columns —
--     those keep working unchanged and remain the source for login history.
--     portal_events captures the signals those structures CANNOT express:
--     catalog product views, marketplace browsing, per-partner searches,
--     downloads and marketplace actions.
--   * The API layer treats this table as OPTIONAL: every read/write is
--     wrapped in try/catch and degrades to an empty list / silent no-op
--     when the table is missing, so the platform keeps working before this
--     migration is applied.
--   * Written exclusively by the server (service role) — no client-supplied
--     tenant_id / partner_id: both are stamped from the portal session.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS public.portal_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         text NOT NULL,
  partner_id        text NOT NULL,
  portal_access_id  text,
  -- Event type vocabulary (server-generated only):
  --   login, login_failed, location,
  --   offer_viewed, loi_viewed, invoice_viewed, proforma_viewed,
  --   offer_downloaded, loi_downloaded, invoice_downloaded,
  --   proforma_downloaded, document_downloaded,
  --   catalog_product_viewed, catalog_search, marketplace_viewed,
  --   marketplace_search, marketplace_bid, marketplace_follow,
  --   rfq_created
  type              text NOT NULL,
  entity_type       text,
  entity_id         text,
  -- Human-readable one-liner shown in the 360 activity timeline
  -- (e.g. the product name or post title). Sanitised server-side.
  label             text,
  details           jsonb,
  ip                text,
  user_agent        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_portal_events_tenant
  ON public.portal_events (tenant_id);
CREATE INDEX IF NOT EXISTS idx_portal_events_partner_time
  ON public.portal_events (partner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_portal_events_type
  ON public.portal_events (tenant_id, type);

-- Row size guard: the timeline API caps at the most recent 500 rows per
-- partner; the details blob is small (search terms, GPS accuracy, prices).
COMMENT ON TABLE public.portal_events IS
  'Partner activity events for the Partner 360 admin view. Written server-side only from portal sessions; optional table — API degrades gracefully when absent.';
