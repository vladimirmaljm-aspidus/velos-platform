-- 039_tenant_role_overrides.sql
-- ============================================================================
-- PER-TENANT ROLE CUSTOMIZATION (P1-1 / Feature 1).
--
-- Background
-- ----------
-- Until now every tenant shared the same role-to-permission mapping: Tenant
-- A's "manager" got exactly the same `users.permissions` seed as Tenant B's
-- "manager". Tenant admins could only differentiate users by hand-editing
-- each `users.permissions` array — which scales poorly and gives no audit
-- trail at the role level.
--
-- This migration introduces a `tenant_role_overrides` table that lets a
-- super_admin (or a tenant admin via the new admin API) attach an explicit
-- ADDITIONAL permission grant to a (tenant_id, role) pair. The grant is
-- merged with the user's existing permissions at evaluation time inside
-- `can()` (see `src/lib/permissions/can.ts` + `tenant-roles.ts`).
--
-- Semantics (implemented in `lib/permissions/tenant-roles.ts`):
--   • Super_admin is NEVER subject to overrides — they bypass all checks.
--   • Per-tenant overrides are ADDITIVE: the user keeps their explicit
--     `users.permissions` grants AND the default role grants (e.g. the
--     `admin` implicit grant for non-platform perms). The override is an
--     extra source of permissions, never a revocation. This avoids
--     accidentally locking users out of actions they could previously do.
--   • `is_active = false` disables an override without dropping it (so
--     ops can quickly roll back a problematic change).
--
-- Security
-- --------
--   • Only super_admin may create/update/delete overrides for ANY tenant.
--     Tenant admins may manage their OWN tenant's overrides (gated in the
--     API route by `resolveTenantId` + role check, not at the SQL level).
--   • RLS is intentionally permissive for the service role (the cron /
--     API layer enforces auth) but DENIES for the anon/authenticated roles
--     so the table is never directly queryable from the browser.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.tenant_role_overrides (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  role         TEXT NOT NULL,
  permissions  JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, role)
);

-- ─── Indexes ──────────────────────────────────────────────────────────────
-- The hot path is the lookup-by-(tenant_id, role), which the UNIQUE index
-- already covers. Add a partial index on tenant_id for "list all overrides
-- for this tenant" (the admin UI uses this).
CREATE INDEX IF NOT EXISTS tenant_role_overrides_tenant_id_idx
  ON public.tenant_role_overrides (tenant_id)
  WHERE is_active = true;

-- ─── Row-level security ───────────────────────────────────────────────────
-- The table is only ever read/written by the service-role client (cron +
-- super_admin / tenant-admin API routes). We DENY direct anon/authenticated
-- access so the table can't be queried from the browser even if a future
-- API route accidentally exposes the Supabase client to the page.
ALTER TABLE public.tenant_role_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_role_overrides_service_all ON public.tenant_role_overrides;
CREATE POLICY tenant_role_overrides_service_all ON public.tenant_role_overrides
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ─── updated_at trigger ──────────────────────────────────────────────────
-- Keeps `updated_at` honest without relying on every API route remembering
-- to set it. Same pattern as other audit-style tables in this schema.
CREATE OR REPLACE FUNCTION public.tenant_role_overrides_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenant_role_overrides_set_updated_at
  ON public.tenant_role_overrides;

CREATE TRIGGER tenant_role_overrides_set_updated_at
  BEFORE UPDATE ON public.tenant_role_overrides
  FOR EACH ROW
  EXECUTE FUNCTION public.tenant_role_overrides_set_updated_at();

-- ─── Verify ───────────────────────────────────────────────────────────────
SELECT id, tenant_id, role, is_active
  FROM public.tenant_role_overrides
  LIMIT 0;
