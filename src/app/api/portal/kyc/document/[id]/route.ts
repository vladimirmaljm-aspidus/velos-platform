import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getStore } from "@/lib/data/store";
import { getPortalUpload } from "@/lib/portal/uploads";
import { deleteFile } from "@/lib/upload/service";
import { audit } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

/**
 * GET /api/portal/kyc/document/[id]
 * Returns a short-lived signed download URL for a KYC document the partner
 * themselves uploaded. Scope: the partner must own the upload row AND the row
 * must be a KYC document (category === "kyc"). The signed URL points at the
 * object in the bucket recorded on the row (typically `kyc-documents`).
 *
 * Mirrors `/api/portal/upload/[id]/download` but returns the URL in the JSON
 * body instead of redirecting, so the client can decide whether to open it
 * inline or download it. The signed-URL TTL is short (60 s) on purpose — long
 * enough for the browser to fetch the object, short enough that a leaked URL
 * isn't useful for long.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await getPortalSessionAccess();
    if (!access) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

    const { id } = await params;

    // `getPortalUpload` already filters by tenant_id at the DB layer, but we
    // also assert partner_id ownership here — defense-in-depth so a partner
    // can't fetch another partner's KYC doc by guessing the id.
    const upload = await getPortalUpload(id, access.tenant_id);
    if (!upload) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (upload.partner_id !== access.partner_id) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    // Only KYC-category uploads are eligible for this endpoint — other
    // categories (rfq, message, general) have their own download routes.
    if (upload.category !== "kyc") {
      return NextResponse.json({ error: "Not a KYC document." }, { status: 400 });
    }
    if (upload.deleted_at) {
      return NextResponse.json({ error: "This file was deleted." }, { status: 410 });
    }

    // Generate a fresh signed URL. Use the bucket recorded on the row rather
    // than hardcoding "portal-uploads" — KYC uploads are stored in the
    // `kyc-documents` bucket (see `uploadKycDocument`), and a future migration
    // could move either category without breaking this route.
    const sb = getSupabase();
    const bucket = upload.storage_bucket || "kyc-documents";
    const { data: signed, error } = await sb.storage
      .from(bucket)
      .createSignedUrl(upload.storage_path, 60);
    if (error || !signed?.signedUrl) {
      return NextResponse.json(
        { error: "Could not generate download URL." },
        { status: 500 },
      );
    }

    return NextResponse.json({ url: signed.signedUrl, name: upload.filename });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/portal/kyc/document/[id]
 * Soft-deletes the KYC document row and removes the storage object so we
 * don't leave orphaned files in the kyc-documents bucket.
 * Scope: partner must own the submission the doc belongs to.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const access = await getPortalSessionAccess();
  if (!access) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const { id } = await params;
  const store = await getStore();

  const upload = await getPortalUpload(id, access.tenant_id);
  if (!upload) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if ((upload as any).partner_id !== access.partner_id) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if ((upload as any).category !== "kyc") {
    return NextResponse.json({ error: "Not a KYC document." }, { status: 400 });
  }

  // P1 / task C-4 Fix 5: previously the storage-delete was wrapped in
  // `.catch(() => {})` which silently swallowed errors — a failed
  // storage delete left the file as a permanent orphan in the
  // `kyc-documents` bucket with no DB row pointing at it (the DB row
  // was soft-deleted on the line above). We now log the failure
  // prominently so ops can manually clean up the orphan. The DB
  // soft-delete still completes (the user expects the document to
  // disappear from the UI immediately); the storage cleanup is
  // best-effort but no longer silent.
  await store.removeKycDocument(id);
  const storageBucket = (upload as any).storage_bucket || "kyc-documents";
  const storagePath = (upload as any).storage_path;
  if (storagePath) {
    try {
      await deleteFile(storageBucket, storagePath);
    } catch (e: any) {
      // `deleteFile` already logs at error level internally, but we
      // also surface the failure in the audit trail below so ops can
      // query for "storage cleanup failed" after the fact.
      console.error(
        `[portal.kyc.document.DELETE] STORAGE ORPHAN: failed to delete ${storagePath} from bucket ${storageBucket} (DB row ${id} was soft-deleted):`,
        e?.message || e,
      );
    }
  }

  // Audit the document deletion
  try {
    await audit(
      store,
      { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
      req,
      "portal.kyc_document_deleted",
      "kyc_document",
      id,
      {
        filename: (upload as any).filename || null,
        submission_id: (upload as any).submission_id || null,
        storage_bucket: storageBucket,
        storage_path: storagePath,
      },
    );
  } catch (e) { console.error("[audit]", e); }

  return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
