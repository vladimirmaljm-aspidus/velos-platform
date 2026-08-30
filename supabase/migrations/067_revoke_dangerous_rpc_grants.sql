-- 067_revoke_dangerous_rpc_grants.sql
-- ============================================================================
-- AUDIT FIX — 2c-F1, 2c-F4, 2c-F5 (CRITICAL)
--
-- Four SECURITY DEFINER functions were granted EXECUTE to `authenticated`
-- (and two of them also to `anon`), allowing any logged-in portal partner
-- or anonymous attacker to call them directly via PostgREST and bypass the
-- API route's auth / rate-limit / audit layer.
--
-- Verified (2026-08-30): ALL FOUR functions are called exclusively via
-- `getSupabase()` (the service-role client) in:
--   src/lib/data/supabase-store.ts   (bump_token_version, force_delete_*,
--                                     force_anonymize_*)
--   src/app/api/invoices/[id]/record-payment/route.ts
--                                     (atomic_update_invoice_payment_status)
-- The service_role bypasses these GRANT checks entirely, so revoking EXECUTE
-- from anon/authenticated does NOT break the app — it only closes the
-- PostgREST back-door.
--
-- The comment in migration 017 ("anon is needed for password-reset flows")
-- was WRONG: bump_token_version is called only from authenticated server-
-- side routes (2fa/disable, logout, logout-all, internal session rotation)
-- — never from a pre-login / anon context.
--
-- Functions remediated:
--   1. force_delete_tenant_audit_logs(TEXT)      — migration 055 (2c-F1)
--      SECURITY DEFINER that disables the audit_logs_append_only trigger
--      and DELETEs audit_logs rows. Any portal partner could wipe ANY
--      tenant's audit trail by calling:
--        POST /rest/v1/rpc/force_delete_tenant_audit_logs  { "t_uuid": "<victim-tenant-uuid>" }
--   2. force_anonymize_user_audit_logs(TEXT)     — migration 055 (2c-F1)
--      SECURITY DEFINER that UPDATEs audit_logs rows. Same risk.
--   3. public.bump_token_version(text)           — migration 017 (2c-F4)
--      SECURITY DEFINER that bumps users.token_version (invalidates all
--      the user's sessions). Anon attacker could mass-invalidate ANY
--      user's sessions (DoS / forced mass-logout) by calling:
--        POST /rest/v1/rpc/bump_token_version  { "p_user_id": "<victim-user-id>" }
--   4. atomic_update_invoice_payment_status(text, text)  — migration 018 (2c-F5)
--      SECURITY DEFINER that flips invoices.payment_status. Anon attacker
--      could mark ANY invoice as paid by calling:
--        POST /rest/v1/rpc/atomic_update_invoice_payment_status
--        { "p_invoice_id": "<id>", "p_tenant_id": "<tenant>" }
--
-- This migration is ADDITIVE (DCL only — no schema change, no data change).
-- Safe to apply on a live production DB at any time. Idempotent: re-running
-- is a no-op (REVOKE on a grant that doesn't exist succeeds silently).
-- ============================================================================

-- ── 1. Audit-wipe functions (migration 055) — 2c-F1 ──────────────────────
-- These two functions disable the append-only trigger and DELETE/UPDATE
-- audit_logs rows. They MUST be service_role-only — the app calls them via
-- the super-admin "Settings → GDPR" panel (supabase-store.ts:1849 + :1898),
-- which uses getSupabase() (service_role). No portal partner or anonymous
-- caller should ever reach them directly via PostgREST.
REVOKE EXECUTE ON FUNCTION public.force_delete_tenant_audit_logs(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.force_anonymize_user_audit_logs(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.force_delete_tenant_audit_logs(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.force_anonymize_user_audit_logs(text) TO service_role;

-- ── 2. bump_token_version (migration 017) — 2c-F4 ─────────────────────────
-- Called by supabase-store.ts:472 (bumpUserTokenVersion) via getSupabase()
-- (service_role). The callers are 2fa/disable, logout, logout-all, and
-- internal session-rotation after password change — all server-side,
-- all using the service-role client. Anon was never actually needed.
REVOKE EXECUTE ON FUNCTION public.bump_token_version(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bump_token_version(text) TO service_role;

-- ── 3. atomic_update_invoice_payment_status (migration 018) — 2c-F5 ───────
-- Called by src/app/api/invoices/[id]/record-payment/route.ts:253 via
-- getSupabase() (service_role). The route requires auth + tenant scoping
-- (id + tid from the session), so the RPC's p_tenant_id is always the
-- caller's own tenant — but even so, anon should never reach this function
-- directly via PostgREST.
REVOKE EXECUTE ON FUNCTION public.atomic_update_invoice_payment_status(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_update_invoice_payment_status(text, text) TO service_role;

-- ── Verification ───────────────────────────────────────────────────────────
-- Confirm the grants are now service_role-only. These SELECTs read
-- information_schema metadata (no user data) and are safe to run on prod.
-- Expected: each row's `grantees` array should contain only `service_role`.
SELECT 'force_delete_tenant_audit_logs' AS fn,
       COALESCE(array_agg(grantee ORDER BY grantee), ARRAY[]::text[]) AS grantees
FROM information_schema.role_routine_grants
WHERE routine_name = 'force_delete_tenant_audit_logs'
UNION ALL
SELECT 'force_anonymize_user_audit_logs',
       COALESCE(array_agg(grantee ORDER BY grantee), ARRAY[]::text[])
FROM information_schema.role_routine_grants
WHERE routine_name = 'force_anonymize_user_audit_logs'
UNION ALL
SELECT 'bump_token_version',
       COALESCE(array_agg(grantee ORDER BY grantee), ARRAY[]::text[])
FROM information_schema.role_routine_grants
WHERE routine_name = 'bump_token_version'
UNION ALL
SELECT 'atomic_update_invoice_payment_status',
       COALESCE(array_agg(grantee ORDER BY grantee), ARRAY[]::text[])
FROM information_schema.role_routine_grants
WHERE routine_name = 'atomic_update_invoice_payment_status';
