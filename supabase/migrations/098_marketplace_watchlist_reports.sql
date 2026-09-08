-- 098_marketplace_watchlist_reports.sql — Marketplace watchlist + post reports
--
-- Purpose: two standard B2B-marketplace features that close the gap with
-- competitor platforms:
--
--   1. WATCHLIST — "bookmark / favourite" posts. Portal clients star
--      listings they care about and filter the feed to their watchlist.
--      One row per (partner, post); toggling deletes/re-creates.
--
--   2. POST REPORTS — every marketplace needs a report/abuse path. A
--      portal client can flag a post (scam, wrong category, counterfeit,
--      prohibited goods…). Reports land in a queue the platform team
--      reviews via the platform audit log; a report NEVER auto-changes
--      the post status (only admins can moderate via the existing
--      flagged-status machinery) so the feature cannot be abused to
--      silently take down competitors.
--
-- Security model: RLS is intentionally NOT enabled on these tables — the
-- entire marketplace data plane is service-role only (migration 076);
-- tenant/partner scoping is enforced in the API layer, matching every
-- other marketplace_* table.
--
-- Idempotent: safe to re-run.

-- ─── 1. marketplace_watchlist ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.marketplace_watchlist (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  partner_id  uuid NOT NULL,
  post_id     uuid NOT NULL REFERENCES public.marketplace_posts(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketplace_watchlist_partner_post_unique UNIQUE (partner_id, post_id)
);

CREATE INDEX IF NOT EXISTS idx_marketplace_watchlist_partner
  ON public.marketplace_watchlist (tenant_id, partner_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_watchlist_post
  ON public.marketplace_watchlist (post_id);

-- ─── 2. marketplace_post_reports ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.marketplace_post_reports (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  post_id              uuid NOT NULL REFERENCES public.marketplace_posts(id) ON DELETE CASCADE,
  reporter_partner_id  uuid NOT NULL,
  -- free-form reason from a closed list the client sends:
  --   scam | counterfeit | wrong_category | prohibited | misleading | other
  reason               text NOT NULL,
  details              text,
  status               text NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','reviewed','dismissed')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  reviewed_at          timestamptz,
  reviewed_by          text
);

CREATE INDEX IF NOT EXISTS idx_marketplace_post_reports_post
  ON public.marketplace_post_reports (post_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_post_reports_status
  ON public.marketplace_post_reports (tenant_id, status, created_at DESC);

-- One open report per (reporter, post) — a client may re-report after
-- their previous report was reviewed/dismissed, but cannot spam duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketplace_reports_open
  ON public.marketplace_post_reports (reporter_partner_id, post_id)
  WHERE status = 'open';

-- ─── 3. Verification ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'marketplace_watchlist') THEN
    RAISE NOTICE 'OK marketplace_watchlist present';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'marketplace_post_reports') THEN
    RAISE NOTICE 'OK marketplace_post_reports present';
  END IF;
END $$;
