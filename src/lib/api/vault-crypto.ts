import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

/**
 * Vault secret encryption helper with key versioning (audit P2-3 / task C-7).
 *
 * Uses AES-256-GCM (authenticated encryption) so any tampering with the
 * ciphertext is detected on decrypt. The wire format is:
 *
 *   v<version>:<iv-base64>:<authTag-base64>:<ciphertext-base64>
 *
 * Where `<version>` is a small integer (1, 2, 3, ...) identifying which
 * key was used to encrypt the value. The version lets us rotate the
 * encryption key without re-encrypting every row in a single transaction:
 *
 *   1. Deploy code that knows about both `SECRET_KEY` (v1) and the new
 *      `SECRET_KEY_V2` (v2). New writes use v2; old rows still decrypt
 *      because `decrypt()` looks up the version from the wire format.
 *   2. Run `rotateAllVaultSecrets()` (or the `/api/vault/rotate` admin
 *      endpoint) which reads each row, decrypts with the version-specific
 *      key, and re-encrypts with the current key.
 *   3. Once all rows report `key_version = <current>`, remove `SECRET_KEY`
 *      from the env (or keep it as a long-term backup).
 *
 * Backward compatibility:
 *   - `decrypt()` accepts legacy plaintext (no colons in the value) and
 *     returns it as-is. This lets us roll out encryption without migrating
 *     existing rows — old secrets stay readable until they are next saved,
 *     at which point they become encrypted.
 *   - `decrypt()` accepts the OLD wire format (3 colon-separated base64
 *     chunks, no `v<version>:` prefix) and treats it as v1 (the original
 *     key from `SECRET_KEY`).
 *   - If decryption fails for any reason (wrong key, corrupted data, etc.),
 *     the original value is returned untouched so the vault stays readable
 *     even if all keys are rotated/lost. Log the failure upstream.
 *
 * Key source (P0-3 / Feature 1 — vault key separation):
 *   - v1: `process.env.VAULT_KEY_V2 || process.env.SECRET_KEY_V1 || process.env.SECRET_KEY`.
 *     The preferred source is `VAULT_KEY_V2` — a vault-only secret that is
 *     NOT used to sign JWTs. Deployments that have not yet provisioned it
 *     fall back to `SECRET_KEY` (the legacy single-secret model) so the
 *     rollout is non-destructive: existing vault rows decrypt exactly as
 *     before, and new encryptions use the same key until the operator
 *     sets `VAULT_KEY_V2`.
 *   - vN (N ≥ 2): `process.env.SECRET_KEY_V<N>`. Optional — only set when
 *     a rotation is in progress.
 *   - The CURRENT key version is `process.env.VAULT_KEY_VERSION` (default
 *     "1"). When unset, all new encryptions use v1 (the original key),
 *     preserving the previous behaviour bit-for-bit.
 *   - The JWT signing key lives in `JWT_SECRET_KEY` (see
 *     src/lib/auth/session.ts); the vault never reads it. A JWT-key
 *     compromise therefore cannot decrypt the vault, and a vault-key
 *     leak cannot forge session tokens.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;

/**
 * The key version used for NEW encryptions. Defaults to "1" so existing
 * deployments keep working without any env changes — only operators who
 * are actively rotating need to set `VAULT_KEY_VERSION=2` (and provision
 * `SECRET_KEY_V2`).
 */
function getCurrentKeyVersion(): string {
  const v = process.env.VAULT_KEY_VERSION;
  // Treat empty string / "0" as "1" (v1 is the lowest legal version).
  if (!v || v === "0") return "1";
  return v;
}

/**
 * Resolve the AES-256 key for a given version.
 *
 *   v1: prefer `VAULT_KEY_V2` (P0-3 / Feature 1 — vault key separation),
 *       falling back to `SECRET_KEY` for backward compatibility, then to
 *       `SECRET_KEY_V1` for deployments that already split the v1 secret
 *       under that name. The fallback chain keeps existing deployments
 *       working bit-for-bit: only operators who actively want the vault
 *       / JWT key separation need to provision `VAULT_KEY_V2`.
 *   vN (N ≥ 2): `SECRET_KEY_V<N>` env var. This must be set if `decrypt()`
 *       is asked to read a value encrypted with version N.
 *
 * Throws if the resolved env var is missing or shorter than 16 chars.
 */
