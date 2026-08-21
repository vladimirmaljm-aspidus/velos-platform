-- 014_vault_tenant_nullable.sql
-- ============================================================================
-- Allow platform-level vault secrets (tenant_id IS NULL).
--
-- The vault_secrets table was created with tenant_id NOT NULL, but some
-- secrets are platform-level (SMTP password, Postmark token) and don't
-- belong to a specific tenant. This migration makes tenant_id nullable
-- and adds a policy that allows service_role to read platform-level secrets.
-- ============================================================================

-- Make tenant_id nullable
ALTER TABLE public.vault_secrets ALTER COLUMN tenant_id DROP NOT NULL;

-- Drop existing policies and recreate with NULL support
DROP POLICY IF EXISTS vault_secrets_tenant_select ON public.vault_secrets;
DROP POLICY IF EXISTS vault_secrets_tenant_insert ON public.vault_secrets;
DROP POLICY IF EXISTS vault_secrets_tenant_update ON public.vault_secrets;
DROP POLICY IF EXISTS vault_secrets_tenant_delete ON public.vault_secrets;

-- Tenant-scoped SELECT: tenants see their own secrets + platform-level (NULL)
CREATE POLICY vault_secrets_tenant_select ON public.vault_secrets
  FOR SELECT USING (
    tenant_id = current_setting('app.tenant_id', true)
    OR tenant_id IS NULL
  );

CREATE POLICY vault_secrets_tenant_insert ON public.vault_secrets
  FOR INSERT WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    OR tenant_id IS NULL
  );

CREATE POLICY vault_secrets_tenant_update ON public.vault_secrets
  FOR UPDATE USING (
    tenant_id = current_setting('app.tenant_id', true)
    OR tenant_id IS NULL
  ) WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    OR tenant_id IS NULL
  );

CREATE POLICY vault_secrets_tenant_delete ON public.vault_secrets
  FOR DELETE USING (
    tenant_id = current_setting('app.tenant_id', true)
    OR tenant_id IS NULL
  );

COMMENT ON POLICY vault_secrets_tenant_select ON public.vault_secrets IS
  'Tenants can see their own secrets + platform-level (tenant_id IS NULL). '
  'Service_role bypasses via BYPASSRLS.';

-- Verify
SELECT column_name, is_nullable FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'vault_secrets' AND column_name = 'tenant_id';
