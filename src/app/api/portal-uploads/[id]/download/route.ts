import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { getPortalUpload } from "@/lib/portal/uploads";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

/**
 * GET /api/portal-uploads/[id]/download
 * Returns a 302 redirect to a short-lived signed URL for the storage object.
 * Audit-logged so we know who fetched which portal document.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "portal-uploads.download"); if (_d) return _d; }

    const { id } = await params;
    // AUDIT17 / P2 — super-admin fallback (mirrors GET/DELETE on the same
    // resource): a super-admin got 404 on downloads of uploads whose
    // metadata they could read and delete. Tenant users keep the strict
    // tenant-scoped lookup.
    const upload = auth.isSuperAdmin
      ? (await getSupabase().from("portal_uploads").select("*").eq("id", id).maybeSingle()).data as any
      : await getPortalUpload(id, auth.tenantId || "");
    if (!upload) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && upload.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (upload.deleted_at) return NextResponse.json({ error: "This file was deleted." }, { status: 410 });

    const inline = new URL(req.url).searchParams.get("mode") === "inline";
    const sb = getSupabase();
    const { data, error } = await sb.storage
      .from(upload.storage_bucket)
      .createSignedUrl(upload.storage_path, 300, inline ? undefined : { download: upload.filename || true });
    if (error || !data?.signedUrl) return NextResponse.json({ error: "Storage unavailable." }, { status: 502 });

    await audit(auth.store, auth.user, req, "portal_upload.download", "portal_upload", id, { filename: upload.filename }).catch(() => {});
    return NextResponse.redirect(data.signedUrl, 302);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) || "Internal server error" }, { status: 500 });
  }
}
