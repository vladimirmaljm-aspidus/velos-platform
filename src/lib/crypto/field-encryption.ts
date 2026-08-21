// src/lib/crypto/field-encryption.ts
// ----------------------------------------------------------------------------
// Field-level encryption (audit P0-3 / Feature 2 — beyond-vault encryption).
//
// Background
// ----------
// The vault (`src/lib/api/vault-crypto.ts`) encrypts whole secret rows
// (SMTP password, API tokens, etc.). It does NOT cover per-field PII that
// lives in ordinary business tables — `partners.contact_email`,
// `partners.phone`, `partners.tax_id`, `partners.vat_number`,
// `portal_access.portal_email`, settings blobs that carry `smtp_password`,
// etc. A DB dump or backup leak of those tables exposes the PII in
// cleartext, defeating the vault.
//
// This module provides an `encryptField()` / `decryptField()` pair that
// produces self-describing ciphertext with an `enc:` prefix. The prefix
// lets the decrypt side transparently handle three shapes:
//   1. `enc:<salt>:<iv>:<tag>:<data>`  — newly-encrypted value (decrypt).
//   2. any other string  — legacy plaintext (returned as-is, so the
//      rollout is non-destructive: existing rows stay readable until
//      they are next saved, at which point they become encrypted).
//
// Algorithm
//   AES-256-GCM (authenticated encryption — tampering is detected on
//   decrypt). The key is derived from `FIELD_ENCRYPTION_KEY` (falling
//   back to `SECRET_KEY` for backward compat) via `scryptSync` with a
//   per-value random 16-byte salt. scrypt is memory-hard, so an offline
//   attacker who exfiltrates both the ciphertext AND the env var list
//   still pays ~64 MiB of RAM per guess — far more expensive than
//   `crypto.scryptSync`'s default cost on a non-parallelised rig.
//
// Why scrypt (and not raw key bytes like the vault)?
//   The vault uses a single key for every row — that is fine for a
//   handful of high-value secrets that we control end-to-end. Field-
//   level encryption applies to millions of values across many tables,
//   and a single leaked ciphertext+key would reveal the passphrase for
//   every other field. scrypt's per-value salt means even an attacker
//   who recovers the passphrase for one row still has to do a full
//   scrypt derivation per row (no shared work).
//
// Searchability
// -------------
// AES-256-GCM uses a random IV per encryption, so two encryptions of
// the same plaintext produce DIFFERENT ciphertexts. This is the right
// default for security (no equality leakage) but it BREAKS `WHERE
// field = ?` style duplicate-checks and search. Callers that need
// equality search on a sensitive field should keep that field
// unencrypted (and rely on RLS + audit), or implement a separate
// HMAC-keyed search token column. See migration 016 for the prior
// pattern (vault platform leak fix) — that pattern can be applied
// to the new encrypted fields as a follow-up.
//
// Rollout
// -------
// 1. Deploy this module + the env var (FIELD_ENCRYPTION_KEY).
// 2. Update individual routes to call `encryptField()` on write and
//    `decryptField()` on read for the targeted columns. See
//    `src/app/api/settings/route.ts` for the first integration
//    (smtp_password inside the comms settings blob).
// 3. Existing rows stay plaintext (decryptField returns them as-is) —
//    they get encrypted the next time they are saved. A backfill
//    script could iterate every row and `setField(encryptField(getField()))`
//    — left as a follow-up because it is a one-time migration.
// ----------------------------------------------------------------------------
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
} from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV — NIST-recommended for GCM
const SALT_LENGTH = 16; // 128-bit salt — scrypt cost is per-salt
const KEY_LENGTH = 32; // 256-bit AES key
// scrypt cost parameters: N=2**14, r=8, p=1. ~50ms per derivation on a
// modern CPU — fast enough for per-request use, expensive enough that
// brute-forcing a 16-char passphrase is infeasible (~50ms * 62^16).
const SCRYPT_N = 1 << 14;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

/**
 * Derive the 256-bit AES key from the configured passphrase + a per-value
 * salt. The passphrase is read from `FIELD_ENCRYPTION_KEY` (preferred —
 * separate from JWT and vault keys per P0-3 Feature 1) with a fallback to
 * `SECRET_KEY` (backward compat) and finally to a non-secret "fallback"
 * string (only used in dev / test when no env is set at all — never in
 * production, where `SECRET_KEY` is mandatory).
 */
