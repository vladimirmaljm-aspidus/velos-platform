import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getStore } from "@/lib/data/store";
import { verifyPassword, hashPassword } from "@/lib/auth/password";
import { validatePasswordWithPlatformPolicy } from "@/lib/auth/password-policy";
import { getIp } from "@/lib/api/helpers";
// FIX-AUDIT4-SEC / Fix 3 — per-account rate limit. Without this cap, a
// portal client whose session cookie was leaked could brute-force the
// `current_password` field indefinitely (one verifyPassword() call per
// request, no lockout — the lockout in /api/auth/login only fires when
// the password is checked via the LOGIN flow, not here). 5 attempts /
// 15 min matches the password-attempt budget the platform enforces
// elsewhere (login, setup-password, reset-password).
import { checkRateLimit } from "@/lib/security/rate-limiter";
// FIX-AUDIT2-CRIT / C6 — after bumping token_version, the user's existing
// cookie is now stale (the next getPortalSessionAccess() check rejects
// sessions whose token_version does not match the DB). The previous
// implementation bumped the version and returned ok, but did NOT mint a
// fresh cookie carrying the new version — so every portal client who
// changed their password was logged out on the next API call. Mirror the
// setup-password route's post-upsert pattern: create a new session with
// the new token_version and set the cookie so the user stays signed in.
import { createSession, setSessionCookie } from "@/lib/auth/session";
// AUDIT15 / EMAIL-NOTIF — password-change confirmation email (user
// requirement: a client must be notified when their password changes).
// portal_email is encrypted at rest — decrypt before using as To:.
import { sendEmail, passwordChangedEmail } from "@/lib/email/service";
import { decryptField, isEncrypted } from "@/lib/crypto/field-encryption";
import { isValidEmail } from "@/lib/validation/email";

export const runtime = "nodejs";

/**
 * POST /api/portal/change-password
 * Body: { current_password, new_password, confirm_password }
 *
 * Allows a logged-in portal client to change their password.
 * - Verifies the current password
 * - Validates the new password against the password policy
 * - Hashes and updates the new password
 *
 * D-AUDIT-3: now validates against the platform-wide password policy
 * (super-admin Security tab) rather than the hard-coded DEFAULT_POLICY.
 */
