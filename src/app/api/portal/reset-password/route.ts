import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/data/store";
import { hashPassword } from "@/lib/auth/password";
import { validatePasswordWithPlatformPolicy } from "@/lib/auth/password-policy";
import { consumePasswordReset } from "@/lib/auth/password-reset";
import { getIp } from "@/lib/api/helpers";
// AUDIT15 / EMAIL-ADDR — portal_email is encrypted at rest; decrypt before
// using it as the confirmation email's To: address.
import { decryptField, isEncrypted } from "@/lib/crypto/field-encryption";
// FIX-AUDIT4-SEC / Fix 4 — per-IP rate limit. The reset-token is a single-
// use hashed value, but a malicious actor who harvested a list of valid
// reset tokens (e.g. from intercepted email links) could probe the
// endpoint to discover which tokens are still valid. 10 attempts / 15
// min per IP matches the budget the platform uses elsewhere.
import { checkRateLimit } from "@/lib/security/rate-limiter";
// AUDIT15 / EMAIL-NOTIF — the user requires a notification whenever a
// client's password changes. This is the completion of the forgot-password
// flow: the owner just proved control of the mailbox, so the confirmation
// lands in the same mailbox. Fire-and-forget — never blocks the reset.
import { sendEmail, passwordChangedEmail } from "@/lib/email/service";

export const runtime = "nodejs";

/**
 * POST /api/portal/reset-password
 * Body: { reset_token: "xxx", password: "newpassword123" }
 *
 * Consumes a single-use hashed token from `password_resets`, sets the new password,
 * and bumps token_version to invalidate any existing sessions.
 *
 * D-AUDIT-3: now validates against the platform-wide password policy
 * (super-admin Security tab) rather than the hard-coded DEFAULT_POLICY.
 *
 * FIX-AUDIT4-SEC / Fix 4: per-IP rate limit + reset failed_attempts /
 * locked_until on success (defense-in-depth — clears any residual
 * lockout state from the login flow so the user is not blocked from
 * logging in with the new password).
 */
export async function POST(req: NextRequest) {
  try {
    // ── Per-IP rate limit (10 / 15 min) ──────────────────────────────────
    // Run BEFORE parsing the body so an attacker hammering the endpoint
    // with malformed payloads still counts against the limit. getIp()
    // prefers CF-Connecting-IP / X-Real-IP over the spoofable
    // X-Forwarded-For first entry — see src/lib/api/helpers.ts.
    const ip = getIp(req);
    const rl = await checkRateLimit(`portal-reset:${ip}`, 10, 15 * 60 * 1000);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many password reset attempts. Please try again later." },
        {
          status: 429,
          headers: rl.retryAfter ? { "Retry-After": String(Math.ceil(rl.retryAfter / 1000)) } : {},
        },
      );
    }

    const { reset_token, password } = await req.json();
    if (!reset_token || !password) {
      return NextResponse.json({ error: "Reset token and password are required." }, { status: 400 });
    }
    const validation = await validatePasswordWithPlatformPolicy(password);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.errors.join(" ") }, { status: 400 });
    }

    const result = await consumePasswordReset(reset_token);
    if (!result.ok) {
      const msg =
        result.reason === "expired" ? "This reset link has expired. Please request a new one." :
        result.reason === "already_used" ? "This reset link has already been used. Please request a new one." :
        "Invalid reset token.";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    if (result.targetType !== "portal_access") {
      return NextResponse.json({ error: "Invalid reset token." }, { status: 400 });
    }

    const store = await getStore();
    const passwordHash = await hashPassword(password);
    const current = await store.getPortalAccessById(result.targetId!);
    if (!current) {
      return NextResponse.json({ error: "Account not found." }, { status: 400 });
    }

    await store.upsertPortalAccess({
      id: result.targetId!,
      password_hash: passwordHash,
      must_set_password: false,
      token_version: (current.token_version || 0) + 1,
      // FIX-AUDIT4-SEC / Fix 4 — clear any residual lockout state from the
      // login flow. A user who triggered the lockout counter (e.g. by
      // fat-fingering their password) and then completed a password reset
      // should be able to log in with the new password immediately, not
      // be told "account locked, try again later".
      failed_attempts: 0,
      locked_until: null,
    });

    await store.appendAudit({
      tenant_id: result.tenantId || null,
      user_id: null,
      username: `portal:${current.portal_email || result.targetId}`,
      action: "portal.password_reset_completed",
      entity_type: "portal_access",
      entity_id: result.targetId!,
      details: { email: current.portal_email },
      ip: getIp(req),
      user_agent: req.headers.get("user-agent") || null,
    });

    // AUDIT15 / EMAIL-NOTIF — send the password-change confirmation email.
    // `current.portal_email` is the encrypted at-rest value; decrypt it so
    // the To: address is the real mailbox. The tenant context comes from
    // the reset token itself (result.tenantId) so the email goes out through
    // the TENANT'S OWN provider config (per-tenant isolation). Skipped when
    // the address can't be decrypted or the tenant was deleted — the reset
    // itself has already succeeded and must not be blocked by the email.
    try {
      const confirmEmail = decryptField(current.portal_email || "");
      const tenantForEmail = result.tenantId ? await store.getTenant(result.tenantId) : null;
      if (confirmEmail && !isEncrypted(confirmEmail) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(confirmEmail)) {
        const { subject, html } = passwordChangedEmail({
          accountName: confirmEmail,
          tenantName: tenantForEmail?.name || "VELOS",
          kind: "reset",
          ip: getIp(req),
          userAgent: req.headers.get("user-agent") || null,
          supportUrl: process.env.APP_BASE_URL ? `${process.env.APP_BASE_URL}/portal/login` : undefined,
        });
        void sendEmail({
          to: confirmEmail,
          subject,
          html,
          tenantId: result.tenantId || undefined,
        }).catch((e) => console.warn("[portal.reset-password] confirmation email failed:", e));
      }
    } catch (confirmErr) {
      console.warn("[portal.reset-password] confirmation email skipped:", confirmErr);
    }

    return NextResponse.json({ ok: true, message: "Password reset successfully. You can now log in." });
  } catch (e: any) {
    console.error("[portal.reset-password]", e);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
