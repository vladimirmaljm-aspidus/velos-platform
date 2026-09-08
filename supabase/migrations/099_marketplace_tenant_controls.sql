-- 099_marketplace_tenant_controls.sql — Marketplace tenant controls +
-- portal module permissions + watchlist type fix.
--
-- PART 1 — FIX (production error): migration 098 typed
--   marketplace_watchlist.tenant_id / partner_id and
--   marketplace_post_reports.tenant_id / reporter_partner_id as UUID,
--   but those ids are TEXT cuids in partners / portal_access /
--   marketplace_posts.tenant_id. Every watchlist call from a real portal
--   partner 500'd with `invalid input syntax for type uuid: "cxyz…"`
--   (error_logs, route [marketplace.watchlist.get]). Re-type to TEXT and
--   enable the same service_role-only RLS posture as migration 076.
--
-- PART 2 — MARKETPLACE TENANT CONTROLS: per-tenant marketplace policy the
--   super admin and the tenant admin manage together:
--     • enabled              — marketplace module on/off for the tenant
--     • posting_policy       — who may create posts (tier/KYC ladder)
--     • require_approval     — new posts land as status 'pending' until
--                              an admin approves them (approve → active)
--     • public_feed_enabled  — tenant's posts hidden from the anonymous
--                              cross-tenant public API when false
--     • default_visibility   — forced default visibility for new posts
--     • allow_private_posts  — private visibility selectable at all
--   The status CHECK on marketplace_posts gains 'pending' to support
--   moderated publishing.
--
-- PART 3 — PORTAL MODULE PERMISSIONS (per user + per tenant): every new
--   module added over the last months (marketplace, referrals/commissions,
--   messages, notifications, logistics, intelligence…) had NO access
--   control beyond authentication. This adds:
--     • portal_access.module_permissions JSONB  — per-USER overrides
--       { "marketplace": true, "marketplace.post": false, … }
--     • tenant_portal_defaults.modules JSONB    — per-TENANT defaults
--       applied when the user row has no explicit override.
--   Enforcement lives in src/lib/portal/module-permissions.ts (fail-open
--   to the legacy portal_access booleans for the 8 legacy modules).
--
-- Idempotent: safe to re-run.

-- ═══ PART 1 — Watchlist / reports type fix + RLS ═════════════════════════

DO $$
BEGIN
  -- marketplace_watchlist: tenant_id / partner_id uuid → text
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'marketplace_watchlist'
      AND column_name = 'partner_id' AND data_type = 'uuid'
  ) THEN
    ALTER TABLE public.marketplace_watchlist
      ALTER COLUMN tenant_id TYPE text USING tenant_id::text,
      ALTER COLUMN partner_id TYPE text USING partner_id::text;
    RAISE NOTICE '099: marketplace_watchlist re-typed uuid→text';
  END IF;

  -- marketplace_post_reports: tenant_id / reporter_partner_id uuid → text
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'marketplace_post_reports'
      AND column_name = 'reporter_partner_id' AND data_type = 'uuid'
  ) THEN
    ALTER TABLE public.marketplace_post_reports
      ALTER COLUMN tenant_id TYPE text USING tenant_id::text,
      ALTER COLUMN reporter_partner_id TYPE text USING reporter_partner_id::text;
    RAISE NOTICE '099: marketplace_post_reports re-typed uuid→text';
  END IF;
END $$;

-- RLS posture — service_role only, identical to migration 076 (the app
-- uses the service-role client; anon/authenticated stay locked out).
ALTER TABLE public.marketplace_watchlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_watchlist FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS marketplace_watchlist_service_role_all ON public.marketplace_watchlist;
CREATE POLICY marketplace_watchlist_service_role_all
  ON public.marketplace_watchlist
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE public.marketplace_post_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_post_reports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS marketplace_post_reports_service_role_all ON public.marketplace_post_reports;
CREATE POLICY marketplace_post_reports_service_role_all
  ON public.marketplace_post_reports
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ═══ PART 2 — Marketplace tenant settings ═════════════════════════════════

