import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getPortalUpload } from "@/lib/portal/uploads";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

/**
 * GET /api/portal/upload/[id]/download
 * Portal-side signed URL for a portal_uploads row (used by message attachments).
 * Scope: partner must own the upload.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const access = await getPortalSessionAccess();
  if (!access) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const { id } = await params;
  const upload = await getPortalUpload(id, access.tenant_id);
  if (!upload) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if ((upload as any).partner_id !== access.partner_id) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if ((upload as any).deleted_at) return NextResponse.json({ error: "Deleted." }, { status: 410 });

  const inline = new URL(req.url).searchParams.get("mode") === "inline";
  const sb = getSupabase();
  const { data, error } = await sb.storage
    .from((upload as any).storage_bucket || "portal-uploads")
    .createSignedUrl((upload as any).storage_path, 300, inline ? undefined : { download: (upload as any).filename || true });
  if (error || !data?.signedUrl) return NextResponse.json({ error: "Storage unavailable." }, { status: 502 });
  return NextResponse.redirect(data.signedUrl, 302);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
