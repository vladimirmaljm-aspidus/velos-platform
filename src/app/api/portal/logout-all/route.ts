import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/data/store";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { clearSessionCookie } from "@/lib/auth/session";
import { getIp } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * POST /api/portal/logout-all
 *
 * Portal-client counterpart to /api/auth/logout-all — bumps the
 * `portal_access.token_version` for the currently-logged-in portal client so
 * every existing portal JWT for them immediately fails the token_version
 * check in `getPortalSessionAccess()`, then clears the caller's own session
 * cookie.
 *
 * The portal_access table doesn't have an equivalent of the `sessions` table
 * (portal sessions are stateless JWTs only — no `sessions` rows are written
 * for portal_client role), so there is no DB-side revocation list to clean
 * up here. The token_version bump IS the entire invalidation mechanism.
 *
 * Token-version bump is the same read-modify-write pattern already used by
 * `revokeSession()` for portal sessions and `reset-password/route.ts`. It is
 * not atomic across concurrent calls, but the consequence of a lost increment
 * here is just that one extra old session survives a single bump — a
 * follow-up logout-all or password reset would clean it up. Acceptable for
 * this low-frequency self-service action.
 *
 * Audit action `portal.logout_all` distinguishes this from a normal
 * `portal.logout`.
 */
export async function POST(req: NextRequest) {
  try {
    const access = await getPortalSessionAccess();
    if (!access) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }

    const store = await getStore();

    // Bump portal_access.token_version — every portal JWT carries the
    // token_version at issue time; getPortalSessionAccess() compares it to
    // the DB value on every portal API request and rejects on mismatch.
    const newVersion = (access.token_version || 0) + 1;
    await store.upsertPortalAccess({
      id: access.id,
      token_version: newVersion,
    });

    // Audit — `portal.logout_all` distinguishes from a single-device logout.
    // F-FINAL / P1: user_id set to NULL (not `portal:<id>`) so the FK to
    // users(id) passes. Traceability is preserved via the `username` field
    // which still carries the portal email (or `portal:<id>` fallback).
    try {
      await store.appendAudit({
        tenant_id: access.tenant_id,
        user_id: null,
        username: access.portal_email || `portal:${access.id}`,
        action: "portal.logout_all",
        entity_type: "portal_access",
        entity_id: access.id,
        details: { email: access.portal_email, ip: getIp(req) },
        ip: getIp(req),
        user_agent: req.headers.get("user-agent") || null,
      });
    } catch (e) {
      console.error("[audit]", e);
    }

    // Clear the caller's own session cookie. Their JWT was already invalidated
    // by the token_version bump above; this just prevents the next request
    // from sending a stale cookie that would 401 anyway.
    await clearSessionCookie();
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[portal.logout-all]", e);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
