-- 009_fix_critical_rls.sql
-- ============================================================================
-- CRITICAL SECURITY FIX — addresses audit findings B-1 through B-5.
--
-- The `service_role_all` policy on `users` and `tenants` had
-- `polroles = {public}` (applies to ALL roles including anon) with
-- `USING(true) WITH CHECK(true)`, completely overriding the tenant-isolated
-- policies. Anon could read password hashes, modify users, read bank IBANs,
-- and delete tenant records.
--
-- The `(tenant_id IS NULL OR ...)` pattern on `settings`, `mail_queue`, and
-- `audit_logs` exposed platform-level rows (tenant_id IS NULL) to anon —
-- leaking SMTP passwords, portal-setup tokens, and audit log entries.
--
-- This migration:
-- 1. Drops the over-permissive `service_role_all` policies.
-- 2. Replaces `(tenant_id IS NULL OR ...)` with strict tenant isolation.
-- 3. Service_role retains access via BYPASSRLS attribute (not via policy).
-- 4. Platform-level rows (tenant_id IS NULL) are now ONLY accessible to
--    service_role — anon/authenticated get nothing from them.
-- ============================================================================

-- ─── 1. users table — drop the PUBLIC policy that leaked password hashes ──
DROP POLICY IF EXISTS service_role_all ON public.users;
DROP POLICY IF EXISTS users_tenant_select ON public.users;
DROP POLICY IF EXISTS users_tenant_insert ON public.users;
DROP POLICY IF EXISTS users_tenant_update ON public.users;
DROP POLICY IF EXISTS users_tenant_delete ON public.users;

-- Tenant-isolated SELECT: users can only see users in their own tenant.
-- Super_admin (tenant_id IS NULL) users are invisible to regular tenants.
CREATE POLICY users_tenant_select ON public.users
  FOR SELECT USING (
    tenant_id = current_setting('app.tenant_id', true)
  );

-- Tenant-isolated INSERT: new user's tenant_id must match the caller's.
CREATE POLICY users_tenant_insert ON public.users
  FOR INSERT WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
  );

-- Tenant-isolated UPDATE: can only update users in own tenant; cannot
-- change tenant_id to a different tenant.
CREATE POLICY users_tenant_update ON public.users
  FOR UPDATE USING (
    tenant_id = current_setting('app.tenant_id', true)
  ) WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
  );

-- Tenant-isolated DELETE: can only delete users in own tenant.
CREATE POLICY users_tenant_delete ON public.users
  FOR DELETE USING (
    tenant_id = current_setting('app.tenant_id', true)
  );

COMMENT ON POLICY users_tenant_select ON public.users IS
  'Tenant-isolated SELECT. Service_role bypasses RLS via BYPASSRLS attribute. '
  'Platform-level users (tenant_id IS NULL, i.e. super_admins) are invisible '
  'to regular tenants — only service_role can read them.';

-- ─── 2. tenants table — drop the PUBLIC policy that leaked bank details ────
DROP POLICY IF EXISTS service_role_all ON public.tenants;
DROP POLICY IF EXISTS tenants_tenant_select ON public.tenants;

-- Tenants can only see their OWN tenant record.
-- The app sets app.tenant_id = the user's tenant_id at request start.
CREATE POLICY tenants_tenant_select ON public.tenants
  FOR SELECT USING (
    id = current_setting('app.tenant_id', true)
  );

-- Tenants can UPDATE their own record (settings, branding, bank details).
CREATE POLICY tenants_tenant_update ON public.tenants
  FOR UPDATE USING (
    id = current_setting('app.tenant_id', true)
  ) WITH CHECK (
    id = current_setting('app.tenant_id', true)
  );

-- No INSERT/DELETE for regular roles — only service_role (via BYPASSRLS)
-- can create/delete tenants (super-admin platform operations).

COMMENT ON POLICY tenants_tenant_select ON public.tenants IS
  'Tenants can only see their own record. Service_role bypasses for '
  'super-admin platform operations.';

-- ─── 3. settings table — fix the (tenant_id IS NULL OR ...) leak ───────────
-- This leaked SMTP passwords, Postmark tokens, Resend API keys to anon.
DROP POLICY IF EXISTS settings_tenant_isolated ON public.settings;
DROP POLICY IF EXISTS settings_select ON public.settings;
DROP POLICY IF EXISTS settings_insert ON public.settings;
DROP POLICY IF EXISTS settings_update ON public.settings;
DROP POLICY IF EXISTS settings_delete ON public.settings;

