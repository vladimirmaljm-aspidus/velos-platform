import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { validatePasswordWithPlatformPolicy } from "@/lib/auth/password-policy";
import {
  createSession,
  setSessionCookie,
  rotateUserSessions,
} from "@/lib/auth/session";
import { reportSecurityEvent } from "@/lib/monitoring/security-alerts";
// AUDIT15 / EMAIL-NOTIF — password-change confirmation email for staff /
// admin accounts (mirrors the portal-side notification). users.email is
// stored plaintext (set at registration), so no decryption is needed —
// only a basic address sanity check.
import { sendEmail, passwordChangedEmail } from "@/lib/email/service";
import { isValidEmail } from "@/lib/validation/email";

export const runtime = "nodejs";

/**
 * POST /api/auth/change-password
 * Body: `{ current_password, new_password, confirm_password }`
 *
 * FEAT-1 (Password change in Settings): lets the signed-in user rotate
 * their own password. Mirrors the existing portal change-password route
 * (`/api/portal/change-password`) but for the CRM/staff auth surface:
 *
 *  1. `requireAuth` — any authenticated user (admin OR regular user OR
 *     super_admin) may change their own password. (The codebase has no
 *     `requireUser` helper — `requireAuth` IS the user gate; super_admin
 *     and admin gates are layered on top of it via `requireAdmin` /
 *     `requireSuperAdmin`. We intentionally don't call those here: this
 *     route must be open to every logged-in user, not just admins.)
 *
 *  2. Verify `current_password` against the user's stored hash via
 *     `verifyPassword` (which transparently handles both bcrypt + the
 *     legacy `mock$` prefix used in dev). Wrong current → 400 "Current
 *     password is incorrect."
 *
 *  3. Validate `new_password` against the platform-wide policy loaded
 *     from `settings.security_config.passwordPolicy` by
 *     `validatePasswordWithPlatformPolicy` (5-min in-process cache, same
 *     loader as register / portal change-password). Weak → 400 "New
 *     password does not meet requirements."
 *
 *  4. Hash + persist via `upsertUser`. Bump `users.token_version` so
 *     every OTHER outstanding JWT for this user (lost devices, stolen
 *     cookies, other tabs) immediately fails the `token_version` check
 *     in `requireAuth` on its very next request. The CURRENT session is
 *     re-minted with the new `token_version` and a fresh cookie so the
 *     user making the request is NOT forced to log in again — only
 *     OTHER sessions are invalidated (matches the task requirement:
 *     "Invalidate all other sessions").
 *
 *  5. `rotateUserSessions` revokes the DB-side session rows
 *     (best-effort; failures are caught inside the helper). This is the
 *     observable half — the admin "Sessions" panel reflects reality.
 *     JWT-side invalidation (step 4) is the security half — even if the
 *     DB-side revoke race-loses, the bumped token_version catches the
 *     other JWTs at the next request.
 *
 *  6. `reportSecurityEvent("password.changed")` so the IDS / Sentry /
 *     webhook pipeline sees self-service password rotations (a sudden
 *     spike on one account is the canonical account-takeover-recovery
 *     signal — the owner just noticed something wrong).
 *
 *  7. `audit` writes `auth.password_changed` to the append-only audit
 *     log with the actor's IP + UA so the trail survives across
 *     server restarts.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;

    // ── Parse + validate body ─────────────────────────────────────────
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid request body." },
        { status: 400 },
      );
    }

    const currentPassword = String(body.current_password ?? "");
    const newPassword = String(body.new_password ?? "");
    const confirmPassword = String(body.confirm_password ?? "");

    if (!currentPassword || !newPassword) {
      return NextResponse.json(
        { error: "Current password and new password are required." },
        { status: 400 },
      );
    }

    // Confirm-match check is the UX half; the API also independently
    // validates the new password against the platform policy below, so
    // a client that skips this check can't push a weak password through.
    if (newPassword !== confirmPassword) {
      return NextResponse.json(
        { error: "New password and confirm password do not match." },
        { status: 400 },
      );
    }

    // ── Fetch full user row (with password_hash) ──────────────────────
    // `auth.user` is the SafeUser projection (no password_hash). The
    // full row is needed for the bcrypt comparison + the token_version
    // bump below. `getUserById` is the only by-id lookup in the store
    // interface — same one `requireAuth` itself uses.
    const user = await auth.store.getUserById(auth.user.id);
    if (!user || !user.active) {
      return NextResponse.json(
        { error: "Account not found." },
        { status: 404 },
      );
    }
    if (!user.password_hash) {
      return NextResponse.json(
        { error: "No password is set on this account." },
        { status: 400 },
      );
    }

    // ── Verify current password ───────────────────────────────────────
    const currentValid = await verifyPassword(currentPassword, user.password_hash);
    if (!currentValid) {
      // Audit the failed attempt so the security pipeline sees a
      // possible account-takeover probe (attacker has session cookie,
      // tries to rotate password, fails). Best-effort.
      try {
        await auth.store.appendAudit({
          user_id: user.id,
          username: user.username,
          tenant_id: user.tenant_id,
          action: "auth.password_change_failed",
          entity_type: "auth",
          entity_id: user.id,
          details: { reason: "wrong_current_password" },
          ip: auth.ip,
          user_agent: req.headers.get("user-agent") || null,
        });
      } catch (e) {
        console.error("[change-password] appendAudit (wrong pw) failed:", e);
      }
      reportSecurityEvent({
        type: "login.failed",
        userId: user.id,
        tenantId: user.tenant_id ?? undefined,
        ip: auth.ip,
        details: { reason: "wrong_current_password", scope: "change_password" },
        severity: "warning",
      });
      return NextResponse.json(
        { error: "Current password is incorrect." },
        { status: 400 },
      );
    }

    // ── Validate new password against platform policy ─────────────────
    const validation = await validatePasswordWithPlatformPolicy(newPassword);
    if (!validation.ok) {
      return NextResponse.json(
        {
          error: "New password does not meet requirements.",
          details: validation.errors,
        },
        { status: 400 },
      );
    }

    // 8a-7: defence-in-depth — refuse to rotate the password to the SAME
    // value as the current password. The portal equivalent
    // `/api/portal/change-password` already has this check; without it, a
    // user who suspects compromise and "rotates" their password to the
    // same value leaves the previously-stolen credential still valid.
    const sameAsOld = await verifyPassword(newPassword, user.password_hash);
    if (sameAsOld) {
      return NextResponse.json(
        { error: "New password must be different from your current password." },
        { status: 400 },
      );
    }

    // ── Hash + bump token_version ──────────────────────────────────────
    const newPasswordHash = await hashPassword(newPassword);
    const nextTokenVersion = (user.token_version || 1) + 1;

    await auth.store.upsertUser({
      id: user.id,
      password_hash: newPasswordHash,
      must_change_password: false,
      token_version: nextTokenVersion,
      failed_attempts: 0,
      locked_until: null,
      // 8a-8: clear stored 2FA recovery codes on password change. The
      // admin-initiated `/api/users/[id]/disable-2fa` route already does
      // this; the user-initiated password-change route did NOT, so an
      // attacker who had exfiltrated recovery codes earlier could still
      // disable 2FA via `/api/auth/2fa/recovery` AFTER the user rotated
      // their password. Mirror portal-change-password which also clears.
      recovery_codes: null,
    });

    // ── Re-mint the current session with the new token_version ────────
    // This keeps the caller logged in while invalidating every OTHER
    // outstanding JWT for this user (their token_version is still the
    // old value, so `requireAuth`'s `baseUser.token_version !==
    // session.token_version` check rejects them on next request).
    // Super_admin sessions are also re-minted here — they were already
    // carrying the old token_version in their JWT, and we want the
    // current super_admin browser to stay authenticated too.
    const newToken = await createSession({
      sub: user.id,
      username: user.username,
      role: user.role,
      token_version: nextTokenVersion,
      tenant_id: user.tenant_id,
    });
    await setSessionCookie(newToken);

    // ── Revoke DB-side sessions (best-effort) ──────────────────────────
    // The JWT-side invalidation (token_version bump) is the security
    // half; this is the observable half so the admin "Sessions" panel
    // reflects reality. Best-effort: failures inside the helper are
    // logged but never thrown — a password change must succeed even if
    // the sessions table is briefly unreachable. Skipped for
    // platform-level (super_admin without tenant_id) accounts per the
    // helper's own guard.
    void rotateUserSessions(user.id, user.tenant_id).catch((e) =>
      console.error("[change-password] rotateUserSessions failed:", e),
    );

    // ── Audit + security event ─────────────────────────────────────────
    try {
      await audit(
        auth.store,
        auth.user,
        req,
        "auth.password_changed",
        "user",
        user.id,
        { method: "self_change" },
      );
    } catch (e) {
      console.error("[change-password] audit failed:", e);
    }
    // Self-service password change is security-relevant (a spike on one
    // account is the canonical account-takeover-recovery signal). The
    // SecurityEvent enum doesn't have a "password.changed" subtype, so
    // we surface it as `suspicious.activity` severity=info — the
    // anomaly-detector's existing "burst on one account" rule keys
    // off the same event type, and `info` severity means no pager
    // escalation. (The audit log entry above is the durable record.)
    reportSecurityEvent({
      type: "suspicious.activity",
      userId: user.id,
      tenantId: user.tenant_id ?? undefined,
      ip: auth.ip,
      details: { reason: "password_changed", method: "self_change" },
      severity: "info",
    });

    // AUDIT15 / EMAIL-NOTIF — confirmation email to the user's own mailbox
    // ("your password was changed; if this wasn't you, act now"). Routed
    // through the TENANT'S provider config when the user belongs to a
    // tenant (per-tenant isolation); super-admins (no tenant) fall back to
    // the platform-level comms config. Fire-and-forget — the change has
    // already succeeded and must not fail because of a mail outage.
    try {
      const userEmail = (user as any).email;
      if (userEmail && isValidEmail(userEmail)) {
        const tenantForEmail = user.tenant_id ? await auth.store.getTenant(user.tenant_id) : null;
        const { subject, html } = passwordChangedEmail({
          accountName: user.username || userEmail,
          tenantName: tenantForEmail?.name || "VELOS",
          kind: "change",
          ip: auth.ip,
          userAgent: req.headers.get("user-agent") || null,
          supportUrl: process.env.APP_BASE_URL ? `${process.env.APP_BASE_URL}/login` : undefined,
        });
        void sendEmail({
          to: userEmail,
          subject,
          html,
          tenantId: user.tenant_id || undefined,
        }).catch((e) => console.warn("[auth.change-password] confirmation email failed:", e));
      }
    } catch (confirmErr) {
      console.warn("[auth.change-password] confirmation email skipped:", confirmErr);
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[change-password]", e);
    return NextResponse.json(
      { error: "Server error." },
      { status: 500 },
    );
  }
}
