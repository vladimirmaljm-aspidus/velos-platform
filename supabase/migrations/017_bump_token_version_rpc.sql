-- 017_bump_token_version_rpc.sql
-- ============================================================================
-- CRITICAL FIX — addresses audit finding M-4 (TOCTOU race in bumpUserTokenVersion).
--
-- Previously `SupabaseStore.bumpUserTokenVersion` did:
--   1. SELECT token_version FROM users WHERE id = ?
--   2. UPDATE users SET token_version = ?+1 WHERE id = ?
--
-- Two concurrent calls could both read token_version=5 and both write 6,
-- losing one increment. This breaks session invalidation: after a password
-- reset, the victim's existing sessions should be invalidated by the
-- token_version bump, but a lost increment can leave them valid.
--
-- This migration creates an atomic RPC `bump_token_version(p_user_id)` that
-- performs a single UPDATE ... SET token_version = COALESCE(token_version, 0) + 1
-- RETURNING token_version. Postgres serialises concurrent UPDATEs on the same
-- row via row-level locking, so no increment is ever lost.
--
-- SECURITY DEFINER is required because the RPC is called by `authenticated`
-- and `anon` roles, which may not have direct UPDATE permission on `users`
-- (or may have RLS policies that block the update). SECURITY DEFINER runs
-- with the function owner's privileges (typically postgres), bypassing RLS.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.bump_token_version(p_user_id text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_new_version integer;
BEGIN
  UPDATE public.users
  SET token_version = COALESCE(token_version, 0) + 1
  WHERE id = p_user_id
  RETURNING token_version INTO v_new_version;

  -- If the row doesn't exist, v_new_version stays NULL — return 0 so the
  -- caller can detect the no-op. (Callers of bumpUserTokenVersion have
  -- always just-fetched the user via getUserById, so a missing row would
  -- have already thrown upstream; this is purely defensive.)
  RETURN COALESCE(v_new_version, 0);
END;
$$;

COMMENT ON FUNCTION public.bump_token_version(text) IS
  'Atomic increment of users.token_version. Eliminates the TOCTOU race in '
  'the previous read-modify-write implementation. SECURITY DEFINER bypasses '
  'RLS so any authenticated caller can invalidate sessions for their own user '
  'row. Returns the new token_version, or 0 if the user row was not found.';

-- Grant execute to authenticated and anon roles (anon is needed for flows
-- that may run before login is fully established, e.g. password-reset
-- confirmation).
GRANT EXECUTE ON FUNCTION public.bump_token_version(text) TO authenticated, anon;

-- Verify the function works (returns 0 for a non-existent user id).
SELECT public.bump_token_version('__migration_verify_nonexistent__') AS test_return_value;
