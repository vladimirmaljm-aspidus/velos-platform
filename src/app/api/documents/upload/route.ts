import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId } from "@/lib/api/helpers";
import { uploadFile } from "@/lib/upload/service";
import { verifyFileContent } from "@/lib/upload/verify-file";
import { MAX_UPLOAD_SIZE, ALLOWED_MIME_TYPES } from "@/lib/upload/constants";

export const runtime = "nodejs";

/**
 * POST /api/documents/upload  (multipart/form-data)
 *   file              : File            (required)
 *   partner_id        : string          (required — shared_documents.partner_id is NOT NULL)
 *   category          : string          (optional, default: "other")
 *   visible_to_partner: "true"|"false"  (optional, default: false)
 *   subject           : string          (optional display name; defaults to file.name)
 *
 * Mirrors the portal `/api/portal/upload` pattern: real multipart upload +
 * magic-bytes verification, stored in Supabase Storage bucket `shared-documents`
 * with a metadata row in `shared_documents`.
 *
 * This is a SEPARATE endpoint so the existing metadata-only `POST /api/documents`
 * keeps working for callers that depend on it (e.g. automation / migrations).
 *
 * Size limit + allowed MIME types come from the shared `@/lib/upload/constants`
 * module (audit P2-2 / task C-7) so they stay in sync with the portal upload
 * route and the `uploadFile()` guard inside `service.ts`.
 */
const ALLOWED_TYPES = ALLOWED_MIME_TYPES;
const MAX_SIZE = MAX_UPLOAD_SIZE;

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (documents.create)
  {
    const { requirePermission } = await import("@/lib/permissions/can");
    const denied = requirePermission(auth, "documents.create");
    if (denied) return denied;
  }

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const partnerId = (formData.get("partner_id") as string | null) || "";
    const category = (formData.get("category") as string) || "other";
    const visibleToPartner = formData.get("visible_to_partner") === "true";
    const subject = (formData.get("subject") as string) || file?.name || "Untitled";

    if (!file) {
      return NextResponse.json({ error: "No file provided." }, { status: 400 });
    }
    // shared_documents.partner_id is NOT NULL (see prisma/schema.prisma) —
    // reject early with a clear message instead of letting PostgREST 500.
    if (!partnerId) {
      return NextResponse.json({ error: "partner_id is required." }, { status: 400 });
    }
    if (file.size > MAX_SIZE) {
      return NextResponse.json({ error: "File too large. Max 25MB." }, { status: 400 });
    }
    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json({ error: "Invalid file type." }, { status: 400 });
    }

    // Verify actual content via magic bytes (prevents MIME spoofing).
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const verification = verifyFileContent(buffer, file.type, ALLOWED_TYPES);
    if (!verification.isValid) {
      return NextResponse.json(
        { error: verification.error || "File content verification failed." },
        { status: 400 },
      );
    }

    const tid = resolveTenantId(auth, req);
    if (!tid) {
      return NextResponse.json({ error: "No tenant context." }, { status: 400 });
    }

    // Build storage path. The on-disk extension is derived from the verified
    // MIME (NOT the client-supplied filename) so an attacker can't influence
    // the stored extension by naming their file `evil.aspx` / `evil.htm`.
    // Mirror the portal-uploads layout: <tenant>/<partner>/<category>/<ts>-<rand>.<ext>
    const ext = (file.type.split("/")[1] || "bin").replace(/[^a-zA-Z0-9]/g, "");
    const safeCat = String(category).replace(/[^a-zA-Z0-9_-]/g, "_") || "other";
    const path = `${tid}/${partnerId}/${safeCat}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext || "bin"}`;

    // Upload to Supabase Storage (or in-memory data URL when Supabase isn't
    // configured — same fallback `uploadFile` already uses).
    await uploadFile("shared-documents", path, buffer, file.type, file.size);

    // Persist metadata. Columns verified against prisma/schema.prisma and the
    // SharedDocument type — the table uses `filename` / `size`, NOT
    // `file_name` / `size_bytes`. There is no `subject` / `storage_bucket`
    // column on this table; the bucket is implicit (`shared-documents`).
    const { getSupabase } = await import("@/lib/supabase/client");
    const sb = getSupabase();
    const { data, error } = await sb.from("shared_documents").insert({
      tenant_id: tid,
      partner_id: partnerId,
      filename: subject || file.name,
      category,
      mime_type: file.type,
      size: file.size,
      storage_path: path,
      visible_to_partner: visibleToPartner,
      uploaded_by: auth.user.id,
    }).select().single();

    if (error) throw error;

    await audit(auth.store, auth.user, req, "document.upload", "shared_document", data.id, {
      name: file.name,
      size: file.size,
      partner_id: partnerId,
      category,
      visible_to_partner: visibleToPartner,
    });

    return NextResponse.json({ item: data });
  } catch (e: any) {
    console.error("[documents upload]", e);
    return NextResponse.json(
      { error: e?.message || "Upload failed." },
      { status: 500 },
    );
  }
}
