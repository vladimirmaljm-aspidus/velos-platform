import { NextRequest, NextResponse } from "next/server";
import { getSessionFromCookie, clearSessionCookie } from "@/lib/auth/session";
import { audit } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await getSessionFromCookie();
    if (!session || session.role !== "portal_client") {
      return NextResponse.json({ access: null }, { status: 401 });
    }
    const accessId = session.sub.replace("portal:", "");
    const { getStore } = await import("@/lib/data/store");
    const store = await getStore();
    const access = await store.getPortalAccessById(accessId);
    if (!access || access.status !== "active") {
      return NextResponse.json({ access: null }, { status: 401 });
    }
    if ((session.token_version || 0) !== (access.token_version || 0)) {
      return NextResponse.json({ access: null }, { status: 200 });
    }
    return NextResponse.json({ access: { ...access, password_hash: undefined } });
  } catch (e) {
    console.error("[portal/me] Error:", e);
    return NextResponse.json({ access: null }, { status: 200 });
  }
}

// Portal logout — clears the session cookie. Audited as `portal.logout` so
// the audit trail captures session-end events for compliance.
export async function POST(req: NextRequest) {
  try {
    const session = await getSessionFromCookie();
    if (session && session.role === "portal_client") {
      const accessId = session.sub.replace("portal:", "");
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

  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}

// PUT — update portal client preferences (currently: locale).
// Each portal client can choose their preferred language.
export async function PUT(req: NextRequest) {
  try {
    const session = await getSessionFromCookie();
    if (!session || session.role !== "portal_client") {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    const accessId = session.sub.replace("portal:", "");
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
