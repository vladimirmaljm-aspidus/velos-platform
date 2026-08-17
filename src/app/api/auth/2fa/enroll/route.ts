import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { generateTotpSecret, generateTotpUri, generateRecoveryCodes } from "@/lib/auth/totp";

export const runtime = "nodejs";

/**
 * POST /api/auth/2fa/enroll
 *
 * Begin 2FA enrollment for the authenticated user. Generates a new TOTP
 * secret, stores it on the user row (`totp_secret` set, `totp_enabled`
 * left false — the user must verify a code at /api/auth/2fa/verify to
 * activate), and returns the otpauth:// URI + 10 one-time recovery codes.
 *
 * The recovery codes are returned EXACTLY ONCE in plaintext here. The
 * hashed versions are persisted at /verify (NOT here) — so if the user
 * abandons enrollment after this call, no recovery codes exist on the
 * account and the stored secret is harmless (login still skips TOTP
 * because totp_enabled=false).
 *
 * CRITICAL: super_admin CAN call this route (they may want 2FA on their
 * own account), but it's optional — super_admin is NEVER required to
 * use 2FA (the login route bypasses the 2FA check for super_admin
 * regardless of totp_enabled).
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;

    // Refetch the user — `auth.user` is the SafeUser view that strips
    // totp_secret + totp_enabled. We need the raw values to check
    // existing 2FA state.
    const user = await auth.store.getUserById(auth.user.id);
    if (!user || !user.active) {
      return NextResponse.json({ error: "Account not found." }, { status: 404 });
    }

    // Don't allow re-enrollment over an already-active 2FA — force the
    // user to disable first. This makes the audit trail clearer (we
    // log a fresh `auth.2fa.enroll` action) and prevents an attacker
    // who briefly holds the session from silently rotating the victim's
    // TOTP secret and locking them out.
    if (user.totp_enabled) {
      return NextResponse.json(
        { error: "Two-factor authentication is already active. Disable it first to re-enroll." },
        { status: 409 },
      );
    }

    const secret = generateTotpSecret();
    const uri = generateTotpUri(secret, user.email || user.username);
    const recoveryCodes = generateRecoveryCodes();

    // Store the secret but DO NOT activate yet. If the user abandons
    // enrollment here, the secret is harmless (login still skips TOTP
    // because totp_enabled=false). The recovery codes are NOT stored
    // here — they're hashed + persisted at /verify, so an abandoned
    // enrollment leaves no recovery-code surface.
    await auth.store.upsertUser({
      id: user.id,
      totp_secret: secret,
      totp_enabled: false,
      recovery_codes: null,
    });

    await audit(
      auth.store,
      auth.user,
      req,
      "auth.2fa.enroll",
      "auth",
      user.id,
      { step: "secret_generated" },
    );

    return NextResponse.json({
      qrUri: uri,
      secret, // shown as text fallback for manual entry
      recoveryCodes,
      message: "Scan the QR code with your authenticator app, then verify a code to activate 2FA. Save your recovery codes now — they will not be shown again.",
    });
  } catch (e) {
    console.error("[2fa.enroll]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