function getKeyForVersion(version: string): Buffer {
  const envName = version === "1" ? "SECRET_KEY" : `SECRET_KEY_V${version}`;
  // P0-3 / Feature 1: prefer a vault-only env var so a JWT-key compromise
  // does not automatically compromise the vault (and vice versa). The chain
  // is: VAULT_KEY_V2 → SECRET_KEY_V1 → SECRET_KEY. We intentionally do NOT
  // fall back to JWT_SECRET_KEY — the whole point is to keep these two
  // secrets separate. A misconfigured deployment that sets only
  // JWT_SECRET_KEY (no SECRET_KEY, no VAULT_KEY_V2) will throw here, which
  // is the desired behaviour: vault reads fail loud rather than silently
  // using the JWT key.
  let raw: string | undefined;
  if (version === "1") {
    raw = process.env.VAULT_KEY_V2 || process.env.SECRET_KEY_V1 || process.env.SECRET_KEY;
  } else {
    raw = process.env[`SECRET_KEY_V${version}`];
  }
  if (!raw || raw.length < 16) {
    throw new Error(
      `${envName} (or VAULT_KEY_V2) environment variable is required (min 16 chars) to decrypt ` +
        `vault secrets encrypted with key version ${version}. ` +
        `Set it in your .env or Render env vars.`,
    );
  }
  return Buffer.from(raw.padEnd(32, "0").slice(0, 32), "utf8");
}

/** The CURRENT key (used for new `encrypt()` calls). */
function getKey(): Buffer {
  return getKeyForVersion(getCurrentKeyVersion());
}

/**
 * Encrypt a plaintext secret into the colon-separated wire format. Returns
 * the empty string when given the empty string.
 *
 * The output is prefixed with `v<version>:` so `decrypt()` knows which key
 * to use. Old rows that were encrypted before this versioning existed
 * (3-part format, no `v` prefix) are still readable — `decrypt()` treats
 * them as v1.
 */
