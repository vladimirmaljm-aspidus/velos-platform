import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { uploadPortalFile } from "@/lib/upload/service";
import { verifyPortalUpload } from "@/lib/upload/verify-file";
import { MAX_UPLOAD_SIZE, MAX_UPLOAD_SIZE_LABEL } from "@/lib/upload/constants";
import { recordPortalUpload } from "@/lib/portal/uploads";
import { audit, getIp } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

/**
 * POST /api/portal/upload
 *
 * Portal-client-facing file upload. Accepts multipart/form-data with:
 *   - file:        the binary file (required)
 *   - category:    one of "kyc" | "rfq" | "message" | "general" | "other"
 *                  (optional, defaults to "general")
 *
 * Auth: getPortalSessionAccess (portal session cookie). The caller must
 * also pass the KYC gate (requireKycApproved) — a portal client with
 * unapproved KYC can't upload files.
 *
 * Validation:
 *   - File size ≤ MAX_UPLOAD_SIZE (25 MB, from @/lib/upload/constants)
 *   - MIME type via magic bytes (verifyPortalUpload) — the client-supplied
 *     file.type is attacker-controlled and routinely spoofed
 *   - Category is whitelisted
 *
 * Storage: the file is written to the `portal-uploads` Supabase Storage
 * bucket under the path `<tenantId>/<partnerId>/<category>/<timestamp>-<rand>.<ext>`.
 * A row is inserted in the `portal_uploads` table recording the upload
 * metadata (so the caller + admins can list/download it later).
 *
 * Returns: { id, filename, mime_type, size, url } on success.
 */
export async function POST(req: NextRequest) {
  try {
    // ── Auth + gates ───────────────────────────────────────────────────
    const access = await getPortalSessionAccess();
    if (!access) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    // KYC gate — a portal client with unapproved KYC can't upload files.
    // (Premium-tier clients with exempt_kyc=true bypass this gate.)
    const kycBlock = await requireKycApproved(access);
    if (kycBlock) return kycBlock;

    // ── Parse multipart form ──────────────────────────────────────────
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return NextResponse.json(
        { error: "Expected multipart/form-data." },
        { status: 400 },
      );
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "No file provided." }, { status: 400 });
    }

    const categoryRaw = (formData.get("category") as string | null) || "general";
    const VALID_CATEGORIES = ["kyc", "rfq", "message", "general", "other"] as const;
    if (!VALID_CATEGORIES.includes(categoryRaw as any)) {
      return NextResponse.json(
        { error: `Invalid category: ${categoryRaw}.` },
        { status: 400 },
      );
    }
    const category = categoryRaw as (typeof VALID_CATEGORIES)[number];

    // ── Size limit ────────────────────────────────────────────────────
    if (file.size > MAX_UPLOAD_SIZE) {
      return NextResponse.json(
        { error: `File too large. Max ${MAX_UPLOAD_SIZE_LABEL}.` },
        { status: 400 },
      );
    }
    if (file.size === 0) {
      return NextResponse.json({ error: "Empty file." }, { status: 400 });
    }

    // ── Verify content via magic bytes ─────────────────────────────────
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const claimedMime = file.type || "application/octet-stream";
    const verification = verifyPortalUpload(buffer, claimedMime);
    if (!verification.isValid || !verification.detectedType) {
      return NextResponse.json(
        { error: verification.error || "File content verification failed." },
        { status: 400 },
      );
    }
    const verifiedMime = verification.detectedType;

    // ── Upload to Supabase Storage ────────────────────────────────────
    const uploadResult = await uploadPortalFile({
      tenantId: access.tenant_id,
      partnerId: access.partner_id,
      category,
      fileName: file.name,
      buffer,
      contentType: verifiedMime,
      size: file.size,
    });

    // ── Record in portal_uploads table ────────────────────────────────
    const upload = await recordPortalUpload({
      tenant_id: access.tenant_id,
      partner_id: access.partner_id,
      portal_access_id: access.id,
      category,
      doc_type: null,
      kyc_submission_id: null,
      message_id: null,
      filename: file.name,
      storage_bucket: "portal-uploads",
      storage_path: uploadResult.path,
      mime_type: verifiedMime,
      size_bytes: file.size,
      uploaded_by_email: access.portal_email || null,
      description: null,
    });

    // ── Audit log ─────────────────────────────────────────────────────
    try {
      await audit(
        // store is not in scope here; use a minimal auth-like object
        await (async () => {
          const { getStore } = await import("@/lib/data/store");
          return getStore();
        })(),
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "portal.file_uploaded",
        "portal_upload",
        upload.id,
        {
          category,
          filename: file.name,
          mime_type: verifiedMime,
          size: file.size,
          partner_id: access.partner_id,
        },
      );
    } catch (e: any) {
      console.warn("[portal.upload] audit log failed:", e?.message || e);
    }

    return NextResponse.json({
      id: upload.id,
      filename: file.name,
      mime_type: verifiedMime,
      size: file.size,
      url: uploadResult.url,
    });
  } catch (e: any) {
    console.error("[portal.upload]", e);
    return NextResponse.json(
      { error: e?.message || "Internal server error." },
      { status: 500 },
    );
  }
}

// ── GET (list uploads for the caller) ────────────────────────────────────
/**
 * GET /api/portal/upload
 *
 * List the caller's own uploads (filtered by partner_id). Used by the
 * portal-messages attachment picker if/when we add a "recent uploads"
 * affordance. Returns { items, total }.
 */
export async function GET(req: NextRequest) {
  try {
    const access = await getPortalSessionAccess();
    if (!access) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    const { listPortalUploads } = await import("@/lib/portal/uploads");
    const result = await listPortalUploads(access.tenant_id, {
      partnerId: access.partner_id,
    });
    return NextResponse.json(result);
  } catch (e: any) {
    console.error("[portal.upload.list]", e);
    return NextResponse.json(
      { error: e?.message || "Internal server error." },
      { status: 500 },
    );
  }
}
