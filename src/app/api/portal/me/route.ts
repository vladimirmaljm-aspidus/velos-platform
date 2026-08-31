import { NextRequest, NextResponse } from "next/server";
import { getSessionFromCookie, clearSessionCookie, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { audit } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";

export const runtime = "nodejs";

export async function GET() {
  try {
    // AUDIT18: delegate to getPortalSessionAccess (the canonical portal
    // session gate) instead of hand-rolling a subset of its checks. The
    // local copy skipped the SessionConfig absolute-TTL and idle-timeout
    // checks (getPortalSessionAccess lines 58–80) and the `portal:`-prefix
    // sub validation — so /me stayed fresh after an idle-timeout while every
    // other portal call 401'd, and the portal shell rendered a logged-in UI
    // over a dead session. Same 401 semantics as the rest of the portal API.
    const access = await getPortalSessionAccess();
    if (!access) {
      return NextResponse.json({ access: null }, { status: 401 });
    }
    // FIX-AUDIT4-SEC / Fix 8 — strip sensitive / internal columns from the
    // portal_access row before returning it to the portal client. The
    // previous implementation only stripped `password_hash`, leaking:
    //   • `portal_email_hmac` — internal HMAC search token (server-side
    //     key only — leaking it to the client gives an attacker who
    //     also exfiltrates the DB a head start on email-equality
    //     offline enumeration, even with the env key).
    //   • `failed_attempts` / `locked_until` — internal lockout state;
    //     exposing these lets an attacker tune a credential-stuffing
    //     campaign to stay just under the lockout threshold.
    //   • `token_version` — the JWT-binding version. The portal client
    //     has no business reading it (it's checked server-side); leaking
    //     it gives an attacker an oracle for "did my password reset
    //     invalidate my old session?" recon.
    //   • `recovery_codes` / `setup_token` if present (defense-in-depth
    //     — they should already be null on an active session, but
    //     strip anyway in case the schema grows them later).
    const {
      password_hash,
      portal_email_hmac,
      failed_attempts,
      locked_until,
      token_version,
      recovery_codes,
      setup_token,
      ...safeAccess
    } = access as any;
    // AUDIT16 — decrypt the client's own email (parity with every admin
    // read path; the portal client obviously knows their own address, and
    // the UI previously risked rendering the enc: blob for it).
    if (safeAccess.portal_email && typeof safeAccess.portal_email === "string") {
      const { decryptField } = await import("@/lib/crypto/field-encryption");
      safeAccess.portal_email = decryptField(safeAccess.portal_email);
    }
    return NextResponse.json({ access: safeAccess });
  } catch (e) {
    console.error("[portal/me] Error:", e);
    // AUDIT16 — DB outage ≠ "not authenticated" (same fix as /api/auth/me):
    // 503 instead of 200, so the portal shell can retry instead of
    // bouncing the client to the login screen over a transient DB blip.
    return NextResponse.json(
      { access: null, error: "db_connection_failed" },
      { status: 503, headers: { "Retry-After": "5" } },
    );
  }
}

// Portal logout — clears the session cookie. Audited as `portal.logout` so
// the audit trail captures session-end events for compliance.
export async function POST(req: NextRequest) {
  try {
    const session = await getSessionFromCookie();
    if (session && session.role === "portal_client") {
      const accessId = session.sub.slice("portal:".length);
      try {
        const { getStore } = await import("@/lib/data/store");
        const store = await getStore();
        await audit(
          store,
          { id: session.sub, username: session.username || "", tenant_id: session.tenant_id || null },
          req,
          "portal.logout",
          "portal_access",
          accessId,
          {},
        );
        // CRITICAL FIX (audit S-4): bump portal_access.token_version so stolen
        // cookies become invalid immediately after logout (was: valid for 7 days).
        const access = await store.getPortalAccessById(accessId);
        if (access) {
          try {
            const { data: pa } = await getSupabase()
              .from("portal_access")
              .select("token_version")
              .eq("id", access.id)
              .maybeSingle();
            if (pa) {
              await getSupabase()
                .from("portal_access")
                .update({ token_version: (pa.token_version ?? 0) + 1 })
                .eq("id", access.id);
            }
          } catch (e) {
            console.error("[portal logout] token_version bump failed:", e);
          }
        }
      } catch (e) { console.error("[audit]", e); }
    }
  } catch (e) { console.error("[portal/me.logout]", e); }

  // CRITICAL FIX: same as admin logout — clearSessionCookie() via
  // cookies().delete() doesn't work when returning NextResponse.json().
  // Set the cookie deletion directly on the response.
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}

// PUT — update portal client preferences (currently: locale).
// Each portal client can choose their preferred language.
export async function PUT(req: NextRequest) {
  try {
    const session = await getSessionFromCookie();
    if (!session || session.role !== "portal_client") {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    const accessId = session.sub.slice("portal:".length);
    const body = await req.json();

    // Only allow locale update for now (whitelist fields).
    const update: Record<string, unknown> = {};
    if (body.locale && ["en", "sr", "tr", "de", "ru"].includes(body.locale)) {
      update.locale = body.locale;
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "No valid fields to update." }, { status: 400 });
    }

    const { error } = await getSupabase()
      .from("portal_access")
      .update(update)
      .eq("id", accessId);

    if (error) {
      return NextResponse.json({ error: "Failed to update preferences." }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Internal server error." }, { status: 500 });
  }
}
