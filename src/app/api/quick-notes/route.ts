import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "notes.read"); if (_d) return _d; }
  if (!auth.tenantId) return NextResponse.json({ items: [] });

  const sb = getSupabase();
  const { data, error } = await sb
    .from("quick_notes")
    .select("*")
    .eq("tenant_id", auth.tenantId)
    .eq("user_id", auth.user.id)
    .order("pinned", { ascending: false })
    .order("updated_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ items: data || [] });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "notes.create"); if (_d) return _d; }
  if (!auth.tenantId) return NextResponse.json({ error: "No tenant context." }, { status: 400 });

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const sb = getSupabase();
  const row = {
    id: body.id || undefined,
    tenant_id: auth.tenantId,
    user_id: auth.user.id,
    title: body.title || "",
    content: body.content || "",
    category: body.category || "general",
    color: body.color || "#f59e0b",
    pinned: !!body.pinned,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = body.id
    ? await sb.from("quick_notes").update(row).eq("id", body.id).eq("tenant_id", auth.tenantId).eq("user_id", auth.user.id).select().single()
    : await sb.from("quick_notes").insert(row).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  try {
    await audit(
      auth.store,
      auth.user,
      req,
      body.id ? "quick_note.update" : "quick_note.create",
      "quick_note",
      data?.id,
      {}
    );
  } catch (e) { console.error("[audit]", e); }
  return NextResponse.json(data);
}
