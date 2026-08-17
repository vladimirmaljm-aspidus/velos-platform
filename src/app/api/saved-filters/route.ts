import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";

export const runtime = "nodejs";

/**
 * GET /api/saved-filters?module=partners
 * Lists saved filters for the current user (optionally filtered by module).
 *
 * POST /api/saved-filters
 * Body: { module, name, filters: {...}, columns?: [...], is_default?: bool }
 * Creates or updates a saved filter.
 *
 * DELETE /api/saved-filters?id=xxx&module=xxx
 * Removes a saved filter.
 */

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (settings.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "settings.read"); if (_d) return _d; } /* requirePermission wired */


  const url = new URL(req.url);
  const mod = url.searchParams.get("module");

  const store = await getStore();
  // Saved filters are stored as user preferences with key "saved_filter:{module}:{id}"
  const prefs = await store.listUserPreferences(auth.user.id);
  let filters = prefs.filter((p) => p.preference_key.startsWith("saved_filter:"));

  if (mod) {
    filters = filters.filter((p) => p.preference_key.startsWith(`saved_filter:${mod}:`));
  }

  const result = filters.map((p) => {
    try {
      const parsed = JSON.parse(p.preference_value);
      return {
        id: p.preference_key.split(":")[2],
        module: p.preference_key.split(":")[1],
        ...parsed,
      };
    } catch {
      return null;
    }
  }).filter(Boolean);

  return NextResponse.json({ items: result });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (settings.create)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "settings.update"); if (_d) return _d; } /* requirePermission wired */


  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { module, name, filters, columns, is_default } = body;

  if (!module || !name) {
    return NextResponse.json({ error: "module and name are required." }, { status: 400 });
  }

  // Generate ID from name (slugify) + short random suffix to avoid collisions
  // (non-Latin names slugify to ""; same-name filters would otherwise collide)
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "filter";
  const id = `${slug}-${crypto.randomUUID().slice(0, 8)}`;
  const key = `saved_filter:${module}:${id}`;

  const store = await getStore();
  const value = JSON.stringify({ name, filters, columns, is_default: !!is_default });
  await store.setUserPreference(auth.user.id, key, value);

  try {
    await audit(auth.store, auth.user, req, "saved_filter.create", "user_preference", id, { module: body.module, name: body.name });
  } catch (e) { console.error("[audit]", e); }

  return NextResponse.json({ id, module, name, filters, columns, is_default });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (settings.delete)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "settings.update"); if (_d) return _d; } /* requirePermission wired */


  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const mod = url.searchParams.get("module");

  if (!id || !mod) {
    return NextResponse.json({ error: "id and module are required." }, { status: 400 });
  }

  const key = `saved_filter:${mod}:${id}`;
  const store = await getStore();
  // Actually delete the preference row (setUserPreference with null would
  // stringify to "null" and leave a ghost row that GET would still return).
  await store.deleteUserPreference(auth.user.id, key);

  try {
    await audit(auth.store, auth.user, req, "saved_filter.delete", "user_preference", undefined, { key: key });
  } catch (e) { console.error("[audit]", e); }

  return NextResponse.json({ ok: true });
}