-- Strict tenant isolation — platform-level settings (tenant_id IS NULL)
-- are ONLY accessible via service_role (BYPASSRLS).
CREATE POLICY settings_tenant_select ON public.settings
  FOR SELECT USING (
    tenant_id = current_setting('app.tenant_id', true)
  );

CREATE POLICY settings_tenant_insert ON public.settings
  FOR INSERT WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
  );

CREATE POLICY settings_tenant_update ON public.settings
  FOR UPDATE USING (
    tenant_id = current_setting('app.tenant_id', true)
  ) WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
  );

CREATE POLICY settings_tenant_delete ON public.settings
  FOR DELETE USING (
    tenant_id = current_setting('app.tenant_id', true)
  );

COMMENT ON POLICY settings_tenant_select ON public.settings IS
  'Strict tenant isolation. Platform-level settings (tenant_id IS NULL, '
  'which hold SMTP passwords and API keys) are ONLY accessible via '
  'service_role (BYPASSRLS). Fixes anon leak of SMTP credentials.';

-- ─── 4. mail_queue table — fix the (tenant_id IS NULL OR ...) leak ─────────
-- This leaked portal-setup password tokens in email bodies to anon.
DROP POLICY IF EXISTS mail_queue_tenant_isolated ON public.mail_queue;
DROP POLICY IF EXISTS mail_queue_select ON public.mail_queue;
DROP POLICY IF EXISTS mail_queue_insert ON public.mail_queue;
DROP POLICY IF EXISTS mail_queue_update ON public.mail_queue;
DROP POLICY IF EXISTS mail_queue_delete ON public.mail_queue;

CREATE POLICY mail_queue_tenant_select ON public.mail_queue
  FOR SELECT USING (
    tenant_id = current_setting('app.tenant_id', true)
  );

CREATE POLICY mail_queue_tenant_insert ON public.mail_queue
  FOR INSERT WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
  );

CREATE POLICY mail_queue_tenant_update ON public.mail_queue
  FOR UPDATE USING (
    tenant_id = current_setting('app.tenant_id', true)
  ) WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
  );

CREATE POLICY mail_queue_tenant_delete ON public.mail_queue
  FOR DELETE USING (
    tenant_id = current_setting('app.tenant_id', true)
  );

COMMENT ON POLICY mail_queue_tenant_select ON public.mail_queue IS
  'Strict tenant isolation. Platform-level queue entries (tenant_id IS NULL) '
  'are ONLY accessible via service_role. Fixes anon leak of portal-setup tokens.';

-- ─── 5. audit_logs table — fix the (tenant_id IS NULL OR ...) leak ─────────
-- This allowed anon to READ, FORGE, and DELETE audit log entries.
DROP POLICY IF EXISTS audit_logs_tenant_isolated ON public.audit_logs;
DROP POLICY IF EXISTS audit_logs_select ON public.audit_logs;
DROP POLICY IF EXISTS audit_logs_insert ON public.audit_logs;
DROP POLICY IF EXISTS audit_logs_update ON public.audit_logs;
DROP POLICY IF EXISTS audit_logs_delete ON public.audit_logs;

-- Tenant-isolated SELECT — platform-level audit entries (tenant_id IS NULL)
-- are invisible to regular roles. Only service_role can read them.
CREATE POLICY audit_logs_tenant_select ON public.audit_logs
  FOR SELECT USING (
    tenant_id = current_setting('app.tenant_id', true)
  );

-- Tenant-scoped INSERT — the app always sets tenant_id on audit writes.
CREATE POLICY audit_logs_tenant_insert ON public.audit_logs
  FOR INSERT WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
  );

-- NO UPDATE policy → UPDATE is denied to anon/authenticated.
-- Only service_role (BYPASSRLS) can update — needed for the existing
-- prevent_tenant_id_change trigger to work.
-- (The append-only trigger in migration 010 will further restrict even
-- service_role from UPDATE/DELETE.)

-- NO DELETE policy → DELETE is denied to anon/authenticated.

COMMENT ON POLICY audit_logs_tenant_select ON public.audit_logs IS
  'Strict tenant isolation. Platform-level audit entries (tenant_id IS NULL) '
  'are ONLY accessible via service_role. UPDATE and DELETE are denied to '
  'anon/authenticated (no policy = deny). See migration 010 for the '
  'append-only trigger that further protects integrity.';
