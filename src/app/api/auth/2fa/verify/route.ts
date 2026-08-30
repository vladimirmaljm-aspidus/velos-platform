import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, getIp, sanitizeError } from "@/lib/api/helpers";
import { verifyTotp, generateRecoveryCodes, hashRecoveryCode } from "@/lib/auth/totp";
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
 * On success, `totp_enabled` becomes true and login will require a TOTP
 * token (or recovery code) from this point forward.
 *
 * 8a-4: this route previously accepted a client-supplied `recoveryCodes`
 * array and persisted their hashes here. That design had a TOCTOU hole:
 * an attacker who briefly held the session between /enroll (which
 * returned 10 plaintext codes) and /verify (which persisted hashes) could
 * supply their OWN recovery codes via /verify, leaving the legitimate
 * user's 2FA active but with attacker-known recovery codes. The /enroll
 * route now persists the hashed recovery codes itself; /verify accepts
 * ONLY a TOTP token.
 *
 * The one residual case: a user who logs in via a recovery code. That
 * flow clears `recovery_codes` (single-use) AND sets `totp_enabled=false`
 * while keeping `totp_secret`. To re-activate, the user must call /verify
 * — but they have no recovery codes left. We detect that case
 * (`isReEnrollAfterRecovery`) and generate FRESH recovery codes here,
 * returning them in the response (one-time view, exactly like /enroll).
 *
 * Body: { token: string }
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
    if (!token) {
      return NextResponse.json({ error: "Token is required." }, { status: 400 });
    }
    // 8a-4: recovery codes are NO LONGER client-supplied. They were
    // hashed + persisted at /enroll. We only accept a TOTP token here.
    // (If the caller did send a `recoveryCodes` array in the body, we
    // ignore it — no error, because the legitimate frontend may still
    // be sending the field from an old build. But we do NOT trust it
    // or persist it.)
    // After a recovery-code login, totp_secret is kept but recovery_codes
    // are cleared + totp_enabled=false. In that state, the user re-verifies
    // with just a TOTP token; we generate fresh recovery codes for them
    // and return the plaintext (one-time view) in the response.
    const isReEnrollAfterRecovery =
      !!user.totp_secret && !user.totp_enabled && (!user.recovery_codes || user.recovery_codes.length === 0);

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

    // 8a-4: if the user is re-activating after a recovery-code login
    // (recovery_codes are null), generate FRESH recovery codes and
    // return them (one-time plaintext view) — the user has lost the
    // originals and needs new ones. Otherwise, recovery_codes were
    // already persisted at /enroll and we leave them alone.
    let newRecoveryCodes: string[] | null = null;
    let recoveryHashes: string[] | null = null;
    if (isReEnrollAfterRecovery) {
      newRecoveryCodes = generateRecoveryCodes();
      recoveryHashes = newRecoveryCodes.map((c) => hashRecoveryCode(c));
    }

    await auth.store.upsertUser({
      id: user.id,
      totp_secret: user.totp_secret,
      totp_enabled: true,
      ...(recoveryHashes ? { recovery_codes: recoveryHashes } : {}),
    });

    await audit(
      auth.store,
      auth.user,
      req,
      "auth.2fa.activate",
      "auth",
      user.id,
      {
        recovery_code_count: recoveryHashes ? recoveryHashes.length : (user.recovery_codes?.length ?? 0),
        fresh_recovery_codes_generated: isReEnrollAfterRecovery,
      },
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

    return NextResponse.json({
      activated: true,
      // 8a-4: only returned for the re-enroll-after-recovery case.
      // For a normal activation, recovery_codes were already shown at
      // /enroll (one-time plaintext view) — we do NOT re-show them.
      ...(newRecoveryCodes ? { recoveryCodes: newRecoveryCodes } : {}),
    });
  } catch (e) {
    console.error("[2fa.verify]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
