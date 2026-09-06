-- 093_tenant_delete_audit_fix.sql — fix the tenant hard-delete 500s
-- ============================================================================
-- ROOT-CAUSE FIX for the platform owner's report: "why can't I delete the
-- test tenants?" (2026-09-06 18:49–18:50, five ZZZ Audit* tenants, every
-- DELETE /api/tenants/[id] attempt failed with 500).
--
-- Diagnosis (from production audit_logs + information_schema):
--   1. The login route wrote audit rows WITHOUT tenant_id (all 12
--      appendAudit calls omitted the field) → every login / login.failed /
--      login.blocked / login.rate_limited row for a tenant user carried
--      tenant_id = NULL even though the user belongs to a tenant.
--      68 such orphan-context rows existed for deleted test users + 17
--      rows written under a different tenant_id.
--   2. deleteTenantCascade's RPC (force_delete_tenant_audit_logs) deleted
--      audit rows only WHERE tenant_id = $1 → the NULL-tenant / cross-tenant
--      rows of the tenant's users SURVIVED.
--   3. The cascade then deleted the tenant's users rows. The FK
--      audit_logs_user_id_fkey is ON DELETE SET NULL → Postgres attempted
--      an UPDATE on the surviving audit rows → the append-only trigger
--      (migration 010) raised → the users DELETE failed (swallowed by the
--      per-table try/catch).
--   4. The final DELETE FROM tenants cascades to users at the DB level →
--      same FK → same trigger → the whole statement failed → the route
--      returned 500 and the owner had to delete every user BY HAND first.
--
-- This migration:
--   A. Backfills tenant_id on historical login-family audit rows (NULL →
--      the user's real tenant). The audit_logs_tenant_id_immutable trigger
--      only forbids changing a NON-NULL tenant_id, so NULL → value is legal
--      and can be done with the append-only trigger disabled in one UPDATE.
--   B. Creates force_delete_tenant_audit_logs_v2 — deletes audit rows for
--      the tenant AND for the tenant's users regardless of which tenant_id
--      those rows carry (the rows about to be orphaned / FK-SET-NULLed).
--      The app store calls v2 first and falls back to v1, so old deploys
--      keep working during the rollout window.
--
-- Idempotent: safe to re-run.

-- ── A) Backfill: NULL-tenant audit rows get the actor's real tenant_id ──────
-- Only rows where the actor STILL exists and has a non-null tenant_id.
-- Rows of deleted users keep tenant_id NULL (their user_id is already NULL
-- after GDPR anonymisation — nothing references them anymore).
DO $$
DECLARE
  v_count integer;
BEGIN
  ALTER TABLE public.audit_logs DISABLE TRIGGER audit_logs_append_only;
  BEGIN
    UPDATE public.audit_logs a
       SET tenant_id = u.tenant_id
      FROM public.users u
     WHERE a.user_id = u.id
       AND a.tenant_id IS NULL
       AND u.tenant_id IS NOT NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RAISE NOTICE '093 backfill: % audit_logs rows gained tenant_id', v_count;
  EXCEPTION WHEN OTHERS THEN
    ALTER TABLE public.audit_logs ENABLE TRIGGER audit_logs_append_only;
    RAISE;
  END;
  ALTER TABLE public.audit_logs ENABLE TRIGGER audit_logs_append_only;
END;
$$;

-- ── B) RPC v2 — the complete tenant audit purge ────────────────────────────
-- Deletes:
--   * every audit row carrying the tenant's tenant_id (v1 semantics), PLUS
--   * every audit row whose user_id belongs to the tenant's users — these
--     are the rows that otherwise block the users DELETE via the
--     audit_logs_user_id_fkey (ON DELETE SET NULL) × append-only trigger.
--
-- SECURITY DEFINER: the caller is the service role; the function needs to
-- disable the append-only trigger around the DELETE. The immutable-tenant_id
-- trigger is NOT disabled (we only DELETE, never UPDATE tenant_id here).
CREATE OR REPLACE FUNCTION public.force_delete_tenant_audit_logs_v2(t_uuid text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  ALTER TABLE public.audit_logs DISABLE TRIGGER audit_logs_append_only;
  BEGIN
    DELETE FROM public.audit_logs a
     WHERE a.tenant_id = t_uuid
        OR a.user_id IN (SELECT u.id FROM public.users u WHERE u.tenant_id = t_uuid);
    GET DIAGNOSTICS v_count = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN
    ALTER TABLE public.audit_logs ENABLE TRIGGER audit_logs_append_only;
    RAISE;
  END;
  ALTER TABLE public.audit_logs ENABLE TRIGGER audit_logs_append_only;
  RETURN COALESCE(v_count, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.force_delete_tenant_audit_logs_v2(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.force_delete_tenant_audit_logs_v2(text) TO service_role;

COMMENT ON FUNCTION public.force_delete_tenant_audit_logs_v2(text) IS
  'Hard-delete purge of a tenant''s audit trail: rows by tenant_id PLUS rows whose user_id belongs to the tenant''s users (they would otherwise block the users DELETE via FK ON DELETE SET NULL vs the append-only trigger). Called only by deleteTenantCascade.';
