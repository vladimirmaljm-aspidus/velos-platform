import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

/**
 * GET /api/portal/upload/[id]/download
 *
 * Portal-client-facing file download. Streams the uploaded file from
 * Supabase Storage. The caller must be authenticated as a portal client
 * (getPortalSessionAccess) AND must own the upload (the upload's
 * partner_id must match the caller's partner_id). This prevents a portal
 * client from downloading another client's files by guessing the upload id.
 *
 * Query params:
 *   - mode: "inline" (default) → Content-Disposition: inline (browser
 *           renders PDFs/images inline)
 *          "attachment"       → Content-Disposition: attachment (download)
 *
 * Returns: 200 with the file content + correct Content-Type, OR 302
 * redirect to a signed Supabase Storage URL when the bucket is private.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // ── Auth ───────────────────────────────────────────────────────────
    const access = await getPortalSessionAccess();
    if (!access) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }

    const { id } = await params;
    const mode = req.nextUrl.searchParams.get("mode") || "inline";

    // ── Fetch the upload row + verify ownership ───────────────────────
    const sb = getSupabase();
    const { data: upload, error } = await sb
      .from("portal_uploads")
      .select("id, tenant_id, partner_id, filename, storage_bucket, storage_path, mime_type, size_bytes, deleted_at")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      console.error("[portal.upload.download] lookup failed:", error.message);
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!upload || upload.deleted_at) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    // Tenant + partner ownership check — a portal client can only download
    // their own uploads (same tenant AND same partner).
    if (
      upload.tenant_id !== access.tenant_id ||
      upload.partner_id !== access.partner_id
    ) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    // ── Stream the file from Supabase Storage ─────────────────────────
    const bucket = upload.storage_bucket || "portal-uploads";
    const path = upload.storage_path;
    if (!path) {
      return NextResponse.json({ error: "File not available." }, { status: 404 });
    }

    // Try to download the file from Storage. For public buckets, we can
    // 302 to the public URL; for private buckets, we create a signed URL.
    // We prefer the signed-URL path for both (defence in depth — the URL
    // is short-lived and scoped to the bucket path).
    try {
      const { data, error: signedErr } = await sb.storage
        .from(bucket)
        .createSignedUrl(path, 60 * 5); // 5-minute signed URL
      if (signedErr) {
        console.error("[portal.upload.download] signed URL failed:", signedErr.message);
        // Fall through to direct download below.
      } else if (data?.signedUrl) {
        // 302 redirect to the signed URL. The browser will fetch the file
        // directly from Supabase Storage with the short-lived token.
        const headers = new Headers();
        headers.set(
          "Content-Disposition",
          `${mode === "attachment" ? "attachment" : "inline"}; filename="${encodeURIComponent(upload.filename || "download")}"`,
        );
        return NextResponse.redirect(data.signedUrl, { headers });
      }
    } catch (e: any) {
      console.warn("[portal.upload.download] signed URL exception:", e?.message || e);
    }

    // ── Fallback: stream the file through the Next.js route ──────────
    // This path is used when Supabase Storage is not configured (dev/CI
    // fallback to data: URLs) or when createSignedUrl fails.
    try {
      const { data: fileData, error: dlErr } = await sb.storage
        .from(bucket)
        .download(path);
      if (dlErr) {
        console.error("[portal.upload.download] direct download failed:", dlErr.message);
        return NextResponse.json({ error: "File not available." }, { status: 404 });
      }
      const arrayBuffer = await (fileData as Blob).arrayBuffer();
      const body = Buffer.from(arrayBuffer);
      const headers = new Headers();
      headers.set("Content-Type", upload.mime_type || "application/octet-stream");
      headers.set(
        "Content-Disposition",
        `${mode === "attachment" ? "attachment" : "inline"}; filename="${encodeURIComponent(upload.filename || "download")}"`,
      );
      headers.set("Content-Length", String(body.length));
      return new NextResponse(body, { status: 200, headers });
    } catch (e: any) {
      console.error("[portal.upload.download] stream failed:", e?.message || e);
      return NextResponse.json({ error: "File not available." }, { status: 404 });
    }
  } catch (e: any) {
    console.error("[portal.upload.download]", e);
    return NextResponse.json(
      { error: e?.message || "Internal server error." },
      { status: 500 },
    );
  }
}
