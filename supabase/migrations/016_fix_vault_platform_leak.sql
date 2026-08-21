-- 016_fix_vault_platform_leak.sql
-- ============================================================================
-- CRITICAL FIX: vault_secrets platform-level rows (tenant_id IS NULL) were
-- readable by anon/authenticated because migration 014's SELECT policy was:
--   USING (tenant_id = current_setting('app.tenant_id', true) OR tenant_id IS NULL)
--
-- The `OR tenant_id IS NULL` clause means anon (who doesn't set app.tenant_id)
-- can read ALL platform-level secrets. While they're encrypted, exposing the
-- ciphertext to anon is still a leak.
--
-- This migration tightens the policy: platform-level secrets (tenant_id IS
-- NULL) are ONLY accessible to service_role (which bypasses RLS via
-- BYPASSRLS attribute). Regular tenants can only see their own tenant's
-- secrets.
-- ============================================================================

DROP POLICY IF EXISTS vault_secrets_tenant_select ON public.vault_secrets;
DROP POLICY IF EXISTS vault_secrets_tenant_insert ON public.vault_secrets;
DROP POLICY IF EXISTS vault_secrets_tenant_update ON public.vault_secrets;
DROP POLICY IF EXISTS vault_secrets_tenant_delete ON public.vault_secrets;

-- Tenant-scoped SELECT: ONLY the caller's own tenant. Platform-level
-- (tenant_id IS NULL) is invisible to anon/authenticated — service_role
-- bypasses RLS via BYPASSRLS so the app can still read them.
CREATE POLICY vault_secrets_tenant_select ON public.vault_secrets
  FOR SELECT USING (
    tenant_id = current_setting('app.tenant_id', true)
  );

CREATE POLICY vault_secrets_tenant_insert ON public.vault_secrets
  FOR INSERT WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
  );

CREATE POLICY vault_secrets_tenant_update ON public.vault_secrets
  FOR UPDATE USING (
    tenant_id = current_setting('app.tenant_id', true)
  ) WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
  );

CREATE POLICY vault_secrets_tenant_delete ON public.vault_secrets
  FOR DELETE USING (
    tenant_id = current_setting('app.tenant_id', true)
  );

COMMENT ON POLICY vault_secrets_tenant_select ON public.vault_secrets IS
  'Strict tenant isolation. Platform-level secrets (tenant_id IS NULL) are '
  'ONLY accessible via service_role (BYPASSRLS). Fixes anon leak of '
  'encrypted SMTP/Postmark tokens.';

-- Verify
SELECT tablename, policyname, cmd, qual FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'vault_secrets' ORDER BY cmd;
