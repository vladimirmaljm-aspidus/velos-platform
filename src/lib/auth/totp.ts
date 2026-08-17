/**
 * TOTP (Time-based One-Time Password) helpers for 2FA.
 *
 * Backed by `otplib` v13's functional API (RFC 6238). Used by:
 *   - POST /api/auth/2fa/enroll    — generate secret + QR URI + recovery codes
 *   - POST /api/auth/2fa/verify    — verify a token, activate 2FA
 *   - POST /api/auth/2fa/disable   — disable 2FA (current password or token)
 *   - POST /api/auth/2fa/recovery  — verify a recovery code, temporarily disable
 *   - POST /api/auth/2fa/login     — verify a token with a short-lived temp JWT
 *
 * CRITICAL: super_admin accounts (role=super_admin, tenant_id=null) bypass 2FA
 * entirely. They can always log in with just a password and are never prompted
 * for a TOTP code. The bypass is enforced in the login route, not here — these
 * helpers are pure utility functions.
 *
 * otplib v13 API notes
 *   v13 dropped the `authenticator` class wrapper that v12 had. The functional
 *   API is now the canonical surface:
 *     - `generateSecret()` → base32 secret string
 *     - `generateURI({ issuer, label, secret, digits, period })` → otpauth:// URI
 *     - `verify({ secret, token, epochTolerance })` → Promise<{ valid, delta }>
 *   `verify` is async because the crypto plugin is pluggable; the default
 *   NobleCryptoPlugin is sync-capable but the type signature is async to allow
 *   async plugins. We `await` it.
 */

import { createHash } from "crypto";
import { generateSecret, generateURI, verify } from "otplib";

// 6-digit codes, 30s step — the de-facto TOTP standard. Matches Google
// Authenticator, Authy, 1Password, etc. without any client-side fiddling.
// These defaults are baked into every call below so a future caller can't
// accidentally diverge.
const TOTP_DIGITS = 6;
const TOTP_PERIOD = 30;
// Tolerance window in seconds for verify — ±1 step (30s past + 30s future)
// handles minor clock drift between the user's phone and our server. This
// is what every mainstream authenticator app expects.
const TOTP_TOLERANCE_SEC = 30;

/**
 * Generate a new base32 TOTP secret. The user scans the QR code derived
 * from this; their authenticator app stores it and uses it to compute tokens.
 */
export function generateTotpSecret(): string {
  return generateSecret();
}

/**
 * Build the `otpauth://` URI that QR-code generators expect. The label
 * (email) appears as the account name in the user's authenticator app;
 * "VELOS" is the issuer.
 */
export function generateTotpUri(secret: string, email: string): string {
  return generateURI({
    issuer: "VELOS",
    label: email,
    secret,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD,
  });
}

/**
 * Verify a TOTP token against a secret. Returns false on any error
 * (malformed token, wrong secret, expired) — never throws — so the
 * caller can treat "bad code" and "TOTP backend blew up" the same way.
 *
 * The ±1-step (30s) tolerance window handles minor clock drift between
 * the user's phone and our server — same as every mainstream
 * authenticator app.
 */
export async function verifyTotp(token: string, secret: string): Promise<boolean> {
  try {
    const result = await verify({
      secret,
      token,
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD,
      epochTolerance: TOTP_TOLERANCE_SEC,
    });
    return !!result?.valid;
  } catch {
    return false;
  }
}

/**
 * The character pool for recovery codes. Excludes visually-ambiguous
 * characters (0/O, 1/I) so users typing them by hand don't trip over
 * look-alikes. 34 characters, so 16-char codes have ~80 bits of entropy
 * — far beyond any realistic brute-force budget for one-shot codes that
 * are deleted on first use.
 */
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Generate 10 one-time recovery codes (16 chars each). Returned to the
 * user exactly once at enrollment time — they must save them somewhere
 * safe. Each code can be used in place of a TOTP token at login to
 * temporarily disable 2FA on the account (the user is then prompted to
 * re-enroll).
 *
 * Codes are stored hashed (sha256) in the DB, so a DB read doesn't
 * recover them — see POST /api/auth/2fa/verify for the hashing flow.
 */
export function generateRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () =>
    Array.from(
      { length: 16 },
      () => RECOVERY_ALPHABET[Math.floor(Math.random() * RECOVERY_ALPHABET.length)],
    ).join(""),
  );
}

/**
 * Hash a recovery code with sha256. We store only the hash in the DB —
 * a DB leak then does NOT hand the attacker usable recovery codes
 * (they'd need to brute-force 80-bit codes offline, which is infeasible).
 *
 * The caller passes the user-entered (or DB-stored, raw) code; this
 * returns the hex digest to compare against the stored hash list.
 */
export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}
