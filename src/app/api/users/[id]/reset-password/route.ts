import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError, getIp } from "@/lib/api/helpers";
import { hashPassword } from "@/lib/auth/password";
import { validatePasswordWithPlatformPolicy } from "@/lib/auth/password-policy";
import { rotateUserSessions } from "@/lib/auth/session";
// P0-2 (Monitoring) — fire `password.reset` for the IDS / Sentry / webhook
// pipeline. The anomaly-detector.ts `mass-password-reset` rule escalates
// when 3+ of these accumulate in 5 minutes — the canonical "admin
// takeover cascade" pattern (a compromised admin resetting many user
// passwords in a row to lock users out + log them in with known creds).
import { reportSecurityEvent } from "@/lib/monitoring/security-alerts";

export const runtime = "nodejs";

/**
 * POST /api/users/[id]/reset-password
 *
 * Allows a super_admin (or a same-tenant admin) to set a NEW password on
 * a user's account without knowing the current password. The new password
 * is hashed server-side — the plaintext is NEVER persisted, and the
 * caller's supplied hash (if any) is stripped (audit F-6/P1
 * password_hash backdoor).
 *
 * Side effects (defense in depth):
 *  - The user's `token_version` is bumped so every JWT issued before this
 *    reset is rejected on its next request (see requireAuth's
 *    token_version check).
 *  - All of the user's DB-backed `sessions` rows are revoked via
 *    `rotateUserSessions` so a stolen cookie can't keep working until
 *    its natural 7-day expiry.
 *  - `must_change_password` is set to `false` (the admin already chose
 *    the new password; the user doesn't need to be prompted to change it
 *    at next login — that's the admin's intent).
 *
 * Audit: `user.password_reset` with the target user id + the actor.
 *
 * Body: { password: string }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (users.update) — admins pass implicitly; a non-admin
    // needs an explicit users.update grant. The tenant ownership check
    // below gates the cross-tenant / super-admin-probe cases.
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "users.update"); if (_d) return _d; } /* requirePermission wired */

    const { id } = await params;
    if (id === auth.user.id) {
      // Use /api/auth/change-password for self-service — this admin-only
      // route intentionally skips the current-password proof, so allowing
      // self-service here would let a stolen-session attacker change the
      // victim's password with no further proof.
      return NextResponse.json(
        { error: "Use /api/auth/change-password to change your own password." },
        { status: 400 },
      );
    }

    const existing = await auth.store.getUserById(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });

    // Tenant ownership check. Super_admin can reset any user's password
    // (they're the platform owner); a tenant admin can only reset
    // passwords for users in their own tenant AND never for super_admin
    // accounts (those are platform-level and out of a tenant admin's
    // scope). The 404 shape mirrors the "doesn't exist" branch so the
    // existence of a super_admin account isn't leaked.
    if (!auth.isSuperAdmin) {
      if (existing.role === "super_admin" || existing.tenant_id !== auth.tenantId) {
        return NextResponse.json({ error: "Not found." }, { status: 404 });
      }
    }

    let body: { password?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const password = typeof body?.password === "string" ? body.password : "";
    if (!password) {
      return NextResponse.json({ error: "Password is required." }, { status: 400 });
    }

    // FIX-V1: validate the plaintext password against the platform-wide
    // policy BEFORE hashing. Falls back to DEFAULT_POLICY when
    // security_config is missing or the DB is unreachable (fresh deploy).
    const pwValidation = await validatePasswordWithPlatformPolicy(password);
    if (!pwValidation.ok) {
      return NextResponse.json(
        { error: pwValidation.errors.join(" ") },
        { status: 400 },
      );
    }

    const passwordHash = await hashPassword(password);
    // Bump token_version so every JWT issued before this password change
    // is rejected on its next request (see requireAuth's token_version
    // check). Without this, old cookies on lost / stolen devices stay
    // valid for up to 7 days after a password reset.
    const nextTokenVersion = (existing.token_version || 0) + 1;

    const updated = await auth.store.upsertUser({
      id,
      password_hash: passwordHash,
      must_change_password: false,
      token_version: nextTokenVersion,
      // 8a-8: clear stored 2FA recovery codes on admin-initiated password
      // reset. Without this, an attacker who had exfiltrated recovery codes
      // before the reset could still disable 2FA via /api/auth/2fa/recovery
      // after the user (via admin) rotated their password.
      recovery_codes: null,
    });

    // ── Session rotation ───────────────────────────────────────────────
    // Tear down every DB-backed `sessions` row for this user so a cookie
    // issued before the reset can't keep working until its natural
    // 7-day expiry. The token_version bump above already invalidates the
    // stateless JWT; this catches the stateful session rows too.
    try {
      await rotateUserSessions(updated.id, updated.tenant_id);
    } catch (e) {
      console.error("[users reset-password] rotateUserSessions failed:", e);
      // Non-fatal — the JWT is already invalidated; the DB sessions will
      // expire on their own schedule. Don't 500 the whole reset.
    }

    await audit(auth.store, auth.user, req, "user.password_reset", "user", id, {
      username: updated.username,
    });

    // P0-2 (Monitoring) — fire `password.reset` for the IDS / webhook
    // pipeline. The anomaly-detector.ts `mass-password-reset` rule
    // escalates when 3+ of these accumulate in 5 minutes — the canonical
    // "admin takeover cascade" pattern.
    reportSecurityEvent({
      type: "password.reset",
      userId: id,
      tenantId: updated.tenant_id ?? undefined,
      ip: getIp(req),
      details: { actor_id: auth.user.id, actor_role: auth.user.role },
      severity: "warning",
    });

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("[users reset-password]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
