import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { verifyTotp, hashRecoveryCode } from "@/lib/auth/totp";

export const runtime = "nodejs";

/**
 * POST /api/auth/2fa/verify
 *
 * Verify a TOTP token against the user's stored secret and activate 2FA.
 * On success, the 10 recovery-code hashes (provided by the caller from
 * the /enroll response) are persisted on the user row. From this point
 * forward, login will require a TOTP token (or recovery code) — the
 * `totp_enabled` flag becomes true.
 *
 * Body: { token: string, recoveryCodes: string[] }
 *
 * CRITICAL: super_admin activation is allowed but, again, the login
 * route bypasses the 2FA check for super_admin regardless. The activation
 * is still meaningful: it logs the audit event and persists the secret
 * so the super_admin's authenticator app shows VELOS.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;

    // Refetch the user — `auth.user` is the SafeUser view that strips
    // totp_secret. We need the raw secret to verify the token.
    const user = await auth.store.getUserById(auth.user.id);
    if (!user || !user.active) {
      return NextResponse.json({ error: "Account not found." }, { status: 404 });
    }
    if (!user.totp_secret) {
      return NextResponse.json(
        { error: "No 2FA enrollment in progress. Call /api/auth/2fa/enroll first." },
        { status: 400 },
      );
    }
    if (user.totp_enabled) {
      return NextResponse.json(
        { error: "Two-factor authentication is already active." },
        { status: 409 },
      );
    }

    const body = await req.json().catch(() => ({}));
    const token = String(body?.token || "").trim();
    const recoveryCodes: unknown = body?.recoveryCodes;
    if (!token) {
      return NextResponse.json({ error: "Token is required." }, { status: 400 });
    }
    // Recovery codes are required ONLY for fresh enrollment (when totp_secret
    // is null — first-time setup). After a recovery-code login, totp_secret is
    // kept but recovery_codes are cleared + totp_enabled=false. In that state,
    // the user re-verifies with just a TOTP token (no new recovery codes yet);
    // the verify route generates fresh recovery codes for them.
    const isReEnrollAfterRecovery = !!user.totp_secret && !user.totp_enabled;
    if (!isReEnrollAfterRecovery && (!Array.isArray(recoveryCodes) || recoveryCodes.length === 0)) {
      return NextResponse.json(
        { error: "Recovery codes are required. Re-run enrollment if you didn't save them." },
        { status: 400 },
      );
    }
    // Coerce + validate the recovery codes shape before persisting.
    // recoveryCodes is `unknown` from the body; narrow to string[] first.
    const codesArray = Array.isArray(recoveryCodes) ? (recoveryCodes as unknown[]) : [];
    const cleanCodes = codesArray
      .filter((c): c is string => typeof c === "string" && c.length >= 8)
      .map((c) => c.trim().toUpperCase())
      .filter((c) => c.length > 0);
    if (cleanCodes.length === 0) {
      return NextResponse.json(
        { error: "Recovery codes must be strings of at least 8 characters." },
        { status: 400 },
      );
    }

    // Verify the TOTP token against the stored secret. A wrong token
    // does NOT abort the enrollment (the user can re-call /enroll),
    // but it does block activation — prevents an attacker who briefly
    // holds the session from activating with a guessable code.
    if (!(await verifyTotp(token, user.totp_secret))) {
      await audit(
        auth.store,
        auth.user,
        req,
        "auth.2fa.verify_failed",
        "auth",
        auth.user.id,
        { reason: "bad_token" },
      );
      return NextResponse.json({ error: "Invalid TOTP token." }, { status: 400 });
    }

    // Hash + persist the recovery codes. SHA-256 hex strings — see
    // src/lib/auth/totp.ts `hashRecoveryCode` for rationale.
    const hashes = cleanCodes.map((c) => hashRecoveryCode(c));
    await auth.store.upsertUser({
      id: user.id,
      totp_secret: user.totp_secret,
      totp_enabled: true,
      recovery_codes: hashes,
    });

    await audit(
      auth.store,
      auth.user,
      req,
      "auth.2fa.activate",
      "auth",
      user.id,
      { recovery_code_count: hashes.length },
    );

    return NextResponse.json({ activated: true });
  } catch (e) {
    console.error("[2fa.verify]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
