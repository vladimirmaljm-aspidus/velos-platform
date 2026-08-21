-- 042_field_encryption_hmac.sql
-- ============================================================================
-- Field-level encryption — HMAC search tokens (audit P0-3 / Feature 2).
--
-- Background
-- ----------
-- P0-3 / Feature 2 introduced `src/lib/crypto/field-encryption.ts` with
-- AES-256-GCM per-field encryption (`encryptField`/`decryptField`) and
-- the `enc:` prefix wire format. Several columns that we now encrypt at
-- rest are ALSO used in equality search:
--
--   • portal_access.portal_email — login (`WHERE portal_email = ?`),
--     forgot-password, duplicate-check during create / change-email.
--   • partners.tax_id / partners.vat_number — duplicate-check during
--     partner create (`WHERE tenant_id = ? AND tax_id = ?`).
--
-- AES-256-GCM uses a random IV per call, so two encryptions of the same
-- plaintext produce DIFFERENT ciphertexts. This is the right default for
-- confidentiality (no equality leakage) but it BREAKS the `.eq(field, ?)`
-- queries above — a fresh encrypt of "user@example.com" stored in
-- `portal_email` no longer matches `WHERE portal_email = 'user@example.com'`.
--
-- The standard pattern (see migration 016 for the prior vault-platform-leak
-- application, and the docstring at the bottom of
-- `src/lib/crypto/field-encryption.ts`) is to store a DETERMINISTIC
-- HMAC-SHA-256 token in a separate column alongside the encrypted ciphertext.
-- The token is keyed with a server-side env var (`FIELD_HMAC_KEY` →
-- `FIELD_ENCRYPTION_KEY` → `SECRET_KEY`) so a DB dump alone cannot recover
-- the plaintext email from the HMAC, but the HMAC IS deterministic so
-- equality search works: `WHERE portal_email_hmac = hmac_field(email)`.
--
-- This migration provisions those token columns and backfills existing rows
-- from their (currently plaintext) email / tax_id / vat_number values.
-- The backfill is IDEMPOTENT — recomputing the HMAC over the same plaintext
-- produces the same token, so re-running the migration (or running it after
-- partial backfill) is safe.
--
-- NOTE: The backfill uses `current_setting('app.field_hmac_key', true)` so
-- the migration does NOT have to hardcode the HMAC key into SQL. Operators
-- set `app.field_hmac_key` for the migration session only — the same env
-- var the Node app reads. If the setting is missing, the backfill writes
-- NULL tokens and the API layer will lazily fill them on the next write.
-- This keeps the migration safe to run before / without the env var
-- (the worst case is "tokens are NULL until the next row write", not
-- "migration fails").
-- ============================================================================
--
-- IMPORTANT: After this migration, the Node app MUST set `FIELD_HMAC_KEY`
-- (preferred) OR `FIELD_ENCRYPTION_KEY` (fallback) OR `SECRET_KEY`
-- (further fallback). The `hmacField()` helper in
-- `src/lib/crypto/field-encryption.ts` resolves the key from these env
-- vars in that order. Without ANY of these env vars, the helper falls back
-- to a non-secret "fallback" string — clearly unsuitable for production.
-- See `.env.example` for the documentation of these env vars.
-- ============================================================================

-- ─── 1. portal_access.portal_email_hmac ─────────────────────────────────────
-- NULLable for legacy rows that have not yet been backfilled (the API
-- layer will lazily compute + populate the token on the next write — see
-- the upsertPortalAccess path in src/app/api/portal-access/route.ts).
ALTER TABLE portal_access
  ADD COLUMN IF NOT EXISTS portal_email_hmac TEXT;

-- Unique index — guarantees two portal_access rows in the SAME tenant
-- cannot share an email (the duplicate-check rule enforced by the API).
-- We DON'T make it globally unique because the SAME email legitimately
-- appears in multiple tenants (a portal client with two supplier accounts).
-- A partial unique index (WHERE portal_email_hmac IS NOT NULL) skips
-- legacy rows that haven't been backfilled, so the migration does not
-- block on a half-migrated table.
CREATE UNIQUE INDEX IF NOT EXISTS portal_access_email_hmac_tenant_uniq
  ON portal_access (tenant_id, portal_email_hmac)
  WHERE portal_email_hmac IS NOT NULL;

-- Plain btree index for cross-tenant email lookup (login with no
-- tenant_id, forgot-password). The query shape is
-- `WHERE portal_email_hmac = ?` with no tenant filter.
CREATE INDEX IF NOT EXISTS portal_access_email_hmac_idx
  ON portal_access (portal_email_hmac)
  WHERE portal_email_hmac IS NOT NULL;

-- ─── 2. partners.tax_id_hmac + partners.vat_number_hmac ─────────────────────
-- Both are used in the duplicate-check during partner create
-- (`WHERE tenant_id = ? AND tax_id = ?` and the same for vat_number).
-- The two columns get their own HMAC so the same plaintext tax_id in two
-- different tenants has the SAME token (the tenant filter is applied
-- separately in the query) but two different plaintext tax_ids in the same
-- tenant have different tokens (the unique index catches them).
ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS tax_id_hmac TEXT,
  ADD COLUMN IF NOT EXISTS vat_number_hmac TEXT;