export async function POST(req: NextRequest) {
  try {
    // Authenticate the portal user
    const access = await getPortalSessionAccess();
    if (!access) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    // FIX-AUDIT4-SEC / Fix 3 — per-account rate limit (5 attempts / 15 min).
    // Buckets by `access.id` (the portal_access row primary key) so the
    // limit follows the account regardless of which device / IP the
    // attacker is using. A leaked session cookie can't brute-force
    // `current_password` past 5 tries.
    const rl = await checkRateLimit(`portal-pw-change:${access.id}`, 5, 15 * 60 * 1000);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many password change attempts. Please try again later." },
        {
          status: 429,
          headers: rl.retryAfter ? { "Retry-After": String(Math.ceil(rl.retryAfter / 1000)) } : {},
        },
      );
    }

    // Check that the portal access has a password hash (i.e. password-based login)
    if (!access.password_hash) {
      return NextResponse.json(
        { error: "No password set on this account. Please use the setup-password flow." },
        { status: 400 }
      );
    }

    const body = await req.json();
    const { current_password, new_password, confirm_password } = body;

    // Validate required fields
    if (!current_password || !new_password || !confirm_password) {
      return NextResponse.json(
        { error: "Current password, new password, and confirm password are required." },
        { status: 400 }
      );
    }

    // Verify confirm_password matches new_password
    if (new_password !== confirm_password) {
      return NextResponse.json(
        { error: "New password and confirm password do not match." },
        { status: 400 }
      );
    }

    // Verify current password is correct
    const currentValid = await verifyPassword(current_password, access.password_hash);
    if (!currentValid) {
      return NextResponse.json(
        { error: "Current password is incorrect." },
        { status: 400 }
      );
    }

    // Validate new password against policy
    const validation = await validatePasswordWithPlatformPolicy(new_password);
    if (!validation.ok) {
      return NextResponse.json(
        { error: "New password does not meet policy requirements.", details: validation.errors },
        { status: 400 }
      );
    }

    // Check that new password is different from current
    const sameAsOld = await verifyPassword(new_password, access.password_hash);
    if (sameAsOld) {
      return NextResponse.json(
        { error: "New password must be different from your current password." },
        { status: 400 }
      );
    }

    // Hash the new password
    const newPasswordHash = await hashPassword(new_password);

    // Compute the bumped token_version ONCE so the value written to the DB
    // is the SAME value baked into the freshly-minted session cookie below.
    // (If we re-computed in two places, a stale `access.token_version` read
    // after the upsert could mismatch the cookie → another force-logout.)
    const nextTokenVersion = (access.token_version || 0) + 1;

    // Update the portal access record. Bump token_version so any other
    // outstanding sessions for this account (e.g. a stolen cookie) stop
    // working immediately instead of remaining valid for up to 7 more days.
    const store = await getStore();
    await store.upsertPortalAccess({
      id: access.id,
      password_hash: newPasswordHash,
      must_set_password: false,
      token_version: nextTokenVersion,
    });

    // FIX-AUDIT2-CRIT / C6 — mint a fresh session cookie carrying the
    // bumped token_version. The user's existing cookie is now stale
    // (it carries the old token_version, which getPortalSessionAccess
    // will reject on the next call) — without re-minting here, the user
    // is silently logged out the moment they change their password.
    // Mirror the pattern from /api/portal/setup-password/route.ts
    // (lines 196-203). Best-effort: if cookie-minting fails (e.g. JWT
    // secret missing), warn but don't fail the whole request — the
    // password has already been changed, so failing here would leave
    // the user without a working password AND without a session.
    try {
      const token = await createSession({
        sub: `portal:${access.id}`,
        // AUDIT16 — plaintext session username (login_history renders it).
        username: decryptField(access.portal_email || "") || "",
        role: "portal_client",
        token_version: nextTokenVersion,
        tenant_id: access.tenant_id,
      });
      await setSessionCookie(token);
    } catch (e) {
      console.warn("[portal.change-password] auto-relogin failed:", e);
    }

    // Audit log the password change
    // AUDIT16 — audit rows carry the DECRYPTED email (username and details
    // are rendered verbatim in the Audit Log view — ciphertext there was
    // unreadable noise).
    const auditEmail = (() => {
      const d = decryptField(access.portal_email || "");
      return d && !isEncrypted(d) ? d : "";
    })();
    await store.appendAudit({
      tenant_id: access.tenant_id,
      user_id: null,
      username: `portal:${auditEmail || access.id}`,
      action: "portal.password_changed",
      entity_type: "portal_access",
      entity_id: access.id,
      details: { email: auditEmail || "[unreadable]" },
      // Audit F-6/S-1: use getIp() (reads last XFF entry, not the spoofable first).
      ip: getIp(req) || "unknown",
      user_agent: req.headers.get("user-agent") || null,
    });

    // AUDIT15 / EMAIL-NOTIF — security confirmation to the client's own
    // mailbox: "your password was changed; if this wasn't you, act now".
    // Sent through the TENANT'S provider (tenantId = access.tenant_id) so
    // every tenant's clients get their notifications from their own email
    // setup — never another tenant's. Fire-and-forget: the password change
    // has already succeeded; a mail outage must not turn it into a 500.
    try {
      const confirmEmail = decryptField(access.portal_email || "");
      if (confirmEmail && !isEncrypted(confirmEmail) && isValidEmail(confirmEmail)) {
        const tenantForEmail = await store.getTenant(access.tenant_id);
        const { subject, html } = passwordChangedEmail({
          accountName: confirmEmail,
          tenantName: tenantForEmail?.name || "VELOS",
          kind: "change",
          ip: getIp(req),
          userAgent: req.headers.get("user-agent") || null,
          supportUrl: process.env.APP_BASE_URL ? `${process.env.APP_BASE_URL}/portal/login` : undefined,
        });
        void sendEmail({
          to: confirmEmail,
          subject,
          html,
          tenantId: access.tenant_id,
        }).catch((e) => console.warn("[portal.change-password] confirmation email failed:", e));
      }
    } catch (confirmErr) {
      console.warn("[portal.change-password] confirmation email skipped:", confirmErr);
    }

    return NextResponse.json({ ok: true, message: "Password changed successfully." });
  } catch (e: any) {
    console.error("[portal.change-password]", e);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