CREATE TABLE IF NOT EXISTS public.marketplace_tenant_settings (
  tenant_id          text PRIMARY KEY,
  -- Master switch: when false the marketplace module is hidden/blocked for
  -- every portal client of this tenant (403 code `marketplace_disabled`).
  enabled            boolean NOT NULL DEFAULT true,
  -- Who may create posts. 'kyc_verified' reproduces the previous global
  -- hardcoded policy (tier >= standard AND KYC approved). The ladder
  -- tightens or relaxes per tenant.
  posting_policy     text NOT NULL DEFAULT 'kyc_verified'
                     CHECK (posting_policy IN
                       ('all_active', 'kyc_verified', 'tier_standard',
                        'tier_business', 'tier_premium', 'admins_only')),
  -- Moderated publishing: new posts are created with status 'pending'
  -- and only appear in the feed after an admin approves (pending→active).
  require_approval   boolean NOT NULL DEFAULT false,
  -- When false, this tenant's posts are excluded from the anonymous
  -- cross-tenant public API (/api/marketplace/public).
  public_feed_enabled boolean NOT NULL DEFAULT true,
  -- Forced default visibility for newly created posts.
  default_visibility text NOT NULL DEFAULT 'public'
                     CHECK (default_visibility IN ('public', 'private')),
  -- When false the create form cannot select private visibility.
  allow_private_posts boolean NOT NULL DEFAULT true,
  updated_by         text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Seed a default row for every tenant that already has marketplace posts
-- (they keep today's behaviour: enabled, kyc_verified, public feed).
INSERT INTO public.marketplace_tenant_settings (tenant_id, enabled)
SELECT DISTINCT tenant_id, true FROM public.marketplace_posts
ON CONFLICT (tenant_id) DO NOTHING;

-- status CHECK gains 'pending' (moderated publishing). Idempotent: the
-- DO block only rewrites the constraint when 'pending' is not accepted.
DO $$
DECLARE
  current_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO current_def
  FROM pg_constraint
  WHERE conrelid = 'public.marketplace_posts'::regclass
    AND contype = 'c'
    AND conname = 'marketplace_posts_status_check';
  IF current_def IS NOT NULL AND current_def NOT ILIKE '%pending%' THEN
    EXECUTE 'ALTER TABLE public.marketplace_posts DROP CONSTRAINT marketplace_posts_status_check';
    EXECUTE 'ALTER TABLE public.marketplace_posts ADD CONSTRAINT marketplace_posts_status_check
               CHECK (status IN (''draft'',''pending'',''active'',''closed'',''expired'',''flagged'',''cancelled''))';
    RAISE NOTICE '099: marketplace_posts status CHECK extended with pending';
  END IF;
END $$;

-- ═══ PART 3 — Portal module permissions ══════════════════════════════════

-- Per-USER overrides on the portal identity row.
ALTER TABLE public.portal_access
  ADD COLUMN IF NOT EXISTS module_permissions jsonb DEFAULT NULL;

-- Per-TENANT defaults (applied when the user has no explicit override).
CREATE TABLE IF NOT EXISTS public.tenant_portal_defaults (
  tenant_id   text PRIMARY KEY,
  modules     jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ═══ VERIFICATION ═════════════════════════════════════════════════════════
DO $$
BEGIN
  RAISE NOTICE '099 verification';
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='marketplace_watchlist'
      AND column_name='partner_id' AND data_type <> 'text'
  ) THEN RAISE EXCEPTION 'FAIL: watchlist partner_id still not text'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='marketplace_tenant_settings'
  ) THEN RAISE EXCEPTION 'FAIL: marketplace_tenant_settings missing'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='portal_access'
      AND column_name='module_permissions'
  ) THEN RAISE EXCEPTION 'FAIL: portal_access.module_permissions missing'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='tenant_portal_defaults'
  ) THEN RAISE EXCEPTION 'FAIL: tenant_portal_defaults missing'; END IF;
  RAISE NOTICE '099 OK';
END $$;
