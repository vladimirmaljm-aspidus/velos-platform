-- 001_fix_rls_policies.sql
-- ============================================================================
-- Fix CRIT-3: Replace permissive USING(true) RLS policies with tenant-scoped
-- policies that check `tenant_id = current_setting('app.tenant_id', true)`.
--
-- CONTEXT
--   The app uses the service_role key (src/lib/supabase/client.ts:29) which
--   BYPASSES RLS entirely. Therefore these policies are DEFENSE-IN-DEPTH:
--     * They block anon-key access to tenant-scoped tables (which is desired
--       because the app does not set app.tenant_id on the anon client).
--     * They protect against direct DB / Supabase Studio access.
--   The app will continue to use service_role for the primary isolation path
--   (which is enforced in src/app/api/**/route.ts).
--
-- IDEMPOTENCY
--   * Uses `IF to_regclass(...) IS NOT NULL` so tables that don't exist on the
--     current DB snapshot are skipped (the production snapshot differs from
--     the dev supabase-schema.sql — e.g. portal_messages, quick_notes,
--     saved_filters exist only in some environments).
--   * Drops ALL existing policies on each table via pg_policies introspection
--     (not a hard-coded list), so re-running never fails on DROP POLICY.
--   * Checks information_schema.columns for tenant_id before creating a
--     policy, so tables without tenant_id are skipped with a NOTICE.
--   * Safe to run multiple times.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Step 1: ENABLE ROW LEVEL SECURITY on every known tenant-scoped table.
-- Missing tables are silently skipped.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t TEXT;
  tenant_tables TEXT[] := ARRAY[
    'products', 'partners', 'deals', 'offers', 'demands',
    'invoices', 'proformas', 'shared_documents', 'user_tasks',
    'inventory_movements', 'entity_notes', 'vault_secrets',
    'api_keys', 'webhooks', 'mail_queue', 'audit_logs',
    'settings', 'document_register', 'document_revisions',
    'document_templates', 'document_verifications',
    'portal_access', 'portal_rfqs', 'portal_messages', 'portal_uploads',
    'kyc_submissions', 'logistics_requests', 'logistics_events',
    'trade_calculations', 'supplier_offers', 'product_catalog',
    'commission_agents', 'deal_commissions', 'commission_payouts',
    'erp_accounts', 'erp_journal_entries', 'erp_journal_lines',
    'erp_bank_accounts', 'erp_bank_transactions', 'erp_cost_centers',
    'erp_settings', 'fiscal_periods', 'tenant_letterheads', 'tenant_seals',
    'feature_flags', 'plan_upgrade_requests', 'notifications',
    'quick_notes', 'saved_filters', 'user_preferences', 'sessions',
    'login_history', 'known_ips', 'trusted_devices',
    'password_resets', 'verification_logs'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      RAISE NOTICE 'Enabled RLS on %', t;
    ELSE
      RAISE NOTICE 'Skipping % (table does not exist)', t;
    END IF;
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Step 2: DROP every existing policy on each tenant-scoped table.
-- We introspect pg_policies so we don't depend on knowing the old policy
-- names (the legacy schema used names like "Enable select for all",
-- "<table>_all", "enable_select", etc.).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t TEXT;
  rec RECORD;
  tenant_tables TEXT[] := ARRAY[
    'products', 'partners', 'deals', 'offers', 'demands',
    'invoices', 'proformas', 'shared_documents', 'user_tasks',
    'inventory_movements', 'entity_notes', 'vault_secrets',
    'api_keys', 'webhooks', 'mail_queue', 'audit_logs',
    'settings', 'document_register', 'document_revisions',
    'document_templates', 'document_verifications',
    'portal_access', 'portal_rfqs', 'portal_messages', 'portal_uploads',
    'kyc_submissions', 'logistics_requests', 'logistics_events',
    'trade_calculations', 'supplier_offers', 'product_catalog',
    'commission_agents', 'deal_commissions', 'commission_payouts',
    'erp_accounts', 'erp_journal_entries', 'erp_journal_lines',
    'erp_bank_accounts', 'erp_bank_transactions', 'erp_cost_centers',
    'erp_settings', 'fiscal_periods', 'tenant_letterheads', 'tenant_seals',
    'feature_flags', 'plan_upgrade_requests', 'notifications',
    'quick_notes', 'saved_filters', 'user_preferences', 'sessions',
    'login_history', 'known_ips', 'trusted_devices',
    'password_resets', 'verification_logs'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    FOR rec IN
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', rec.policyname, t);
      RAISE NOTICE 'Dropped policy % on %', rec.policyname, t;
    END LOOP;
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Step 3: CREATE tenant-scoped policy on each table.
--
-- For tables with `tenant_id NOT NULL` (the common case):
--   USING (tenant_id = current_setting('app.tenant_id', true))
--   WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
--   -> When app.tenant_id is unset, current_setting(..., true) returns '' (empty
--      string) which never matches a UUID tenant_id -> access DENIED. This is
--      the desired behavior for anon-key access (the app does not set the
--      setting on the anon client today).
--
-- For tables with `tenant_id` NULLABLE (audit_logs, mail_queue, settings,
--   password_resets, verification_logs): also allow NULL tenant_id rows
--   (system-level audit entries that are not tied to a specific tenant).
--
-- We verify the tenant_id column actually exists before creating the policy;
-- tables without tenant_id are skipped with a NOTICE (e.g. some shared
-- reference tables may have been added without a tenant_id column).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t TEXT;
  has_tenant_col BOOLEAN;
  not_null_tables TEXT[] := ARRAY[
    'products', 'partners', 'deals', 'offers', 'demands',
    'invoices', 'proformas', 'shared_documents', 'user_tasks',
    'inventory_movements', 'entity_notes', 'vault_secrets',
    'api_keys', 'webhooks', 'document_register', 'document_revisions',
    'document_templates', 'document_verifications',
    'portal_access', 'portal_rfqs', 'portal_messages', 'portal_uploads',
    'kyc_submissions', 'logistics_requests', 'logistics_events',
    'trade_calculations', 'supplier_offers', 'product_catalog',
    'commission_agents', 'deal_commissions', 'commission_payouts',
    'erp_accounts', 'erp_journal_entries', 'erp_journal_lines',
    'erp_bank_accounts', 'erp_bank_transactions', 'erp_cost_centers',
    'erp_settings', 'fiscal_periods', 'tenant_letterheads', 'tenant_seals',
    'feature_flags', 'plan_upgrade_requests', 'notifications',
    'quick_notes', 'user_preferences', 'sessions',
    'login_history', 'known_ips', 'trusted_devices'
  ];
  nullable_tables TEXT[] := ARRAY[
    'audit_logs', 'mail_queue', 'settings', 'password_resets', 'verification_logs'
  ];
BEGIN
  FOREACH t IN ARRAY not_null_tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'tenant_id'
    ) INTO has_tenant_col;
    IF NOT has_tenant_col THEN
      RAISE NOTICE 'Skipping %: no tenant_id column', t;
      CONTINUE;
    END IF;
    -- Drop our own policy first (so re-running is idempotent)
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolated', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I
      FOR ALL
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
    $f$, t || '_tenant_isolated', t);
    RAISE NOTICE 'Created tenant_isolated policy on %', t;
  END LOOP;

  FOREACH t IN ARRAY nullable_tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'tenant_id'
    ) INTO has_tenant_col;
    IF NOT has_tenant_col THEN
      RAISE NOTICE 'Skipping %: no tenant_id column', t;
      CONTINUE;
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolated', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I
      FOR ALL
      USING (tenant_id IS NULL OR tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id IS NULL OR tenant_id = current_setting('app.tenant_id', true))
    $f$, t || '_tenant_isolated', t);
    RAISE NOTICE 'Created tenant_isolated (nullable) policy on %', t;
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Notes on tables intentionally LEFT PUBLIC (no strict RLS):
--   * tenants      — public catalog of tenant names (used at login)
--   * plans        — public catalog of subscription plans
--   * users        — auth-related; handled separately (auth.uid() not wired here)
--   * module_groups — static reference data
-- These are intentionally NOT in the tenant_tables list above.
--
-- The app uses service_role which BYPASSES RLS entirely. If the app ever
-- switches to anon-key auth, it MUST set `SET app.tenant_id = '<uuid>'`
-- before any tenant-scoped query (not currently planned).
-- ----------------------------------------------------------------------------

-- ============================================================================
-- VERIFICATION QUERIES (run manually in Supabase Studio → SQL Editor)
-- ============================================================================

-- 1. List all policies. Expected: each tenant-scoped table has exactly one
--    policy named "<table>_tenant_isolated" with FOR ALL and the
--    tenant_id = current_setting(...) USING clause.
-- SELECT tablename, policyname, cmd, qual, with_check
-- FROM pg_policies
-- WHERE schemaname = 'public'
-- ORDER BY tablename, policyname;

-- 2. Count of policies per table (sanity check — should be 1 per table).
-- SELECT tablename, COUNT(*) AS policy_count
-- FROM pg_policies
-- WHERE schemaname = 'public'
-- GROUP BY tablename
-- ORDER BY tablename;

-- 3. Confirm RLS is enabled on every tenant-scoped table.
-- SELECT relname, relrowsecurity
-- FROM pg_class
-- WHERE relnamespace = 'public'::regnamespace
--   AND relkind = 'r'
--   AND relrowsecurity = true
-- ORDER BY relname;
