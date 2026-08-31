import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/data/store";
import { getSessionFromCookie, createSession, setSessionCookie } from "@/lib/auth/session";
import { hashPassword } from "@/lib/auth/password";
import { validatePasswordWithPlatformPolicy } from "@/lib/auth/password-policy";
import { consumePasswordReset } from "@/lib/auth/password-reset";
import { getIp } from "@/lib/api/helpers";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { getRateLimitConfig } from "@/lib/security/rate-limit-config";
// AUDIT15 / EMAIL-NOTIF — account-activation confirmation email (user
// requirement: the client must receive a notification after completing
// the invite flow). portal_email is encrypted at rest — decrypt for To:.
import { sendEmail, passwordChangedEmail } from "@/lib/email/service";
import { decryptField, isEncrypted } from "@/lib/crypto/field-encryption";

export const runtime = "nodejs";

// F-7 (Rate Limiting): password-setup attempts per IP are now configurable
// by super-admins via the Settings UI. Defaults: 10 / 15 min.
// Caps brute-force on the invite-link ?access_id=… parameter (an attacker
// who somehow obtains an access_id could otherwise hammer this endpoint
// to find a password the policy accepts and hijack the account before the
// legit user finishes setup). 10 attempts is generous — a real user setting
// their first password rarely fails validation more than 2-3 times.

