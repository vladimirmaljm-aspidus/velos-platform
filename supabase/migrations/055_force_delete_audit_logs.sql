-- 055_force_delete_audit_logs.sql
-- ============================================================================
-- SECURITY DEFINER functions to bypass the audit_logs_append_only trigger
-- for super-admin force-deletes of tenants and users.
--
-- Context:
--   The audit_logs_append_only trigger (migration 010) blocks both DELETE
--   and UPDATE on audit_logs. This is a security feature — audit logs are
--   append-only for compliance (GDPR Article 17 / SOX / ISO 27001).
--
--   BUT: when a super_admin hard-deletes a tenant (or a user), the cascade
--   needs to either DELETE (tenant) or UPDATE/anonymize (user) audit_logs
--   rows. The trigger blocks this → the cascade fails.
--
--   These SECURITY DEFINER functions run with the function owner's
--   privileges (postgres) and temporarily disable the trigger for the
--   duration of the operation, then re-enable it.
--
-- Idempotency:
--   CREATE OR REPLACE — safe to run multiple times.
-- ============================================================================

-- Force-delete all audit_logs for a tenant (used by deleteTenantCascade).
-- Temporarily disables the append-only trigger, deletes the rows,
-- re-enables the trigger.
CREATE OR REPLACE FUNCTION force_delete_tenant_audit_logs(t_uuid TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  ALTER TABLE public.audit_logs DISABLE TRIGGER audit_logs_append_only;
  DELETE FROM public.audit_logs WHERE tenant_id = t_uuid;
  ALTER TABLE public.audit_logs ENABLE TRIGGER audit_logs_append_only;
END;
$$;

-- Force-anonymize all audit_logs for a user (used by deleteUserCascade).
-- Strips PII (user_id, ip, user_agent) without deleting the rows —
-- the audit trail remains for compliance but the PII is gone (GDPR Art. 17).
-- Temporarily disables the append-only trigger for the UPDATE.
CREATE OR REPLACE FUNCTION force_anonymize_user_audit_logs(t_user_id TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  ALTER TABLE public.audit_logs DISABLE TRIGGER audit_logs_append_only;
  UPDATE public.audit_logs
  SET user_id = NULL,
      ip = NULL,
      user_agent = NULL
  WHERE user_id = t_user_id;
  ALTER TABLE public.audit_logs ENABLE TRIGGER audit_logs_append_only;
END;
$$;

-- Grant execute to authenticated users (the application uses the service
-- role key which bypasses RLS, but be explicit).
GRANT EXECUTE ON FUNCTION force_delete_tenant_audit_logs(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION force_anonymize_user_audit_logs(TEXT) TO authenticated;

COMMENT ON FUNCTION force_delete_tenant_audit_logs(TEXT) IS
  'Bypasses the audit_logs_append_only trigger to delete audit_logs for a tenant. '
  'Used by deleteTenantCascade when a super_admin hard-deletes a tenant. '
  'The trigger is disabled for the duration of the DELETE and re-enabled after.';

COMMENT ON FUNCTION force_anonymize_user_audit_logs(TEXT) IS
  'Bypasses the audit_logs_append_only trigger to anonymize PII in audit_logs for a user. '
  'Used by deleteUserCascade when a super_admin deletes a user (GDPR Article 17). '
  'The trigger is disabled for the duration of the UPDATE and re-enabled after.';