export function encrypt(text: string): string {
  if (text == null) return "";
  const str = typeof text === "string" ? text : String(text);
  if (str === "") return "";
  const version = getCurrentKeyVersion();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(str, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v${version}:${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

/**
 * Decrypt a value produced by `encrypt()`. Returns the original input
 * untouched when:
 *   - the value does not look like our wire format (legacy plaintext), or
 *   - decryption fails (wrong key, tampered ciphertext, etc.).
 *
 * This graceful fallback keeps the vault readable across key rotations and
 * migrations — at the cost of failing CLOSED for security (decrypt returns
 * the encrypted blob rather than the plaintext, which the UI can flag as
 * "could not decrypt").
 *
 * Wire format detection:
 *   • 4 parts, first starts with `v` + digits → versioned format (v<ver>:...)
 *   • 3 parts (no `v` prefix) → legacy v1 format (pre-versioning)
 *   • anything else → legacy plaintext, returned as-is
 */
export function decrypt(encryptedValue: string): string {
  if (encryptedValue == null) return "";
  const str = typeof encryptedValue === "string" ? encryptedValue : String(encryptedValue);
  if (str === "") return "";

  const parts = str.split(":");

  // Versioned format: v<version>:<iv>:<authTag>:<ciphertext>
  if (parts.length === 4) {
    const versionPart = parts[0];
    const versionMatch = versionPart.match(/^v(\d+)$/);
    if (versionMatch) {
      const version = versionMatch[1];
      const ivB64 = parts[1];
      const authTagB64 = parts[2];
      const dataB64 = parts[3];
      if (!ivB64 || !authTagB64 || !dataB64) return str;
      try {
        const iv = Buffer.from(ivB64, "base64");
        const authTag = Buffer.from(authTagB64, "base64");
        const encrypted = Buffer.from(dataB64, "base64");
        const decipher = createDecipheriv(ALGORITHM, getKeyForVersion(version), iv);
        decipher.setAuthTag(authTag);
        return decipher.update(encrypted).toString("utf8") + decipher.final("utf8");
      } catch {
        // Decryption failed (wrong key / tampered / corrupted / key env
        // var not set). Return the raw stored value so the caller can
        // surface a "could not decrypt" notice.
        return str;
      }
    }
    // 4 parts but doesn't start with v<digits> — fall through to other checks.
  }

  // Legacy v1 format: <iv>:<authTag>:<ciphertext> (3 parts, no version prefix).
  if (parts.length === 3) {
    const [ivB64, authTagB64, dataB64] = parts;
    if (!ivB64 || !authTagB64 || !dataB64) return str;
    try {
      const iv = Buffer.from(ivB64, "base64");
      const authTag = Buffer.from(authTagB64, "base64");
      const encrypted = Buffer.from(dataB64, "base64");
      const decipher = createDecipheriv(ALGORITHM, getKeyForVersion("1"), iv);
      decipher.setAuthTag(authTag);
      return decipher.update(encrypted).toString("utf8") + decipher.final("utf8");
    } catch {
      // v1 decryption failed (key rotated away from SECRET_KEY, or tampered).
      return str;
    }
  }

  // Legacy plaintext — no colons, or unexpected shape. Return as-is.
  return str;
}

/**
 * The current key version (string, e.g. "1", "2"). Exposed so the vault
 * route can store it alongside the encrypted value (the `key_version`
 * column on `vault_secrets` added by migration 035) — purely for ops
 * visibility (e.g. "how many rows still use v1?"). The wire format itself
 * is the source of truth at decrypt time.
 */
export function currentKeyVersion(): string {
  return getCurrentKeyVersion();
}

/**
 * Parse the key version out of a stored encrypted value. Returns:
 *   - "1" if the value uses the legacy 3-part format (pre-versioning).
 *   - the parsed version string (e.g. "2") if the value is in the new
 *     `v<version>:...` format.
 *   - `null` if the value is legacy plaintext (no colons / unexpected shape).
 *
 * Used by the rotation function and the vault list endpoint to surface
 * per-row key versions in the admin UI.
 */
export function parseKeyVersion(encryptedValue: string): string | null {
  if (encryptedValue == null) return null;
  const str = typeof encryptedValue === "string" ? encryptedValue : String(encryptedValue);
  if (str === "") return null;
  const parts = str.split(":");
  if (parts.length === 4) {
    const m = parts[0].match(/^v(\d+)$/);
    if (m) return m[1];
  }
  if (parts.length === 3) return "1";
  return null;
}

/**
 * Rotate all vault secrets to the current key version.
 *
 * Reads each row, decrypts (using whatever key version the row was
 * originally encrypted with), re-encrypts with the current key, and
 * writes the new ciphertext + key_version back. Designed to be called
 * from a super-admin endpoint (e.g. `POST /api/vault/rotate`) — the
 * caller is responsible for auth/permission checks.
 *
 * Returns a summary: { total, rotated, skipped, errors }.
 *
 * Idempotent: rows that are already at the current version are skipped
 * (no DB write).
 */
export async function rotateAllVaultSecrets(
  listFn: () => Promise<Array<{ id: string; encrypted_value: string }>>,
  updateFn: (id: string, encrypted_value: string, key_version: string) => Promise<void>,
): Promise<{ total: number; rotated: number; skipped: number; errors: Array<{ id: string; error: string }> }> {
  const targetVersion = getCurrentKeyVersion();
  const rows = await listFn();
  let rotated = 0;
  let skipped = 0;
  const errors: Array<{ id: string; error: string }> = [];

  for (const row of rows) {
    const currentVersion = parseKeyVersion(row.encrypted_value);
    if (currentVersion === targetVersion) {
      // Already at the target version — skip (no DB write needed).
      skipped++;
      continue;
    }
    // Decrypt with the original key, then re-encrypt with the current key.
    const plaintext = decrypt(row.encrypted_value);
    // If decrypt() returned the raw stored value (couldn't decrypt), the
    // re-encryption would just wrap an opaque blob — that's safe but
    // pointless. Surface it as an error so the operator knows.
    if (plaintext === row.encrypted_value && currentVersion !== null) {
      errors.push({
        id: row.id,
        error: `Could not decrypt with key version ${currentVersion} (missing env var or wrong key).`,
      });
      continue;
    }
    try {
      const newCiphertext = encrypt(plaintext);
      await updateFn(row.id, newCiphertext, targetVersion);
      rotated++;
    } catch (e: any) {
      errors.push({ id: row.id, error: e?.message || String(e) });
    }
  }

  return { total: rows.length, rotated, skipped, errors };
}
