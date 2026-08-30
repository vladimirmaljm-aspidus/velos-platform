-- 068_revoke_remaining_rpc_grants.sql
-- ============================================================================
-- AUDIT FIX — 2c2-F2 (CRITICAL, round 2)
-- Migration 067 (Task 5) revoked only 4 of the 13 dangerous SECURITY DEFINER
-- RPC grants. The remaining 9 are STILL granted to PUBLIC + anon +
-- authenticated, so any logged-in portal partner (or anonymous attacker) can
-- call them via PostgREST and bypass the API route's auth / tenant scoping /
-- audit layer.
--
-- The 9 functions remediated here:
--   1. upsert_journal_entry(jsonb, jsonb)              — migration 031
--      SECURITY DEFINER that INSERTs a journal-entry header + lines into
--      ANY tenant's GL. A portal partner could forge journal entries in a
--      tenant they don't own.
--   2. reverse_journal_entry(text, text, jsonb, jsonb, text)  — migration 031
--      SECURITY DEFINER that reverses a journal entry in ANY tenant.
--   3. auto_journal_from_invoice(text, text, text, text, text)  — migration 031
--      SECURITY DEFINER that auto-creates a journal entry from an invoice.
--      Called with a caller-supplied p_tenant_id — anon could auto-post
--      GL entries for any invoice in any tenant.
--   4. create_commission_payout(jsonb, text[])        — migration 031
--      SECURITY DEFINER that creates a payout + marks commissions paid.
--      Anon could mark their own commissions paid without approval.
--   5. create_doc_with_number(text, uuid, jsonb)      — migration 063
--      SECURITY DEFINER that creates a document (offer/invoice/proforma/...)
--      with an auto-incremented number. Anon could create documents in any
--      tenant + consume sequence numbers.
--   6. get_next_doc_number(text, uuid)                — migration 063
--      SECURITY DEFINER that returns the next document number for a
--      (doc_type, tenant_id). Anon could enumerate other tenants' doc counts.
--   7. create_fx_revaluation(text, date, text, jsonb, text)  — migration 038
--      SECURITY DEFINER that posts FX revaluation journal entries.
--   8. get_cron_status()                              — migration 043
--      SECURITY DEFINER that exposes cron job state. Anon could enumerate
--      scheduled jobs + their run history (info disclosure).
--   9. get_db_metrics()                               — migration 043
--      SECURITY DEFINER that exposes DB metrics. Anon could enumerate table
--      row counts + sizes (info disclosure).
--
-- Verified (2026-08-30): ALL NINE are called exclusively via getSupabase()
-- (the service-role client) from the API routes, so the app keeps working
-- after the REVOKE — service_role bypasses these GRANT checks entirely.
--
-- This migration is ADDITIVE (DCL only — no schema change, no data change).
-- Safe to apply on a live production DB at any time. Idempotent: re-running
-- is a no-op (REVOKE on a grant that doesn't exist succeeds silently).
-- ============================================================================

-- ── 1. upsert_journal_entry (migration 031) ────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.upsert_journal_entry(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.upsert_journal_entry(jsonb, jsonb) TO service_role;

-- ── 2. reverse_journal_entry (migration 031) ───────────────────────────────
REVOKE EXECUTE ON FUNCTION public.reverse_journal_entry(text, text, jsonb, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.reverse_journal_entry(text, text, jsonb, jsonb, text) TO service_role;

-- ── 3. auto_journal_from_invoice (migration 031) ───────────────────────────
REVOKE EXECUTE ON FUNCTION public.auto_journal_from_invoice(text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.auto_journal_from_invoice(text, text, text, text, text) TO service_role;

-- ── 4. create_commission_payout (migration 031) ───────────────────────────
REVOKE EXECUTE ON FUNCTION public.create_commission_payout(jsonb, text[]) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.create_commission_payout(jsonb, text[]) TO service_role;

-- ── 5. create_doc_with_number (migration 063) ──────────────────────────────
REVOKE EXECUTE ON FUNCTION public.create_doc_with_number(text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.create_doc_with_number(text, uuid, jsonb) TO service_role;

-- ── 6. get_next_doc_number (migration 063) ─────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.get_next_doc_number(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_next_doc_number(text, uuid) TO service_role;

-- ── 7. create_fx_revaluation (migration 038) ──────────────────────────────
REVOKE EXECUTE ON FUNCTION public.create_fx_revaluation(text, date, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.create_fx_revaluation(text, date, text, jsonb, text) TO service_role;

-- ── 8. get_cron_status (migration 043) ─────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.get_cron_status() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_cron_status() TO service_role;

-- ── 9. get_db_metrics (migration 043) ─────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.get_db_metrics() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_db_metrics() TO service_role;

-- ── Verification ───────────────────────────────────────────────────────────
-- Each function should now show grantees = {postgres, service_role} only.
SELECT routine_name, COALESCE(array_agg(grantee ORDER BY grantee), ARRAY[]::text[]) AS grantees
FROM information_schema.role_routine_grants
WHERE routine_name IN (
  'upsert_journal_entry','reverse_journal_entry','auto_journal_from_invoice',
  'create_commission_payout','create_doc_with_number','get_next_doc_number',
  'create_fx_revaluation','get_cron_status','get_db_metrics'
)
GROUP BY routine_name
ORDER BY routine_name;
