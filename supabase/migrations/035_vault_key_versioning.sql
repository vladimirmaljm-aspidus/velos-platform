-- 035_vault_key_versioning.sql
-- ============================================================================
-- VAULT ENCRYPTION KEY VERSIONING (audit P2-3 / task C-7).
--
-- Background
-- ----------
-- `vault_secrets.encrypted_value` is encrypted in the application layer
-- with AES-256-GCM (see `src/lib/api/vault-crypto.ts`). The encryption
-- key is derived from `process.env.SECRET_KEY` (padded/truncated to 32
-- bytes). There was NO way to rotate this key without:
--   1. Decrypting every row with the old key.
--   2. Re-encrypting every row with the new key.
--   3. Atomic swap (or downtime) to avoid race conditions.
-- And the wire format had no version marker, so the decrypt side had no
-- way to know which key a given row was encrypted with — the moment
-- `SECRET_KEY` was rotated, every pre-existing row became unreadable.
--
-- This migration adds a `key_version` column to `vault_secrets` so the
-- ops team can answer "how many rows still use v1?" with a single query.
-- The wire format (encrypted_value) ALSO carries the version prefix
-- (`v<version>:...` — see vault-crypto.ts) so the column is technically
-- redundant — but having it as a real column lets us index/query it
-- without parsing the encrypted blob.
--
-- The rotation procedure
-- ----------------------
--   1. Deploy code that knows about both `SECRET_KEY` (v1) and the new
--      `SECRET_KEY_V2` (v2). Set `VAULT_KEY_VERSION=2` so NEW writes
--      use v2. Old rows still decrypt because `decrypt()` looks up the
--      version from the wire format.
--   2. Run `POST /api/vault/rotate` (super-admin only) — see
--      `src/app/api/vault/rotate/route.ts`. It reads each row, decrypts
--      with the version-specific key, re-encrypts with the current key,
--      and writes the new ciphertext + key_version back.
--   3. Once `SELECT count(*) FROM vault_secrets WHERE key_version IS
--      DISTINCT FROM '2'` returns 0, the rotation is complete. The
--      operator can remove `SECRET_KEY` from the env (or keep it as a
--      long-term backup).
--
-- Idempotent
-- ----------
-- `ADD COLUMN IF NOT EXISTS` makes this safe to re-run. The column is
-- nullable (existing rows get NULL = "v1 or pre-versioning, use wire
-- format detection") — backfilling would require decrypting every row,
-- which is the rotation procedure's job, not the migration's.
-- ============================================================================

-- ─── 1. Add key_version column (nullable text) ─────────────────────────────
-- Text (not int) so we can support non-numeric version labels in the
-- future without a migration. The wire format uses `v<digits>` so the
-- application layer always parses it back to a numeric-looking string.
ALTER TABLE public.vault_secrets
  ADD COLUMN IF NOT EXISTS key_version text;

COMMENT ON COLUMN public.vault_secrets.key_version IS
  'Encryption key version used for `encrypted_value`. NULL = legacy row '
  '(use wire-format detection — see vault-crypto.ts.parseKeyVersion). '
  'Set by the application on every encrypt; updated by the rotation '
  'endpoint when a row is re-encrypted with a newer key.';

-- ─── 2. Index for the rotation "are we done?" query ────────────────────────
-- The rotation endpoint needs to quickly find rows still on an old key
-- version. Without this index, that query is a full table scan on every
-- poll — fine at 100 rows, painful at 100k.
CREATE INDEX IF NOT EXISTS idx_vault_key_version
  ON public.vault_secrets (key_version);

-- ─── 3. Verify ─────────────────────────────────────────────────────────────
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'vault_secrets'
    AND column_name = 'key_version';

-- ─── 4. NOTE on backfill ───────────────────────────────────────────────────
-- We deliberately do NOT backfill `key_version = '1'` for existing rows
-- in this migration. Reasons:
--   • The wire format (`encrypted_value`) is the source of truth —
--     `parseKeyVersion()` in vault-crypto.ts returns "1" for any value
--     using the legacy 3-part format, so the column is informational.
--   • Backfilling would require an UPDATE on every row, which is
--     expensive at scale and unnecessary (NULL is documented as "v1").
--   • The rotation endpoint sets `key_version` explicitly when it
--     re-encrypts, so the column naturally populates as rotation proceeds.
-- ============================================================================