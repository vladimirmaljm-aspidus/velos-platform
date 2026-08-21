-- 040_2fa_recovery_codes.sql
-- ============================================================================
-- P0-1 (Auth Security): 2FA / TOTP — schema additions
--
-- Context
--   The `users` table already has `totp_secret TEXT NULL` and
--   `totp_enabled BOOLEAN DEFAULT false` (see prisma/schema.prisma lines
--   95–96 and src/lib/supabase/types.ts). These were added when the
--   schema was originally minted but the columns had no consumer until
--   this task. This migration:
--     1. Re-asserts totp_secret / totp_enabled with IF NOT EXISTS so
--        deployments that don't have them yet pick them up.
--     2. Adds `recovery_codes JSONB NULL` to store the SHA-256 hashes
--        of the 10 one-time recovery codes issued at 2FA enrollment.
--        Hashed at the application layer (src/lib/auth/totp.ts) so a DB
--        read alone doesn't recover usable codes.
--
-- Idempotency
--   Every statement uses ADD COLUMN IF NOT EXISTS so re-running the
--   migration is a no-op on databases that already have the columns.
-- ============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_codes JSONB;

COMMENT ON COLUMN users.totp_secret IS
  'Base32 TOTP secret (RFC 6238) for 2FA. Present when enrollment is in '
  'progress OR completed. Cleared on disable. NEVER returned to the client '
  'after the initial QR-code generation.';
COMMENT ON COLUMN users.totp_enabled IS
  'Whether 2FA is fully activated (secret set + verified at least once). '
  'When false, login skips the TOTP prompt even if totp_secret is set '
  '(e.g. abandoned enrollment).';
COMMENT ON COLUMN users.recovery_codes IS
  'JSON array of SHA-256 hex strings for the 10 one-time recovery codes '
  'issued at 2FA enrollment. Hashed at the application layer. A code is '
  'removed from the array when consumed so each is single-use. NULL when '
  '2FA is not active.';
