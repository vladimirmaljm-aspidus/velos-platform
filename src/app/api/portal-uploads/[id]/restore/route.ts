import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { getPortalUpload, restorePortalUpload } from "@/lib/portal/uploads";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

/** Super-admin fallback: no tenant scope → look up tenant_id from the row itself. */
async function findAnyUpload(id: string) {
  const { data } = await getSupabase().from("portal_uploads").select("*").eq("id", id).maybeSingle();
  return data as any;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/portal-uploads/[id]/restore                                    (101)
//
// Undo a soft-delete. The portal-uploads view soft-deletes by default
// (deleted rows stay in storage for recovery); this route brings one back
// for the client. Tenant admins: own tenant only; super admin: any tenant.
//
// Audited as portal_upload.restore.
// ─────────────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    {
      const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "portal-uploads.update"); if (_d) return _d;
    }

    const { id } = await params;
    const upload = auth.isSuperAdmin
      ? await findAnyUpload(id)
      : await getPortalUpload(id, auth.tenantId || "");
    if (!upload) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && upload.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!upload.deleted_at) {
      return NextResponse.json({ error: "This file is not deleted." }, { status: 409 });
    }

    const restored = await restorePortalUpload(id, upload.tenant_id);
    if (!restored) return NextResponse.json({ error: "Not found." }, { status: 404 });

    await audit(auth.store, auth.user, req, "portal_upload.restore", "portal_upload", id, {
      filename: upload.filename,
      deleted_by: upload.deleted_by,
      deleted_at: upload.deleted_at,
    });
    return NextResponse.json(restored);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) || "Internal server error" }, { status: 500 });
  }
}
