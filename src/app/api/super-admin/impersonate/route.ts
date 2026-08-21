import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, audit, getIp } from "@/lib/api/helpers";
import { createSession, setSessionCookie, getSessionFromCookie } from "@/lib/auth/session";
// P0-2 (Monitoring) — fire `impersonate.start` for Sentry / IDS / webhook
// fan-out. SUPER-ADMIN IS NEVER BLOCKED: this is a pure reporting call
// AFTER the route has already authorised and executed the impersonation;
// the report does not gate anything. Super-admin can always impersonate.
import { reportSecurityEvent } from "@/lib/monitoring/security-alerts";

export const runtime = "nodejs";

const DEFAULT_DURATION_MIN = 60;
const MAX_DURATION_MIN = 8 * 60;

/**
 * POST /api/super-admin/impersonate
 * Body: { tenant_id: string, user_id: string, duration_minutes?: number }
 * Mints a new session cookie that carries an `impersonating` claim.
 * The super_admin's own identity is preserved in the JWT `sub` (baseUser) —
 * requireAuth() then swaps the effective user to `target_user_id`.
 */
export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  // Only genuine, non-impersonated super_admins can start impersonation.
  if (auth.impersonation) {
    return NextResponse.json(
      { error: "Already impersonating. End the current session first." },
      { status: 409 },
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const targetUserId: string | undefined = body?.user_id;
  const tenantId: string | undefined = body?.tenant_id;
  const durationMin = Math.min(
    Math.max(Number(body?.duration_minutes) || DEFAULT_DURATION_MIN, 1),
    MAX_DURATION_MIN,
  );

  if (!targetUserId) return NextResponse.json({ error: "user_id required" }, { status: 400 });

  const target = await auth.store.getUserById(targetUserId);
  if (!target || !target.active) {
    return NextResponse.json({ error: "Target user not found or inactive" }, { status: 404 });
  }
  if (target.role === "super_admin") {
    return NextResponse.json({ error: "Cannot impersonate another super_admin" }, { status: 403 });
  }
  if (tenantId && target.tenant_id !== tenantId) {
    return NextResponse.json({ error: "User does not belong to specified tenant" }, { status: 400 });
  }

  const expiresAt = new Date(Date.now() + durationMin * 60 * 1000).toISOString();

  // Fetch the ORIGINAL session for the super_admin's real token_version.
  const session = await getSessionFromCookie();
  if (!session) return NextResponse.json({ error: "No session." }, { status: 401 });

  const token = await createSession({
    sub: session.sub,                // original super_admin ID
    username: session.username,
    role: session.role,
    tenant_id: session.tenant_id,
    token_version: session.token_version,
    impersonating: {
      original_super_admin_id: session.sub,
      original_username: session.username,
      target_user_id: target.id,
      target_tenant_id: target.tenant_id,
      expires_at: expiresAt,
      // P1 ghost-JWT hardening (task C-5 Fix 6): snapshot the target's
      // token_version at impersonation start. requireAuth() compares this
      // snapshot to the target's current token_version on every request,
      // so if the target's password is reset mid-impersonation (bumping
      // their token_version), the impersonation is immediately revoked.
      // Without this, the super_admin's own JWT would keep working for
      // up to MAX_DURATION_MIN minutes after the target was supposed to
      // be logged out.
      target_token_version: target.token_version ?? 0,
    },
  });
  await setSessionCookie(token);

  await audit(
    auth.store,
    { id: session.sub, username: session.username, tenant_id: null },
    req,
    "super_admin.impersonate.start",
    "user",
    target.id,
    {
      target_username: target.username,
      target_tenant_id: target.tenant_id,
      duration_minutes: durationMin,
      expires_at: expiresAt,
      ip: getIp(req),
    },
  );

  // P0-2 (Monitoring) — fire `impersonate.start` AFTER the audit log is
  // written. severity=warning: impersonation is a legitimate super-admin
  // operation, but it's security-relevant (a super-admin becomes a
  // regular user) and should always appear in the security audit trail
  // + Sentry + the webhook fan-out. NOTE: this report is post-success —
  // super-admin is never blocked here. The `details` mirror the audit
  // payload so a Sentry alert or webhook receiver has full context.
  reportSecurityEvent({
    type: "impersonate.start",
    userId: session.sub,
    tenantId: target.tenant_id ?? undefined,
    ip: getIp(req),
    details: {
      target_user_id: target.id,
      target_username: target.username,
      target_tenant_id: target.tenant_id,
      duration_minutes: durationMin,
      expires_at: expiresAt,
    },
    severity: "warning",
  });

  return NextResponse.json({
    ok: true,
    impersonating: {
      target_user_id: target.id,
      target_username: target.username,
      target_tenant_id: target.tenant_id,
      expires_at: expiresAt,
    },
  });
}
