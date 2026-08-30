-- 069_add_search_path_to_sec_definer.sql
-- ============================================================================
-- AUDIT FIX — 2c2-F3 (CRITICAL, round 2)
-- 7 SECURITY DEFINER functions are missing `SET search_path = public, pg_temp`
-- (Supabase advisory 2023-09 class). A SECURITY DEFINER function that does
-- NOT pin its search_path is vulnerable to search_path-injection: an attacker
-- who can create objects in pg_temp (or another schema earlier in the path)
-- can shadow a function or table the SECURITY DEFINER body calls, running
-- their code as the `postgres` superuser.
--
-- The 7 functions (all SECURITY DEFINER):
--   1. atomic_update_invoice_payment_status(text, text)  — migration 018
--   2. bump_token_version(text)                          — migration 017
--   3. force_anonymize_user_audit_logs(text)             — migration 055
--   4. force_delete_tenant_audit_logs(text)              — migration 055
--   5. get_cron_status()                                  — migration 043
--   6. get_current_tenant_id()                           — referenced by 8 RLS policies
--   7. get_db_metrics()                                   — migration 043
--
-- Approach: `ALTER FUNCTION ... SET search_path = public, pg_temp` is the
-- idiomatic way to attach a search_path to an existing function WITHOUT
-- dropping + recreating it (preserves the body, the owner, the grants, and
-- any caller-side dependency). Idempotent — re-running is a no-op.
--
-- Safe to apply on a live production DB. No schema or data change.
-- ============================================================================

ALTER FUNCTION public.atomic_update_invoice_payment_status(text, text) SET search_path = public, pg_temp;
ALTER FUNCTION public.bump_token_version(text)                  SET search_path = public, pg_temp;
ALTER FUNCTION public.force_anonymize_user_audit_logs(text)     SET search_path = public, pg_temp;
ALTER FUNCTION public.force_delete_tenant_audit_logs(text)       SET search_path = public, pg_temp;
ALTER FUNCTION public.get_cron_status()                         SET search_path = public, pg_temp;
ALTER FUNCTION public.get_current_tenant_id()                   SET search_path = public, pg_temp;
ALTER FUNCTION public.get_db_metrics()                           SET search_path = public, pg_temp;

-- ── Verification ───────────────────────────────────────────────────────────
-- Each function should now show proconfig containing "search_path=public,pg_temp".
SELECT p.proname AS routine_name,
       pg_get_function_identity_arguments(p.oid) AS args,
       COALESCE(array_agg(pg_get_functiondef(p.oid) LIKE '%search_path = public, pg_temp%'), ARRAY[]::bool[]) AS has_search_path
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname IN (
    'atomic_update_invoice_payment_status','bump_token_version',
    'force_anonymize_user_audit_logs','force_delete_tenant_audit_logs',
    'get_cron_status','get_current_tenant_id','get_db_metrics'
  )
GROUP BY p.proname, p.oid, pg_get_function_identity_arguments(p.oid)
ORDER BY p.proname;
