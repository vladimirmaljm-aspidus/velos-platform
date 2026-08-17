import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

const BUCKET = "shared-documents";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "documents.read"); if (_d) return _d; }

    const { id } = await params;
    const doc = await auth.store.getDocument(id);
    if (!doc) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && (doc as any).tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const path = (doc as any).storage_path as string | undefined;
    if (!path) return NextResponse.json({ error: "No file attached to this document." }, { status: 404 });

    const inline = new URL(req.url).searchParams.get("mode") !== "download";
    const sb = getSupabase();
    const { data, error } = await sb.storage
      .from(BUCKET)
      .createSignedUrl(path, 300, inline ? undefined : { download: (doc as any).filename || true });
    if (error || !data?.signedUrl) return NextResponse.json({ error: "Storage unavailable." }, { status: 502 });
    return NextResponse.redirect(data.signedUrl, 302);
  } catch (error: any) {
    console.error("[documents GET id]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (documents.delete)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "documents.delete"); if (_d) return _d; } /* requirePermission wired */

    const { id } = await params;
    // Use a direct fetch by ID — works for both regular users (tenant-scoped
    // at the policy level) and super_admin (no scope). (Audit finding H-9.)
    const { data: existing, error } = await (auth.store as any)
      .sb()
      .from("shared_documents")
      .select("id, tenant_id")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    // Tenant ownership check for non-super-admins.
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    // Cascade: revoke any document_verifications rows that reference this
    // document. Without this, deleting a doc leaves orphaned verification
    // records that the public verify endpoint would still honour as "valid".
    // (Audit finding E P1.)
    try {
      await (auth.store as any)
        .sb()
        .from("document_verifications")
        .delete()
        .eq("document_id", id);
    } catch (cascadeErr) {
      console.warn("[documents DELETE] document_verifications cascade failed:", cascadeErr);
    }
    await auth.store.deleteDocument(id);
    await audit(auth.store, auth.user, req, "document.delete", "document", id);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("[documents DELETE id]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
