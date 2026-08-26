-- 060_enable_rls_missing_tables.sql
-- ============================================================================
-- SEC-DEEP / CRITICAL — enable RLS on the 14 public-schema tables that
-- were missing it. Defense-in-depth: the app uses the service_role key which
-- BYPASSES RLS (see src/lib/supabase/client.ts), so these policies protect
-- against anon/authenticated access via the anon key (browser leak,
-- Supabase Studio access, future code paths that use the anon client).
--
-- The 14 tables (per SEC-DEEP task brief):
--   1.  app_config                           — platform-level config (cron_token etc.)
--   2.  marketplace_answers                   — partner-scoped Q&A (NO tenant_id)
--   3.  marketplace_blog_posts                — partner-scoped blog (NO tenant_id)
--   4.  marketplace_carbon_offsets            — partner-scoped offsets (NO tenant_id)
--   5.  marketplace_esg_scores                — partner-scoped ESG (NO tenant_id)
--   6.  marketplace_event_registrations       — partner-scoped event reg (NO tenant_id)
--   7.  marketplace_events                    — partner-scoped events (NO tenant_id)
--   8.  marketplace_group_members             — partner-scoped group mem (NO tenant_id)
--   9.  marketplace_groups                    — community groups (NO tenant_id, public catalog)
--   10. marketplace_questions                 — partner-scoped Q&A (NO tenant_id)
--   11. marketplace_sustainability_certs     — partner-scoped certs (NO tenant_id)
--   12. module_groups                        — platform-level static reference data
--   13. plans                                — platform-level subscription plan catalog
--   14. tenant_role_overrides                — tenant-scoped role permission overrides
--
-- POLICY CHOICE
--   The task brief suggested using the `tenant_id = current_setting('app.tenant_id', true)`
--   pattern (mirroring migration 001) for the tenant-scoped tables. That pattern
--   only works for tables that HAVE a `tenant_id` column.
--
--   Reality check on the schema (verified against migrations 036/039/051/052):
--     • `tenant_role_overrides` HAS `tenant_id UUID NOT NULL`.
--     • `app_config`, `plans`, `module_groups` are platform-level (no tenant_id
--       by design — these are the global catalog / cron-token store).
--     • ALL ten `marketplace_*` tables in this list use `partner_id`, NOT
--       `tenant_id` — they are partner-scoped, not tenant-scoped (see
--       migration 051_marketplace_community.sql + 052_marketplace_esg.sql).
--       The marketplace community model intentionally lets partners across
--       different tenants interact in the same groups/Q&A/events surface.
--       So we cannot use a `tenant_id = current_setting(...)` policy here.
--
--   Decision matrix:
--     • `tenant_role_overrides` — preserve the service_role-only policy from
--       migration 039 (which already enabled RLS). The DROP IF EXISTS + re-
--       CREATE is idempotent and matches the existing posture.
--     • `marketplace_*` tables (partner-scoped, no tenant_id) — service_role
--       only. Denies anon/authenticated direct access; the API layer enforces
--       partner ownership. Mirrors migration 039's tenant_role_overrides
--       posture. Strongest defense-in-depth because the app uses
--       service_role exclusively for these tables.
--     • `app_config`, `plans`, `module_groups` (platform-level) — enable
--       RLS with no permissive policy. Default-deny for anon/authenticated;
--       service_role bypasses. (Task brief's exact spec.)
--
-- IDEMPOTENCY
--   • `ALTER TABLE … ENABLE ROW LEVEL SECURITY` is a no-op if RLS is already
--     enabled — safe to re-run.
--   • `DROP POLICY IF EXISTS …` before each `CREATE POLICY` — safe to re-run.
--   • Tables are introspected via `to_regclass` so the migration is a no-op
--     for tables that don't exist yet on a given DB snapshot.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Step 1 — tenant_role_overrides (HAS tenant_id, preserves migration 039's
-- service_role-only policy). Idempotent re-enable + policy refresh.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.tenant_role_overrides') IS NOT NULL THEN
    ALTER TABLE public.tenant_role_overrides ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_role_overrides_service_all ON public.tenant_role_overrides;
    CREATE POLICY tenant_role_overrides_service_all ON public.tenant_role_overrides
      FOR ALL
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
    RAISE NOTICE 'Enabled RLS + service_role-only policy on tenant_role_overrides';
  ELSE
    RAISE NOTICE 'Skipping tenant_role_overrides (table does not exist)';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- Step 2 — marketplace_* community + ESG tables (partner-scoped, NO tenant_id).
