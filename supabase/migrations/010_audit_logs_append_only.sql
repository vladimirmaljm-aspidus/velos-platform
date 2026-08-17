-- 010_audit_logs_append_only.sql
-- ============================================================================
-- CRITICAL SECURITY FIX — addresses audit finding B-5 / P1-8.
--
-- The audit_logs table had no trigger preventing UPDATE or DELETE of rows.
-- Combined with the RLS fix in migration 009 (which now denies UPDATE/DELETE
-- to anon/authenticated), this migration adds a DB-level trigger that raises
-- an exception on ANY UPDATE or DELETE attempt — even by service_role.
--
-- This makes the audit log truly tamper-proof at the database layer. The
-- only way to remove audit entries is via a dedicated maintenance function
-- (not yet implemented) or direct DB superuser access (postgres role).
-- ============================================================================

-- Drop existing trigger if re-running.
DROP TRIGGER IF EXISTS audit_logs_append_only ON public.audit_logs;
DROP FUNCTION IF EXISTS public.prevent_audit_log_modification();

-- Function that always raises an exception — used by the trigger.
CREATE OR REPLACE FUNCTION public.prevent_audit_log_modification()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: UPDATE and DELETE are not allowed. (trigger: audit_logs_append_only)';
END;
$$;

-- Trigger: fires BEFORE UPDATE OR DELETE on audit_logs.
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON public.audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_audit_log_modification();

COMMENT ON FUNCTION public.prevent_audit_log_modification() IS
  'Always raises an exception. Used by audit_logs_append_only trigger to '
  'enforce append-only semantics on the audit log.';

COMMENT ON TRIGGER audit_logs_append_only ON public.audit_logs IS
  'Prevents UPDATE and DELETE on audit_logs at the DB level — even for '
  'service_role. Makes the audit log tamper-proof for compliance.';

-- ─── Bonus: also protect document_verification_logs from UPDATE/DELETE ─────
-- These logs record forensic data (IP, geo, UA) for document verifications.
-- They should also be append-only. Migration 008 already denies UPDATE/DELETE
-- to non-service roles via RLS; this trigger extends protection to service_role.
DROP TRIGGER IF EXISTS dvl_append_only ON public.document_verification_logs;
DROP FUNCTION IF EXISTS public.prevent_dvl_modification();

CREATE OR REPLACE FUNCTION public.prevent_dvl_modification()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'document_verification_logs is append-only: UPDATE and DELETE are not allowed.';
END;
$$;

CREATE TRIGGER dvl_append_only
  BEFORE UPDATE OR DELETE ON public.document_verification_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_dvl_modification();

COMMENT ON TRIGGER dvl_append_only ON public.document_verification_logs IS
  'Prevents UPDATE and DELETE on document_verification_logs at the DB level. '
  'Forensic verification data must be immutable.';
