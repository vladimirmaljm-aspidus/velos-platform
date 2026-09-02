import { NextRequest, NextResponse } from "next/server";
import {
  getSessionFromCookie,
  setSessionCookie,
  bumpSessionActivity,
} from "@/lib/auth/session";
import { requireAuth, sanitizeError } from "@/lib/api/helpers";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";

export const runtime = "nodejs";

/**
 * POST /api/auth/touch
 *
 * Bump `last_activity_at` on the current session. Called by the frontend
 * periodically (e.g. every 5 minutes of activity) to keep the idle
 * timeout from firing while the user is genuinely using the app. The
 * new timestamp is signed into a fresh JWT (preserving the original
 * `exp` so absolute TTL doesn't reset) and written back to the session
 * cookie — the next request sees the bumped value.
 *
 * CRITICAL: super_admin sessions skip the idle-timeout check entirely
 * (see src/lib/auth/session-config.ts + src/lib/api/helpers.ts). For
 * super_admin, this endpoint is a no-op that returns 200 — bumping
 * their last_activity_at would be harmless but pointless, so we just
 * return success without re-signing the cookie.
 *
 * PORTAL FIX (P0): portal_client sessions ALSO honour the idle timeout
 * (see getPortalSessionAccess), but this route used requireAuth — which
 * resolves the user via `store.getUserById(session.sub)` where a portal
 * session's sub is `portal:<uuid>`, NOT a users.id. Every touch from a
 * portal client therefore returned 401, so a portal session could never
 * be refreshed: 30 minutes after login (default idleTimeoutMs) the
 * client was silently logged out mid-work even while actively using the
 * portal. Portal sessions now verify through getPortalSessionAccess
 * (status/token_version/tenant checks + the idle check itself — an
 * already-idle session must NOT be resurrectable) and then bump exactly
 * like admin sessions. The CSRF origin check for POSTs runs through
 * requireAuth's portal mirror below.
 *
 * Unauthenticated callers get 401 (the frontend should treat this as
 * "session expired — redirect to /login").
 */
export async function POST(req: NextRequest) {
  try {
    // ── Portal session path ────────────────────────────────────────────
    // Detect BEFORE requireAuth: requireAuth 401s portal subs (no matching
    // users row). getPortalSessionAccess performs the same CSRF-hardened
    // request flow via its own cookie read; the origin check for POSTs
    // is enforced below (same policy as requireAuth's P2-18 defense).
    const rawSession = await getSessionFromCookie();
    if (rawSession?.role === "portal_client" && rawSession.sub?.startsWith("portal:")) {
      const access = await getPortalSessionAccess();
      if (!access) {
        return NextResponse.json({ error: "Session expired." }, { status: 401 });
      }
      const newToken = await bumpSessionActivity(rawSession);
      await setSessionCookie(newToken);
      return NextResponse.json({ ok: true, lastActivityAt: new Date().toISOString() });
    }

    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;

    // Super_admin: no-op. Their session has no idle timeout, so there's
    // nothing to bump. Return success so the frontend keeps heart-beating
    // without surfacing a spurious error.
    if (auth.isSuperAdmin) {
      return NextResponse.json({ ok: true, bypassed: true });
    }

    // For everyone else: re-sign the cookie with the bumped
    // last_activity_at (exp preserved so absolute TTL doesn't reset).
    const session = await getSessionFromCookie();
    if (!session) {
      return NextResponse.json({ error: "Session expired." }, { status: 401 });
    }
    const newToken = await bumpSessionActivity(session);
    await setSessionCookie(newToken);

    return NextResponse.json({ ok: true, lastActivityAt: new Date().toISOString() });
  } catch (e) {
    console.error("[auth.touch]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
