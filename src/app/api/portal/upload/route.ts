import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { uploadPortalFile } from "@/lib/upload/service";
import { verifyPortalUpload } from "@/lib/upload/verify-file";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/portal/upload
 *
 * Portal client file upload (chat attachments, negotiation documents).
 * Accepts multipart/form-data with a "file" field.
 *
 * Auth: requires an active portal session (getPortalSessionAccess).
 * The file is validated (MIME + size) and stored via uploadPortalFile.
 *
 * Returns: { id, url, filename, size, contentType }
 */
export async function POST(req: NextRequest) {
  try {
    const access = await getPortalSessionAccess();
    if (!access) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "No file provided." }, { status: 400 });
    }

    // Read file into buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = file.type || "application/octet-stream";
    const fileName = file.name || "upload";

    // Verify (MIME + size)
    const verification = verifyPortalUpload(buffer, contentType);
    if (!verification.ok) {
      return NextResponse.json(
        { error: verification.error || "File verification failed." },
        { status: 400 },
      );
    }

    // Upload via the shared service (handles Supabase Storage)
    const result = await uploadPortalFile({
      tenantId: access.tenant_id,
      partnerId: access.partner_id,
      portalAccessId: access.id,
      fileName,
      buffer,
      contentType,
      size: buffer.length,
      category: "message",
    });

    // Audit
    try {
      const store = await getStore();
      await audit(store, {
        action: "portal.upload",
        entity_type: "portal_upload",
        entity_id: result.id || result.path,
        tenant_id: access.tenant_id,
        user_id: access.id,
        details: { filename: fileName, size: buffer.length, content_type: contentType },
      });
    } catch {}

    return NextResponse.json({
      id: result.id || result.path,
      url: result.url,
      attachment_url: `/api/portal/upload/${result.id || result.path}/download?mode=inline`,
      filename: fileName,
      size: buffer.length,
      contentType,
    });
  } catch (error: any) {
    console.error("[api/portal/upload] error:", error);
    return NextResponse.json(
      { error: error?.message || "Upload failed." },
      { status: 500 },
    );
  }
}