// Portal password setup — used three ways (audit F-6/P1-3):
//  1. Anonymous invite redemption: the customer follows the emailed invite
//     link (`?setup_token=xxx`), which is a single-use, 7-day-expiring
//     token from `password_resets` (target_type="portal_access"). The
//     token is consumed atomically; a leaked/forwarded email stops
//     working the first time it's used OR after 7 days, whichever comes
//     first. Previously the email embedded the bare `access_id` UUID,
//     which is a permanent identifier that never expires — anyone who
//     obtained it (forwarded email, breach) could set a password at any
//     future time as long as `must_set_password` was still true.
//  2. Staff-initiated: an authenticated admin of the same tenant (or a
//     super-admin) sets/resets a portal account's password from the CRM.
//     Identified by `access_id` in the body + a valid staff session.
//  3. Backward-compat: outstanding invite emails issued BEFORE this fix
//     shipped still arrive with `?access_id=xxx` (no setup_token). We
//     honour them ONLY if `must_set_password` is still true AND
//     `invited_at` is within the last 7 days — matching the new token
//     TTL. After 7 days the link is dead and the admin must re-invite.
//
// Audit finding P1-7: this route previously used a permissive policy
// (minLength: 8, no character-class requirements) that accepted "abcdefgh".
// The reset-password and change-password routes enforced the strong
// DEFAULT_POLICY — so a client could set a weak password at first login
// that they could then never re-use via change-password. We then used
// the same PORTAL_POLICY (8+ chars + uppercase + lowercase + number, no
// symbol requirement for mobile UX) as the other portal password routes.
//
// FIX-V1: this route now calls `validatePasswordWithPlatformPolicy()` so
// the super-admin's configured minLength / char-class toggles apply to
// the FIRST password a portal client sets (matching reset-password +
// change-password, which already use it). Falls back to DEFAULT_POLICY
// (same shape as PORTAL_POLICY) on a fresh deploy or DB hiccup.
export async function POST(req: NextRequest) {
  try {
    const { access_id, setup_token, password } = await req.json();
    if ((!access_id && !setup_token) || !password) {
      return NextResponse.json({ error: "Setup token (or access ID) and password are required." }, { status: 400 });
    }

    // ── F-7: DB-backed per-IP rate limit ──────────────────────────────────
    // Checked BEFORE the token/access_id resolution so an attacker hammering
    // random tokens doesn't get to probe the password_resets table. The 429
    // leaks nothing about whether the token exists — it's an IP-level block.
    const ip = getIp(req);
    const config = await getRateLimitConfig();
    const rl = await checkRateLimit(
      `portal-setup-password:ip:${ip}`,
      config.setupPasswordMaxAttempts,
      config.setupPasswordWindowMs,
    );
    if (!rl.allowed) {
      const retryAfterSec = Math.ceil((rl.retryAfter ?? 60_000) / 1000);
      return NextResponse.json(
        { error: "Too many password-setup attempts from this address. Try again later." },
        { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
      );
    }

    // FIX-V1: switch from the hardcoded PORTAL_POLICY constant to the
    // platform-wide policy loader. This routes the FIRST password a
    // portal client sets through the super-admin's configured minLength /
    // char-class toggles — closing the audit gap where setup-password
    // accepted "abcdefgh" while reset-password + change-password
    // enforced the strong policy (uppercase + lowercase + number).
    //
    // Falls back to DEFAULT_POLICY (8+ upper/lower/number, no symbols —
    // same shape as the old PORTAL_POLICY) when the security_config row
    // is missing or the DB is unreachable, so a fresh deploy keeps the
    // same defaults the old code enforced.
    const validation = await validatePasswordWithPlatformPolicy(password);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.errors.join(" ") }, { status: 400 });
    }

    const store = await getStore();

    // ── Resolve the portal_access row + (for anonymous path) consume the
    //    single-use setup token. The token is consumed BEFORE we hash the
    //    password / write the new row, so a concurrent request racing on
    //    the same token will be rejected by `consumePasswordReset`'s
    //    atomic `WHERE used_at IS NULL` update.
    let resolvedAccessId: string | undefined = access_id;
    let tokenConsumed = false;
    if (setup_token) {
      // Primary anonymous path — token-based invite redemption.
      const result = await consumePasswordReset(setup_token);
      if (!result.ok || result.targetType !== "portal_access" || !result.targetId) {
        const reason = result.reason === "expired"
          ? "This invitation link has expired. Please ask your account manager to send a new invitation."
          : result.reason === "already_used"
          ? "This invitation link has already been used. Please sign in, or click 'Forgot password' if you need to reset it."
          : "Invalid or expired setup link. Ask your account manager to re-send the invitation.";
        return NextResponse.json({ error: reason }, { status: 401 });
      }
      resolvedAccessId = result.targetId;
      tokenConsumed = true;
    }

    if (!resolvedAccessId) {
      return NextResponse.json({ error: "Setup token (or access ID) is required." }, { status: 400 });
    }
    const accessIdFinal: string = resolvedAccessId;

    const access = await store.getPortalAccessById(accessIdFinal);
    if (!access) {
      return NextResponse.json({ error: "Invalid or expired setup link. Ask your account manager to re-send the invitation." }, { status: 404 });
    }

    // Is this call coming from a staff (admin/super_admin) session?
    let staffAuthorized = false;
    const session = await getSessionFromCookie();
    if (session && session.role !== "portal_client") {
      const staffUser = await store.getUserById(session.sub);
      if (
        staffUser &&
        staffUser.active &&
        staffUser.token_version === session.token_version &&
        (staffUser.role === "super_admin" || staffUser.tenant_id === access.tenant_id)
      ) {
        staffAuthorized = true;
      }
    }

    // Anonymous path is only allowed while must_set_password is still true.
    // If the user bookmarks the invite link and comes back after already
    // setting a password, point them to the right flow instead of failing
    // silently.
    if (!staffAuthorized && !access.must_set_password) {
      return NextResponse.json(
        {
          error: "This account already has a password. Use sign-in, or click 'Forgot password' if you need to reset it.",
          already_has_password: true,
        },
        { status: 403 }
      );
    }

    // ── Backward-compat anonymous access_id path (audit F-6/P1-3) ──────
    // Pre-fix invite emails arrive with `?access_id=xxx` and no
    // `setup_token`. We honour them ONLY if `invited_at` is within the
    // last 7 days (matching the new token TTL). After that, the bare
    // access_id is rejected — the admin must re-invite, which will mint
    // a proper setup_token.
    if (!staffAuthorized && !tokenConsumed && access.invited_at) {
      const invitedAt = new Date(access.invited_at).getTime();
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      if (Number.isNaN(invitedAt) || (Date.now() - invitedAt) > sevenDaysMs) {
        return NextResponse.json(
          { error: "This invitation link has expired. Please ask your account manager to send a new invitation." },
          { status: 401 }
        );
      }
    }

    if (access.status === "revoked" || access.status === "suspended") {
      return NextResponse.json({ error: "This portal account is not currently active. Contact your account manager." }, { status: 403 });
    }

    const passwordHash = await hashPassword(password);
    const updated = await store.upsertPortalAccess({
      id: accessIdFinal,
      password_hash: passwordHash,
      must_set_password: false,
      status: "active",
      failed_attempts: 0,
      locked_until: null,
      token_version: (access.token_version || 0) + 1,
    } as any);

    // Anonymous first-time setup → mint a portal session immediately. Making
    // the user re-type their brand-new password on the login screen after
    // this endpoint returns is what produced the "nothing happens" reports:
    // the setup succeeded but the browser just sat on an empty login form.
    if (!staffAuthorized) {
      try {
        const token = await createSession({
          sub: `portal:${updated.id}`,
          username: updated.portal_email || "",
          role: "portal_client",
          token_version: updated.token_version || 0,
          tenant_id: updated.tenant_id,
        });
        await setSessionCookie(token);
      } catch (e) {
        console.warn("[setup-password] auto-login failed, user will need to sign in manually:", e);
      }
    }

    const { password_hash: _, ...safe } = updated as any;

    // AUDIT15 / EMAIL-NOTIF — the invite flow's final step now notifies the
    // client that their account is active (this is the email the user asked
    // for: "pozivni mejl da se uloguje" + confirmation that setup succeeded).
    // `updated.portal_email` is the encrypted at-rest value — decrypt before
    // send. Sent through the tenant's own provider (per-tenant isolation).
    // Fire-and-forget: the setup + auto-login have already succeeded.
    try {
      const confirmEmail = decryptField((updated as any).portal_email || "");
      if (confirmEmail && !isEncrypted(confirmEmail) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(confirmEmail)) {
        const tenantForEmail = await store.getTenant(updated.tenant_id);
        const { subject, html } = passwordChangedEmail({
          accountName: confirmEmail,
          tenantName: tenantForEmail?.name || "VELOS",
          kind: "setup",
          ip: getIp(req),
          userAgent: req.headers.get("user-agent") || null,
          supportUrl: process.env.APP_BASE_URL ? `${process.env.APP_BASE_URL}/portal/login` : undefined,
        });
        void sendEmail({
          to: confirmEmail,
          subject,
          html,
          tenantId: updated.tenant_id,
        }).catch((e) => console.warn("[portal.setup-password] confirmation email failed:", e));
      }
    } catch (confirmErr) {
      console.warn("[portal.setup-password] confirmation email skipped:", confirmErr);
    }

    return NextResponse.json({ ok: true, access: safe, auto_signed_in: !staffAuthorized });
  } catch (e) {
    console.error("[portal.setup]", e);
    return NextResponse.json({ error: "Server error while setting up your password. Please try again in a minute or ask your account manager to re-send the invitation." }, { status: 500 });
  }
}
