-- 030_gdpr_audit_anonymization.sql
-- ============================================================================
-- CRITICAL COMPLIANCE FIX — addresses audit finding B-1 / P0 (GDPR Article 17
-- right-to-erasure vs. append-only audit_logs).
--
-- Context
-- -------
-- The `audit_logs` table is made append-only by migration 010 (trigger
-- `audit_logs_append_only` raises an exception on any UPDATE or DELETE,
-- even for service_role). That trigger is intentional: the audit log is a
-- tamper-evident financial trail and must be immutable for SOX / regulator
-- purposes.
--
-- But audit_logs stores PII for every action:
--   - username (often the user's real name or email-derived handle)
--   - ip       (client IP at the time of the action)
--   - user_agent (browser / device fingerprint)
--
-- When a user is deleted (GDPR Article 17 — right to erasure), this PII
-- would otherwise persist forever. The append-only trigger prevents a
-- normal UPDATE from anonymising the rows.
--
-- Approach
-- --------
-- Create a SECURITY DEFINER function that:
--   1. Temporarily DISABLEs the `audit_logs_append_only` trigger (only that
--      trigger, NOT the `audit_logs_tenant_id_immutable` trigger, which we
--      leave intact so the tenant_id protection is never weakened).
--   2. UPDATEs every audit_logs row for the given user_id, replacing the
--      PII columns:
--        username  -> 'deleted_user_' || substr(md5(user_id), 1, 8)
--                     (a stable, pseudonymous handle — preserves the ability
--                      to correlate a single deleted user's audit history
--                      WITHOUT revealing their original username)
--        ip        -> NULL
--        user_agent-> NULL
--      It KEEPS `user_id`, `tenant_id`, `action`, `entity_type`,
--      `entity_id`, `details`, `created_at` — i.e. the actual audit data
--      is preserved, only the PII is stripped.
--   3. RE-ENABLEs the trigger.
--
-- The re-enable happens in an EXCEPTION handler too, so a failure mid-UPDATE
-- can never leave audit_logs in a writable state.
--
-- The function is owned by `postgres` (the migration runner) and runs with
-- that role's privileges via SECURITY DEFINER, so it can ALTER TABLE ...
-- DISABLE TRIGGER. RLS on audit_logs does not block the function (it bypasses
-- RLS as the postgres owner). `SET search_path = public, pg_temp` prevents
-- search-path injection on the SECURITY DEFINER function (Supabase security
-- advisory 2023-09).
--
-- Grant execute ONLY to `service_role` — never to `anon`/`authenticated`.
-- This function must only be callable by the server-side service role as
-- part of the user-deletion cascade (DELETE /api/users/[id]); an
-- authenticated client must not be able to wipe its own audit trail.
--
-- Out of scope (flagged for follow-up)
-- -------------------------------------
-- `document_verification_logs` is also append-only (trigger `dvl_append_only`,
-- migration 010) and also stores PII (ip, country, city, region, latitude,
-- longitude, user_agent, raw_headers). It has NO direct user_id column —
-- rows are linked indirectly via `verification_code` to a portal_access row
-- (which itself has a `user_id`). Anonymising that table requires a JOIN to
-- portal_access; that is left as a follow-up task (C-3 / P1).
-- ============================================================================

-- Drop defensively so the migration is re-runnable.
DROP FUNCTION IF EXISTS public.anonymize_user_audit_logs(text);

CREATE OR REPLACE FUNCTION public.anonymize_user_audit_logs(p_user_id text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
-- Lock the search_path so a malicious temp-schema function cannot shadow
-- one of our public functions during the SECURITY DEFINER call.
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
  v_pseudonym text;
BEGIN
  IF p_user_id IS NULL OR p_user_id = '' THEN
    RAISE EXCEPTION 'anonymize_user_audit_logs: p_user_id must be a non-empty string';
  END IF;

  -- Compute a stable, pseudonymous handle for the deleted user. md5 is fine
  -- here: this is NOT a secret — user_id remains in the row, so the pseudonym
  -- is only cosmetically unlinkable to the original username. The point is
  -- to replace `jane.doe@example.com` with `deleted_user_a1b2c3d4` so the
  -- audit log no longer contains a meaningful identity.
  v_pseudonym := 'deleted_user_' || substr(md5(p_user_id), 1, 8);

  -- Temporarily disable the append-only trigger. We DO NOT disable
  -- `audit_logs_tenant_id_immutable` — the tenant_id protection must remain
  -- in force at all times.
  ALTER TABLE public.audit_logs DISABLE TRIGGER audit_logs_append_only;

  BEGIN
    UPDATE public.audit_logs
    SET username   = v_pseudonym,
        ip         = NULL,
        user_agent = NULL
    WHERE user_id = p_user_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN
    -- Always re-enable the trigger, even if the UPDATE failed, so we can
    -- never leave audit_logs in a writable state.
    ALTER TABLE public.audit_logs ENABLE TRIGGER audit_logs_append_only;
    RAISE;
  END;

  -- Re-enable the trigger on the happy path.
  ALTER TABLE public.audit_logs ENABLE TRIGGER audit_logs_append_only;

  RETURN COALESCE(v_count, 0);
END;
$$;

COMMENT ON FUNCTION public.anonymize_user_audit_logs(text) IS
  'GDPR Article 17 (right-to-erasure) compliance for audit_logs. Replaces '
  'the PII columns (username, ip, user_agent) for every audit_logs row '
  'belonging to the given user_id, while preserving user_id, tenant_id, '
  'action, entity_type, entity_id, details, and created_at — so the audit '
  'trail remains intact and tamper-evident, just no longer personally '
  'identifiable. SECURITY DEFINER + temporary trigger disable is required '
  'because migration 010 made audit_logs append-only. service_role only.';

-- Grant execute ONLY to service_role. Never grant to anon/authenticated —
-- a client must never be able to anonymise its own audit trail.
GRANT EXECUTE ON FUNCTION public.anonymize_user_audit_logs(text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.anonymize_user_audit_logs(text) FROM PUBLIC, authenticated, anon;

-- Smoke test: call the function with a sentinel user_id that is guaranteed
-- not to exist in audit_logs. The function must return 0 (zero rows updated)
-- and must NOT leave the trigger disabled.
SELECT public.anonymize_user_audit_logs('__migration_030_smoke_test__') AS smoke_test_rows_anonymised;

-- Verify the trigger is back on after the smoke-test call. This SELECT will
-- return exactly one row with tgenabled='O' (origin / enabled) if the
-- function correctly re-enabled the trigger.
SELECT tgname, tgenabled
FROM pg_trigger
WHERE tgrelid = 'public.audit_logs'::regclass
  AND tgname = 'audit_logs_append_only';
