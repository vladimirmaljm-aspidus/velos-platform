import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";

export const runtime = "nodejs";

// GET /api/user-preferences — list all preferences for the current user
export async function GET() {
  try {
    const auth = await requireAuth();
    if (auth instanceof NextResponse) return auth;
    const prefs = await auth.store.listUserPreferences(auth.user.id);
    // Return as key-value map for easy consumption
    const map: Record<string, unknown> = {};
    for (const p of prefs) {
      try {
        map[p.preference_key] = JSON.parse(p.preference_value);
      } catch {
        map[p.preference_key] = p.preference_value;
      }
    }
    return NextResponse.json({ items: prefs, map });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}

// PUT /api/user-preferences — set a single preference
// Body: { key: string, value: unknown }
export async function PUT(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    const body = await req.json();
    const { key, value } = body;
    if (!key) return NextResponse.json({ error: "Missing key." }, { status: 400 });
    const pref = await auth.store.setUserPreference(auth.user.id, key, value);
    try {
      await audit(auth.store, auth.user, req, "user_preference.update", "user_preference", undefined, { keys: Object.keys(body) });
    } catch (e) { console.error("[audit]", e); }
    return NextResponse.json({ ok: true, preference: pref });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
