import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getStore } from "@/lib/data/store";
import { uploadKycDocument, deleteFile } from "@/lib/upload/service";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { verifyKycUpload } from "@/lib/upload/verify-file";
import { getSupabase } from "@/lib/supabase/client";
import { MAX_KYC_UPLOAD_SIZE, KYC_ALLOWED_MIME_TYPES } from "@/lib/upload/constants";

export const runtime = "nodejs";

// Portal: upload a KYC document file (multipart form-data)
export async function POST(req: NextRequest) {
  try {
    const access = await getPortalSessionAccess();
    if (!access) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    const store = await getStore();

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const docType = formData.get("type") as string | null;

    if (!file || !docType) {
      return NextResponse.json({ error: "File and document type required." }, { status: 400 });
    }

    // Validate file size — KYC docs use the stricter 10 MB limit (audit
    // P2-2 / task C-7: was a hard-coded inline literal; now sourced from
    // the shared `@/lib/upload/constants` module so it can't drift out of
    // sync with `uploadFile()` / `uploadKycDocument()`).
    if (file.size > MAX_KYC_UPLOAD_SIZE) {
      return NextResponse.json({ error: "File too large. Max 10MB." }, { status: 400 });
    }

    // Validate file type — KYC docs allow PDF + raster images only.
    const allowedTypes = KYC_ALLOWED_MIME_TYPES;
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json({ error: "Invalid file type. Allowed: PDF, JPEG, PNG, WebP." }, { status: 400 });
    }

    // Ensure submission exists
    const existing = await store.getKycSubmissionByPartner(access.partner_id);
    if (!existing) {
      return NextResponse.json({ error: "Save KYC form first." }, { status: 400 });
    }

    // Read file buffer once and verify actual content via magic bytes (prevents MIME spoofing)
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const verification = verifyKycUpload(buffer, file.type);
    if (!verification.isValid) {
      return NextResponse.json({ error: verification.error }, { status: 400 });
    }

    // P1 / task C-4 Fix 5: when a partner uploads a new KYC document of
    // a type they already have on file (e.g. re-uploading "document_front"
    // after a resubmit request), the old file in the `kyc-documents`
    // bucket was left as a permanent orphan — the new `addKycDocument`
    // call inserted a fresh `portal_uploads` row pointing at the new
    // storage path, and nothing deleted the old storage object. Over
    // time this accumulates orphaned files (one per re-upload) with no
    // DB row pointing at them.
    //
    // Fix: before inserting the new document row, look up any existing
    // non-deleted `portal_uploads` row with the same `kyc_submission_id`
    // + `doc_type`. If found, soft-delete the old DB row AND delete the
    // old storage file. The storage delete is best-effort (logged at
    // error level if it fails) so a transient storage outage doesn't
    // block the document replacement — but the orphan is now visible
    // in the logs rather than silent.
    const sb = getSupabase();
    try {
      const { data: priorDoc, error: priorErr } = await sb
        .from("portal_uploads")
        .select("id, storage_bucket, storage_path")
        .eq("tenant_id", access.tenant_id)
        .eq("partner_id", access.partner_id)
        .eq("category", "kyc")
        .eq("doc_type", docType)
        .eq("kyc_submission_id", existing.id)
        .is("deleted_at", null)
        .order("uploaded_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (priorErr) {
        console.warn("[portal.kyc.document.POST] prior-doc lookup failed:", priorErr.message);
      } else if (priorDoc) {
        const priorBucket = (priorDoc as any).storage_bucket || "kyc-documents";
        const priorPath = (priorDoc as any).storage_path;
        // Soft-delete the old DB row so it stops showing up in lists.
        try {
          await sb
            .from("portal_uploads")
            .update({ deleted_at: new Date().toISOString() })
            .eq("id", (priorDoc as any).id);
        } catch (e: any) {
          console.error(
            `[portal.kyc.document.POST] failed to soft-delete prior KYC doc row ${(priorDoc as any).id}:`,
            e?.message || e,
          );
        }
        // Delete the old storage file (best-effort, logged on failure).
        if (priorPath) {
          try {
            await deleteFile(priorBucket, priorPath);
          } catch (e: any) {
            console.error(
              `[portal.kyc.document.POST] STORAGE ORPHAN: failed to delete prior ${priorPath} from bucket ${priorBucket} (DB row soft-deleted):`,
              e?.message || e,
            );
          }
        }
      }
    } catch (e: any) {
      // Non-fatal — the new upload should still proceed even if the
      // prior-doc cleanup fails. The orphan (if any) is logged above.
      console.warn("[portal.kyc.document.POST] prior-doc cleanup threw:", e?.message || e);
    }

    // Upload to storage
    const uploadResult = await uploadKycDocument(
      existing.id,
      file.name,
      buffer,
      file.type,
      file.size
    );

    // Save document metadata
    const doc = await store.addKycDocument({
      submission_id: existing.id,
      type: docType as any,
      filename: file.name,
      storage_path: uploadResult.path,
      mime_type: file.type,
      size: file.size,
    });

    // Audit the document upload
    try {
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "portal.kyc_document_uploaded",
        "kyc_document",
        (doc as any)?.id,
        { document_type: docType, filename: file.name, mime_type: file.type, size: file.size, submission_id: existing.id },
      );
    } catch (e) { console.error("[audit]", e); }

    return NextResponse.json(doc);
  } catch (e: any) {
    console.error("[portal.kyc.document.POST]", e);
    return NextResponse.json({ error: sanitizeError(e)}, { status: 500 });
  }
}
