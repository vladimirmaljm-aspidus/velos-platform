import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError, getIp } from "@/lib/api/helpers";
// P0-2 (Monitoring) — fire `2fa.disabled` for the IDS / Sentry / webhook
// pipeline. The anomaly-detector.ts `mass-2fa-disable` rule escalates when
// 3+ of these accumulate in 5 minutes — the canonical "account takeover
// cascade" pattern (a compromised admin disabling 2FA across many user
// accounts in a row).
import { reportSecurityEvent } from "@/lib/monitoring/security-alerts";

export const runtime = "nodejs";

/**
 * POST /api/users/[id]/disable-2fa
 *
 * Allows a super_admin (or a same-tenant admin) to disable 2FA on a
 * user's account WITHOUT the current-password / TOTP proof that the
 * self-service `/api/auth/2fa/disable` route requires. The admin is
 * already authenticated and authorised; this route is the
 * platform-managed escape hatch for the "user lost their second factor
 * and is locked out" support case.
 *
 * Side effects:
 *  - Clears `totp_secret`, `totp_enabled`, and `recovery_codes`.
 *  - Bumps `token_version` so the existing session is force-refreshed —
 *    defense in depth; the user's existing session cookie stays valid
 *    (the admin reset their 2FA, not their password) but any 2FA-locked
 *    session state is no longer authoritative.
 *
 * Audit: `user.2fa_disabled` with the target user id + actor.
 *
 * No body required.
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
      // Use /api/auth/2fa/disable for self-service — that route requires
      // a current-password / TOTP proof, which is the correct defense
      // against a stolen-session attacker silently disabling 2FA on
      // their own account.
      return NextResponse.json(
        { error: "Use /api/auth/2fa/disable to disable your own 2FA." },
        { status: 400 },
      );
    }

    const existing = await auth.store.getUserById(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });

    // Tenant ownership check. Super_admin can disable 2FA on any user
    // (they're the platform owner); a tenant admin can only disable 2FA
    // for users in their own tenant AND never on super_admin accounts
    // (those are platform-level and out of a tenant admin's scope). The
    // 404 shape mirrors the "doesn't exist" branch so the existence of a
    // super_admin account isn't leaked.
    if (!auth.isSuperAdmin) {
      if (existing.role === "super_admin" || existing.tenant_id !== auth.tenantId) {
        return NextResponse.json({ error: "Not found." }, { status: 404 });
      }
    }

    if (!existing.totp_enabled) {
      return NextResponse.json(
        { error: "Two-factor authentication is not active on this account." },
        { status: 400 },
      );
    }

    await auth.store.upsertUser({
      id,
      totp_secret: null,
      totp_enabled: false,
      recovery_codes: null,
    });

    // Best-effort token_version bump — the existing session is still
    // valid (the admin disabled 2FA, not the user's password), but
    // bumping forces the user's next request to re-resolve their auth
    // context so any cached 2FA-required decision is invalidated.
    try {
      await auth.store.bumpUserTokenVersion(id);
    } catch (e) {
      console.error("[users disable-2fa] bumpUserTokenVersion failed:", e);
    }

    await audit(auth.store, auth.user, req, "user.2fa_disabled", "user", id, {
      username: existing.username,
    });

    // P0-2 (Monitoring) — fire `2fa.disabled` AFTER the disable succeeds.
    // severity=warning — the anomaly-detector.ts `mass-2fa-disable` rule
    // escalates to a critical `suspicious.activity` event when 3+
    // accumulate in 5 minutes (the account-takeover-cascade pattern).
    reportSecurityEvent({
      type: "2fa.disabled",
      userId: id,
      tenantId: existing.tenant_id ?? undefined,
      ip: getIp(req),
      details: { actor_id: auth.user.id, actor_role: auth.user.role, admin_initiated: true },
      severity: "warning",
    });

    return NextResponse.json({ ok: true, disabled: true });
  } catch (error: any) {
    console.error("[users disable-2fa]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