-- Service_role-only policy: denies anon/authenticated direct access; the
-- API layer (requireAuth / getPortalSessionAccess) is the real isolation
-- gate. Service_role bypasses RLS so the app's service-role client keeps
-- working unchanged.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t TEXT;
  marketplace_tables TEXT[] := ARRAY[
    'marketplace_groups',
    'marketplace_group_members',
    'marketplace_questions',
    'marketplace_answers',
    'marketplace_events',
    'marketplace_event_registrations',
    'marketplace_blog_posts',
    'marketplace_esg_scores',
    'marketplace_sustainability_certs',
    'marketplace_carbon_offsets'
  ];
BEGIN
  FOREACH t IN ARRAY marketplace_tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'Skipping % (table does not exist)', t;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_service_role_all', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I
      FOR ALL
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role')
    $f$, t || '_service_role_all', t);
    RAISE NOTICE 'Enabled RLS + service_role-only policy on %', t;
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Step 3 — platform-level tables (app_config, plans, module_groups).
-- Per the task brief: enable RLS, no policy created — anon/authenticated get
-- no access by default. Service role (used by the app) bypasses RLS.
-- Existing REVOKE statements from migration 036 already lock app_config down
-- at the GRANT level; this RLS layer is the second line of defense.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t TEXT;
  platform_tables TEXT[] := ARRAY['app_config', 'plans', 'module_groups'];
BEGIN
  FOREACH t IN ARRAY platform_tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'Skipping % (table does not exist)', t;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- Intentionally NO policy created: default-deny for anon/authenticated.
    -- Service role bypasses RLS so the app's service-role client keeps
    -- full read/write access. The API layer (requireSuperAdmin /
    -- requirePermission) is the real auth gate.
    RAISE NOTICE 'Enabled RLS (default-deny) on %', t;
  END LOOP;
END $$;

-- ============================================================================
-- VERIFICATION QUERIES (run in Supabase Studio → SQL Editor)
-- ============================================================================

-- 1. Confirm RLS is enabled on all 14 tables.
-- SELECT relname, relrowsecurity
-- FROM pg_class
-- WHERE relnamespace = 'public'::regnamespace
--   AND relkind = 'r'
--   AND relname IN (
--     'app_config','marketplace_answers','marketplace_blog_posts',
--     'marketplace_carbon_offsets','marketplace_esg_scores',
--     'marketplace_event_registrations','marketplace_events',
--     'marketplace_group_members','marketplace_groups',
--     'marketplace_questions','marketplace_sustainability_certs',
--     'module_groups','plans','tenant_role_overrides'
--   )
-- ORDER BY relname;
-- Expected: relrowsecurity = true for every row.

-- 2. List policies on the 14 tables (should be exactly 1 service_role-only
--    policy on each marketplace_* + tenant_role_overrides; zero policies
--    on app_config / plans / module_groups).
-- SELECT tablename, policyname, cmd, qual
-- FROM pg_policies
-- WHERE schemaname = 'public'
--   AND tablename IN (
--     'app_config','marketplace_answers','marketplace_blog_posts',
--     'marketplace_carbon_offsets','marketplace_esg_scores',
--     'marketplace_event_registrations','marketplace_events',
--     'marketplace_group_members','marketplace_groups',
--     'marketplace_questions','marketplace_sustainability_certs',
--     'module_groups','plans','tenant_role_overrides'
--   )
-- ORDER BY tablename, policyname;
