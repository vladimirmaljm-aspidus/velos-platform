import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "notes.delete"); if (_d) return _d; }
    if (!auth.tenantId) return NextResponse.json({ error: "No tenant context." }, { status: 400 });

    const { id } = await params;
    const sb = getSupabase();
    const { error } = await sb
      .from("quick_notes")
      .delete()
      .eq("id", id)
      .eq("tenant_id", auth.tenantId)
      .eq("user_id", auth.user.id);
    if (error) return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
    try {
      await audit(auth.store, auth.user, req, "quick_note.delete", "quick_note", id, {});
    } catch (e) { console.error("[audit]", e); }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[quick-notes.DELETE]", e);
    return NextResponse.json({ error: e?.message || "Internal server error." }, { status: 500 });
  }
}
