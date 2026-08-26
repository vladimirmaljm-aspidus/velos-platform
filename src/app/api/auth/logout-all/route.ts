import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, getIp } from "@/lib/api/helpers";
import { getSessionFromCookie } from "@/lib/auth/session";

export const runtime = "nodejs";

/**
 * POST /api/auth/logout-all
 *
 * "Log me out of every device" — bumps `users.token_version` so every existing
 * JWT for this user immediately fails the `requireAuth` token_version check,
 * then revokes every `sessions` row for the user (so the admin Sessions panel
 * reflects reality) and clears the caller's own session cookie.
 *
 * The bump uses the atomic `bump_token_version` RPC (SupabaseStore) — see
 * `bumpUserTokenVersion` for the concurrency rationale (audit M-4).
 *
 * This is the self-service "I forgot to log out on another device" button
 * surfaced in the Security view. It does NOT change the password — a password
 * change also rotates sessions via `rotateUserSessions`, but this endpoint is
 * for the case where the user doesn't want to (or can't) change the password
 * but still wants to invalidate all other sessions.
 *
 * Audit action `auth.logout_all` distinguishes this from a normal
 * `auth.logout` so admins can review the security log.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    // 1. Bump token_version — this is what actually invalidates the JWTs.
    //    Every JWT carries the token_version at issue time; requireAuth()
    //    compares it to the DB value on every request and rejects on mismatch.
    await auth.store.bumpUserTokenVersion(auth.user.id);

    // 2. Revoke every sessions row for this user (DB-side cleanup so the
    //    admin Sessions panel shows them all as revoked). Best-effort —
    //    individual failures don't abort the request, since the JWT bump
    //    above is the actual security gate.
    if (auth.tenantId) {
      try {
        const sessions = await auth.store.listSessions(auth.tenantId, auth.user.id);
        const active = sessions.filter((s) => !s.revoked);
        await Promise.all(
          active.map((s) =>
            // revokeSession ALSO bumps token_version, but that's idempotent —
            // the bump above already did the work, and another bump is just
            // an extra increment that future logins will pick up.
            auth.store.revokeSession(s.id).catch((e) => {
              console.error("[auth.logout-all] revokeSession failed for", s.id, e);
            })
          )
        );
      } catch (e) {
        console.error("[auth.logout-all] listSessions failed:", e);
      }
    }

    // 3. Audit — `auth.logout_all` distinguishes from a single-device logout.
    try {
      await audit(
        auth.store,
        auth.user,
        req,
        "auth.logout_all",
        "user",
        auth.user.id,
        { ip: getIp(req) },
      );
    } catch (e) {
      console.error("[audit]", e);
    }
  } catch (e) {
    console.error("[auth.logout-all] Failed to bump token_version:", e);
    // Surface the error — the user explicitly asked for a security action and
    // we shouldn't silently succeed if we couldn't invalidate other sessions.
    return NextResponse.json(
      { error: "Failed to log out other sessions. Please try again." },
      { status: 500 },
    );
  }

  // 4. Clear the caller's own session cookie. Their JWT was already invalidated
  //    by the token_version bump above; this just prevents the next request
  //    from sending a stale cookie that would 401 anyway.
  const res = NextResponse.json({ ok: true }); res.cookies.set("velos_session", "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0 }); return res;
  return NextResponse.json({ ok: true });
}