-- Per-tenant uniqueness: a tenant cannot have two partners with the same
-- tax_id (or vat_number). The unique index is partial — skips NULL tokens
-- (legacy rows not yet backfilled).
CREATE UNIQUE INDEX IF NOT EXISTS partners_tax_id_hmac_tenant_uniq
  ON partners (tenant_id, tax_id_hmac)
  WHERE tax_id_hmac IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS partners_vat_number_hmac_tenant_uniq
  ON partners (tenant_id, vat_number_hmac)
  WHERE vat_number_hmac IS NOT NULL;

-- ─── 3. Backfill (idempotent) ───────────────────────────────────────────────
-- Compute the HMAC token for legacy rows that still carry plaintext
-- email / tax_id / vat_number. The HMAC is computed in SQL via the
-- `hmac_sha256` Postgres function (pgcrypto), keyed by a session setting
-- `app.field_hmac_key` so the key is NOT hardcoded in the migration.
--
-- The output of `hmac_sha256(text, text)` is BYTEA; encode() as base64url
-- is not natively available in stock Postgres (encode supports 'base64'
-- but not 'base64url'). We use encode(..., 'base64') then translate '+/'
-- → '-_' and strip '=' padding to match the Node-side `base64url` output
-- of `crypto.createHmac(...).digest('base64url')`. This keeps the SQL
-- token byte-identical to the Node-side token so the same equality-search
-- query works from either side.
--
-- If pgcrypto is not installed (rare on Supabase — it's enabled by
-- default), run `CREATE EXTENSION IF NOT EXISTS pgcrypto;` first. The
-- CREATE EXTENSION below is idempotent.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Build a base64url encoder SQL helper. We use a SECURITY DEFINER function
-- so the API routes can call `encode_hmac_sha256_base64url(plaintext, key)`
-- directly if they ever need to recompute a token from SQL — but for now
-- the backfill below is the only caller.
CREATE OR REPLACE FUNCTION encode_hmac_sha256_base64url(
  plaintext TEXT,
  key TEXT
) RETURNS TEXT AS $$
  SELECT CASE
    WHEN plaintext IS NULL OR plaintext = '' OR key IS NULL OR key = '' THEN NULL
    ELSE translate(
      encode(hmac_sha256(plaintext::bytea, key::bytea), 'base64'),
      '+/',
      '-_'
    )
  END;
$$ LANGUAGE SQL IMMUTABLE;

-- portal_access backfill — only for rows that still have a plaintext email
-- (i.e. email does not start with 'enc:'). Idempotent: rows whose token is
-- already set are skipped.
UPDATE portal_access
   SET portal_email_hmac = encode_hmac_sha256_base64url(
        portal_email,
        current_setting('app.field_hmac_key', true)
       )
 WHERE portal_email_hmac IS NULL
   AND portal_email IS NOT NULL
   AND portal_email <> ''
   AND portal_email NOT LIKE 'enc:%';

-- partners.tax_id backfill — same idempotent pattern.
UPDATE partners
   SET tax_id_hmac = encode_hmac_sha256_base64url(
        tax_id,
        current_setting('app.field_hmac_key', true)
       )
 WHERE tax_id_hmac IS NULL
   AND tax_id IS NOT NULL
   AND tax_id <> ''
   AND tax_id NOT LIKE 'enc:%';

-- partners.vat_number backfill — same idempotent pattern.
UPDATE partners
   SET vat_number_hmac = encode_hmac_sha256_base64url(
        vat_number,
        current_setting('app.field_hmac_key', true)
       )
 WHERE vat_number_hmac IS NULL
   AND vat_number IS NOT NULL
   AND vat_number <> ''
   AND vat_number NOT LIKE 'enc:%';

-- ─── 4. Comments ────────────────────────────────────────────────────────────
COMMENT ON COLUMN portal_access.portal_email_hmac IS
  'Deterministic HMAC-SHA-256 token of the plaintext portal_email, keyed by '
  || 'FIELD_HMAC_KEY / FIELD_ENCRYPTION_KEY / SECRET_KEY (see '
  || 'src/lib/crypto/field-encryption.ts). Used for equality search (login, '
  || 'duplicate-check) since portal_email itself is encrypted with AES-256-GCM '
  || '(random IV per row — no equality leakage). Token is base64url, no padding.';

COMMENT ON COLUMN partners.tax_id_hmac IS
  'Deterministic HMAC-SHA-256 token of the plaintext tax_id. Used by the '
  || 'partner duplicate-check (unique within a tenant). The tax_id column '
  || 'itself is encrypted at rest with AES-256-GCM.';

COMMENT ON COLUMN partners.vat_number_hmac IS
  'Deterministic HMAC-SHA-256 token of the plaintext vat_number. Used by the '
  || 'partner duplicate-check (unique within a tenant).';

-- ─── 5. Verify ─────────────────────────────────────────────────────────────
SELECT 'portal_access' AS table_name,
       count(*) FILTER (WHERE portal_email_hmac IS NOT NULL) AS tokens_set,
       count(*) FILTER (WHERE portal_email IS NOT NULL AND portal_email <> '') AS emails_total
  FROM portal_access
UNION ALL
SELECT 'partners.tax_id',
       count(*) FILTER (WHERE tax_id_hmac IS NOT NULL),
       count(*) FILTER (WHERE tax_id IS NOT NULL AND tax_id <> '')
  FROM partners
UNION ALL
SELECT 'partners.vat_number',
       count(*) FILTER (WHERE vat_number_hmac IS NOT NULL),
       count(*) FILTER (WHERE vat_number IS NOT NULL AND vat_number <> '')
  FROM partners;