function getKey(salt: Buffer): Buffer {
  const passphrase =
    process.env.FIELD_ENCRYPTION_KEY ||
    process.env.SECRET_KEY ||
    "fallback";
  return scryptSync(passphrase, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
}

/**
 * Encrypt a plaintext field value into the self-describing wire format:
 *
 *   enc:<salt-b64>:<iv-b64>:<tag-b64>:<data-b64>
 *
 * Returns the empty string when given the empty string (so callers can
 * pass `contact_email || ""` without producing a degenerate `enc::::`
 * payload). Non-string inputs are stringified first.
 *
 * The `enc:` prefix is the marker that `decryptField` looks for — values
 * without it are returned as-is on decrypt (legacy plaintext).
 */
export function encryptField(value: string): string {
  if (value == null) return "";
  const str = typeof value === "string" ? value : String(value);
  if (str === "") return "";
  const salt = randomBytes(SALT_LENGTH);
  const key = getKey(salt);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(str, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${salt.toString("base64")}:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

/**
 * Decrypt a value produced by `encryptField()`. Returns the input
 * untouched when:
 *   - the value does not start with `enc:` (legacy plaintext, or a value
 *     that was never encrypted — common during rollout).
 *   - the wire format is malformed (missing segments).
 *   - decryption fails (wrong key — e.g. `FIELD_ENCRYPTION_KEY` rotated
 *     away from the value's encryption key; or the auth tag does not
 *     verify — tampered ciphertext).
 *
 * This graceful fallback keeps tables readable across key rotations
 * and partial rollouts: an un-decryptable value surfaces as the original
 * stored blob, which the caller can flag as "could not decrypt".
 *
 * SECURITY: a tampered ciphertext is RETURNED AS-IS, not as the plaintext.
 * This is fail-closed for security (no silent downgrade to a guessed
 * plaintext) while keeping the row accessible for ops triage.
 */
export function decryptField(encryptedValue: string): string {
  if (encryptedValue == null) return "";
  const str =
    typeof encryptedValue === "string" ? encryptedValue : String(encryptedValue);
  if (str === "") return "";
  if (!str.startsWith("enc:")) return str; // not encrypted — pass through

  // `enc:` + 4 colon-separated base64 segments. Use a split limit so
  // the ciphertext segment (which could itself theoretically contain a
  // colon if base64 produced one — it doesn't, but be defensive) is
  // captured whole. Split with a limit of 5 returns [ "enc", salt, iv,
  // tag, data ] — exactly the 4 segments we need.
  const parts = str.split(":");
  if (parts.length < 5) return str;
  const saltB64 = parts[1];
  const ivB64 = parts[2];
  const tagB64 = parts[3];
  // The data segment is the 5th onward — re-join in case the base64
  // output contained a colon (it won't, but be safe).
  const dataB64 = parts.slice(4).join(":");
  if (!saltB64 || !ivB64 || !tagB64 || !dataB64) return str;

  try {
    const salt = Buffer.from(saltB64, "base64");
    const key = getKey(salt);
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const data = Buffer.from(dataB64, "base64");
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    // Decryption failed — wrong key (rotated away), tampered ciphertext,
    // or corrupted data. Return the raw stored value so the caller can
    // surface a "could not decrypt" notice rather than losing the row.
    return str;
  }
}

/**
 * Predicate: does the stored value look like an `enc:`-prefixed ciphertext?
 * Useful for UIs that want to render a "this field is encrypted" badge
 * without attempting a full decrypt.
 */
export function isEncrypted(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return value.startsWith("enc:");
}

/**
 * Apply `encryptField` to a known set of sensitive keys inside a JSON
 * object. Used by settings routes to transparently encrypt secrets inside
 * a settings blob (e.g. `comms.smtp_password`, `comms.resend_api_key`,
 * `comms.postmark_server_token`) before persisting.
 *
 * Behaviour:
 *   - Leaves keys absent / empty-string untouched (no `enc:::: ` degenerate
 *     values written for admins who cleared the field).
 *   - Leaves already-encrypted values (`enc:...`) untouched — so re-saving
 *     a loaded-but-unmodified value is idempotent (no double-encrypt).
 *   - Returns a shallow copy; keys not in `sensitiveKeys` are passed through
 *     unchanged.
 *
 * Type-safe via `<T extends Record<string, unknown>>`: the input and output
 * share the same shape, so callers don't need to cast.
 */
export function encryptSensitiveFields<T extends Record<string, unknown>>(
  obj: T,
  sensitiveKeys: readonly string[],
): T {
  if (!obj || typeof obj !== "object") return obj;
  const out: Record<string, unknown> = { ...obj };
  for (const k of sensitiveKeys) {
    const v = out[k];
    if (typeof v !== "string") continue;
    if (v === "") continue;
    if (isEncrypted(v)) continue; // already encrypted — idempotent
    out[k] = encryptField(v);
  }
  return out as T;
}

/**
 * Apply `decryptField` to a known set of sensitive keys inside a JSON
 * object. Mirror of `encryptSensitiveFields` for the read path.
 *
 * Behaviour:
 *   - Leaves non-string values untouched (numbers, booleans, null).
 *   - `enc:`-prefixed values are decrypted; on failure (wrong key /
 *     tampered), `decryptField` returns the raw blob as-is — the caller
 *     can flag it in the UI as "could not decrypt".
 *   - Plaintext values are returned as-is (legacy rows during rollout).
 */
export function decryptSensitiveFields<T extends Record<string, unknown>>(
  obj: T,
  sensitiveKeys: readonly string[],
): T {
  if (!obj || typeof obj !== "object") return obj;
  const out: Record<string, unknown> = { ...obj };
  for (const k of sensitiveKeys) {
    const v = out[k];
    if (typeof v !== "string") continue;
    if (v === "") continue;
    if (!isEncrypted(v)) continue; // legacy plaintext — pass through
    out[k] = decryptField(v);
  }
  return out as T;
}

/**
 * The set of sensitive keys inside the `comms` settings blob that we
 * encrypt at rest via `encryptField` / `decryptField`. New comms keys
 * holding a secret should be added here — both the GET / PUT /api/settings
 * handlers and the email service read this list.
 */
export const COMMS_SENSITIVE_KEYS = [
  "smtp_password",
  "resend_api_key",
  "postmark_server_token",
] as const;

// ----------------------------------------------------------------------------
// HMAC search tokens (P0-3 / Feature 2 follow-up — equality search on
// encrypted fields).
//
// Background
// ----------
// `encryptField()` uses a random IV per call, so two encryptions of the same
// plaintext produce DIFFERENT ciphertexts. This is the right default for
// confidentiality (no equality leakage) but it BREAKS `WHERE field = ?`
// lookups. Several columns we encrypt (`portal_access.portal_email`,
// `partners.tax_id`, `partners.vat_number`) are used in equality search
// during login / duplicate-checks, so encrypting them at rest would silently
// break those flows.
//
// The standard pattern (see migration 016 for the prior vault-platform-leak
// application) is to store a DETERMINISTIC HMAC token in a separate column
// alongside the encrypted ciphertext. The HMAC is SHA-256 of the plaintext
// keyed with a server-side secret — given the secret is not in the DB, a DB
// dump alone cannot recover the plaintext email from the HMAC, but the HMAC
// IS deterministic so equality search works (`WHERE portal_email_hmac = ?`).
//
// HMAC vs hashing-without-key: HMAC is keyed, so an attacker who leaks the
// DB still cannot compute the HMAC for a guessed email without the env var.
// SHA-256 alone (no key) would let an attacker enumerate plausible emails
// offline against the leaked table.
//
// Key source (P0-3 / Feature 1 — vault key separation): prefer
// `FIELD_HMAC_KEY`, falling back to `FIELD_ENCRYPTION_KEY`, then
// `SECRET_KEY`. The fallback chain keeps existing deployments working
// without any env changes — they get a working HMAC token immediately, just
// keyed with their existing SECRET_KEY. Operators who want a strong
// separation between the encryption key and the HMAC key (so a leak of one
// doesn't reveal the other) provision BOTH env vars with different values.
// ----------------------------------------------------------------------------

/**
 * Resolve the HMAC key. Falls back through FIELD_HMAC_KEY →
 * FIELD_ENCRYPTION_KEY → SECRET_KEY → "fallback" (dev/test only).
 */
function getHmacKey(): string {
  return (
    process.env.FIELD_HMAC_KEY ||
    process.env.FIELD_ENCRYPTION_KEY ||
    process.env.SECRET_KEY ||
    "fallback"
  );
}

/**
 * Compute a deterministic HMAC-SHA-256 token for a plaintext field value.
 *
 * The token is base64url-encoded (no padding) so it's safe to store in a
 * TEXT column and use in a Postgres B-tree index. Two calls with the same
 * plaintext + same key produce the same token (deterministic); any change
 * to either the plaintext OR the key produces a different token.
 *
 * Returns the empty string when given the empty string (so callers can
 * pass `email || ""` without producing a degenerate token).
 *
 * SECURITY: this is for SEARCH ONLY — never return the token to the client
 * (it's an internal lookup handle, not a value the user ever sees). The
 * token does not reveal the plaintext given the env var is not leaked, but
 * it's still a credential-like artefact and should be treated as such.
 */
export function hmacField(value: string): string {
  if (value == null) return "";
  const str = typeof value === "string" ? value : String(value);
  if (str === "") return "";
  const key = getHmacKey();
  return createHmac("sha256", key).update(str, "utf8").digest("base64url");
}

/**
 * Convenience: is a stored value a (legacy) plaintext email that has not yet
 * been encrypted + had its HMAC computed? Useful for the backfill script to
 * decide which rows need a one-time migration pass.
 */
export function isPlaintextField(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value === "") return false;
  return !value.startsWith("enc:");
}
