import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, getIp, sanitizeError } from "@/lib/api/helpers";
import { verifyTotp, hashRecoveryCode } from "@/lib/auth/totp";
// EMAIL-AUDIT (HIGH) — fire a notification email to the user's
// registered inbox the moment 2FA is activated. Defense-in-depth
// against silent 2FA hijack: if an attacker briefly holds the
// session and rotates the TOTP secret, the legitimate user gets
// an email saying "2FA was just turned on — was that you?".
// The email passes the user's tenantId so the right comms config
// is loaded; the send is fire-and-forget so a mail-provider blip
// can't block the activation (the user is already logged in and
// 2FA is already active by the time the email is dispatched).
import { sendEmail, twoFactorActivatedEmail } from "@/lib/email/service";

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

    // EMAIL-AUDIT (HIGH) — fire the 2FA-activated notification email.
    // Best-effort: a transient mail-provider outage must NOT block the
    // activation response (the user is already authenticated and 2FA
    // is already active). The email passes the user's tenantId so the
    // right comms config is loaded; for super_admin users (who have no
    // tenant_id), `getEmailConfig(undefined)` falls back to the
    // platform-level comms blob — same path the signup-request
    // notification uses. Skipped silently when the user has no email
    // on file (some legacy accounts may not).
    if (user.email) {
      try {
        const tenant = auth.tenantId
          ? await auth.store.getTenant(auth.tenantId)
          : null;
        const baseUrl =
          process.env.NEXT_PUBLIC_APP_URL ||
          process.env.NEXT_PUBLIC_BASE_URL ||
          process.env.APP_BASE_URL ||
          "";
        const securityUrl = baseUrl ? `${baseUrl}/settings/security` : "/settings/security";
        const { subject, html } = twoFactorActivatedEmail({
          username: user.username || user.email,
          tenantName: tenant?.name || "VELOS",
          activatedAt: new Date().toISOString(),
          ip: getIp(req),
          userAgent: req.headers.get("user-agent") || null,
          securityUrl,
        });
        void sendEmail({
          to: user.email,
          subject,
          html,
          tenantId: auth.tenantId || undefined,
        }).catch((e) =>
          console.error("[2fa.verify] 2FA activation notification email failed:", e),
        );
      } catch (e) {
        console.error("[2fa.verify] 2FA activation email setup failed:", e);
      }
    }

    return NextResponse.json({ activated: true });
  } catch (e) {
    console.error("[2fa.verify]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
