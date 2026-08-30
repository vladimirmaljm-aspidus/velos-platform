import { NextRequest, NextResponse } from "next/server";
// 8a-1: switched from `requireSuperAdmin` to `requireSuperAdminOrImpersonating`.
// During an active impersonation `auth.isSuperAdmin === false` (effectiveUser is
// the target), so the strict helper always 403s — the End-Impersonation button
// in the ImpersonateBanner was non-functional and a super_admin could only
// escape via full logout (losing the matching `impersonate.end` audit event).
import { requireSuperAdminOrImpersonating, audit, getIp } from "@/lib/api/helpers";
import { createSession, setSessionCookie, getSessionFromCookie } from "@/lib/auth/session";
// P0-2 (Monitoring) — fire `impersonate.stop` for Sentry / IDS / webhook
// fan-out. Pure reporting call; never blocks the super-admin.
import { reportSecurityEvent } from "@/lib/monitoring/security-alerts";

export const runtime = "nodejs";

/**
 * POST /api/super-admin/impersonate/end
 * Strips the `impersonating` claim from the cookie, restoring the super_admin.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireSuperAdminOrImpersonating(req);
    if (auth instanceof NextResponse) return auth;

    const session = await getSessionFromCookie();
    if (!session) return NextResponse.json({ error: "No session." }, { status: 401 });

    if (!session.impersonating) {
      return NextResponse.json({ ok: true, note: "Not impersonating" });
    }

    const original = session.impersonating;

    // Re-mint the cookie WITHOUT the impersonating claim.
    const token = await createSession({
      sub: session.sub,
      username: session.username,
      role: session.role,
      tenant_id: session.tenant_id,
      token_version: session.token_version,
    });
    await setSessionCookie(token);

    await audit(
      auth.store,
      { id: session.sub, username: session.username, tenant_id: null },
      req,
      "super_admin.impersonate.end",
      "user",
      original.target_user_id,
      {
        target_user_id: original.target_user_id,
        target_tenant_id: original.target_tenant_id,
        original_expires_at: original.expires_at,
      },
    );

    // P0-2 (Monitoring) — fire `impersonate.stop` AFTER the audit log.
    // severity=info: the impersonation ending is the safe/expected
    // transition (super-admin returns to their own identity). Reported
    // for completeness so the audit trail in Sentry + the webhook fan-out
    // has matching start/stop events for every impersonation session.
    reportSecurityEvent({
      type: "impersonate.stop",
      userId: session.sub,
      tenantId: original.target_tenant_id ?? undefined,
      ip: getIp(req),
      details: {
        target_user_id: original.target_user_id,
        target_tenant_id: original.target_tenant_id,
        original_expires_at: original.expires_at,
      },
      severity: "info",
    });

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
