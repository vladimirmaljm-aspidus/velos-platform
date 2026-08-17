import { NextRequest, NextResponse } from "next/server";
import { clearSessionCookie, getSessionFromCookie } from "@/lib/auth/session";
import { getStore } from "@/lib/data/store";
import { audit } from "@/lib/api/helpers";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  // Invalidate the JWT by bumping token_version, and revoke the SecuritySession
  // record (if any) so the Sessions tab shows the session as revoked.
  try {
    const session = await getSessionFromCookie();
    if (session) {
      const store = await getStore();
      // Fetch the user before bumping token_version so we still have their
      // info available for the audit log entry below.
      const user = await store.getUserById(session.sub);
      try {
        await store.bumpUserTokenVersion(session.sub);
      } catch (e) {
        console.error("[logout] Failed to invalidate token:", e);
      }
      // Find the user's most recent non-revoked current session and revoke it.
      try {
        const sessions = await store.listSessions(session.tenant_id ?? "", session.sub);
        const current = sessions.find((s) => s.current && !s.revoked) || sessions.find((s) => !s.revoked);
        if (current) {
          await store.revokeSessionById(current.id);
        }
      } catch (e) {
        console.error("[logout] Failed to revoke security session:", e);
      }
      // Audit the logout action.
      if (user) {
        try {
          await audit(
            store,
            { id: user.id, username: user.username, tenant_id: user.tenant_id },
            req,
            "auth.logout",
            "user",
            user.id,
            {}
          );
        } catch (e) {
          console.error("[audit]", e);
        }
      }
    }
  } catch (e) {
    console.error("[logout] Unexpected error:", e);
  }
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}
