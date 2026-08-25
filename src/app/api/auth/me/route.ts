import { NextResponse } from "next/server";
import { getSessionFromCookie } from "@/lib/auth/session";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await getSessionFromCookie();
    if (!session) {
      return NextResponse.json({ user: null }, { status: 401 });
    }

    // Dynamically import store to avoid crashes if DB is not configured
    const { getStore } = await import("@/lib/data/store");
    const store = await getStore();
    const user = await store.getUserById(session.sub);
    if (!user || !user.active) {
      return NextResponse.json({ user: null }, { status: 401 });
    }

    // token version mismatch → invalid session
    if (user.token_version !== session.token_version) {
      return NextResponse.json({ user: null }, { status: 401 });
    }

    // ── Impersonation surface ─────────────────────────────────────────────
    // When the session carries an active impersonation claim, return the
    // effective (target) user and the impersonation metadata so the UI can
    // render a banner + End button.
    //
    // P1 ghost-JWT hardening (task C-5 Fix 6): mirror the check added to
    // `requireAuth` — if the impersonation claim snapshots a
    // `target_token_version` and it no longer matches the target's current
    // `token_version`, the impersonation has been revoked (target's password
    // was reset, etc.) and we fall back to returning the super_admin's own
    // identity. This keeps /api/auth/me consistent with the actual auth
    // gate — without it, the UI would render the impersonation banner
    // while every other API call returns the super_admin's identity.
    if (session.impersonating && user.role === "super_admin") {
      const notExpired = new Date(session.impersonating.expires_at).getTime() > Date.now();
      if (notExpired) {
        const target = await store.getUserById(session.impersonating.target_user_id);
        if (target && target.active) {
          const snap = session.impersonating.target_token_version;
          const targetStillValid =
            snap === undefined || snap === target.token_version;
          if (targetStillValid) {
            const { password_hash: _p1, totp_secret: _t1, ...safeTarget } = target;
            return NextResponse.json({
              user: safeTarget,
              impersonation: {
                original_super_admin_id: session.impersonating.original_super_admin_id,
                original_username: session.impersonating.original_username,
                target_user_id: session.impersonating.target_user_id,
                target_tenant_id: session.impersonating.target_tenant_id,
                expires_at: session.impersonating.expires_at,
              },
            });
          }
        }
      }
    }

    const { password_hash, totp_secret, recovery_codes, ...safeUser } = user;
    let defaultLocale: string | null = null;
    try {
      defaultLocale = await store.getSetting<string>("default_locale", user.tenant_id ?? null);
    } catch {
      // non-fatal — locale falls back client-side
    }
    return NextResponse.json({ user: safeUser, default_locale: defaultLocale });
  } catch (e) {
    console.error("[auth/me] Error:", e);
    // Return null user instead of crashing — app will show login page
    return NextResponse.json({ user: null, error: "db_connection_failed" }, { status: 200 });
  }
}
