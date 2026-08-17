import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";
import { getPortalUpload, softDeletePortalUpload, hardDeletePortalUpload } from "@/lib/portal/uploads";
import { getSupabase } from "@/lib/supabase/client";

/** Super-admin fallback: no tenant scope → look up tenant_id from the row itself. */
async function findAnyUpload(id: string) {
  const { data } = await getSupabase().from("portal_uploads").select("*").eq("id", id).maybeSingle();
  return data as any;
}

export const runtime = "nodejs";

/**
 * GET    /api/portal-uploads/[id]        → metadata
 * DELETE /api/portal-uploads/[id]        → soft-delete (default) or ?hard=1 to remove storage + row
 */

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(_req);
    if (auth instanceof NextResponse) return auth;
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "portal-uploads.read"); if (_d) return _d; }

    const { id } = await params;
    const finalUpload = auth.isSuperAdmin
      ? await findAnyUpload(id)
      : await getPortalUpload(id, auth.tenantId || "");
    if (!finalUpload) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && finalUpload.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return NextResponse.json(finalUpload);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "portal-uploads.delete"); if (_d) return _d; }

    const { id } = await params;
    const upload = await getPortalUpload(id, auth.tenantId || "");
    if (!upload) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && upload.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    const hard = new URL(req.url).searchParams.get("hard") === "1";
    if (hard) {
      await hardDeletePortalUpload(id, upload.tenant_id);
      await audit(auth.store, auth.user, req, "portal_upload.hard_delete", "portal_upload", id, { filename: upload.filename, storage_path: upload.storage_path });
      return NextResponse.json({ ok: true, hard: true });
    }
    await softDeletePortalUpload(id, upload.tenant_id, auth.user.username);
    await audit(auth.store, auth.user, req, "portal_upload.soft_delete", "portal_upload", id, { filename: upload.filename });
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
