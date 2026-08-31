import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getStore } from "@/lib/data/store";
import { uploadPortalFile } from "@/lib/upload/service";
import { verifyPortalUpload } from "@/lib/upload/verify-file";
import { recordPortalUpload, PortalUploadCategory } from "@/lib/portal/uploads";
import { audit, getIp, sanitizeError } from "@/lib/api/helpers";
import { MAX_UPLOAD_SIZE } from "@/lib/upload/constants";
// 8c-4: when the description field encodes a marketplace negotiation
// (`description = "Negotiation <uuid>"`), the uploader MUST be a party to
// that negotiation. Without this check, Partner B (NOT a party to a
// negotiation X between A and C) could forge the description and later
// share the upload-id with Partner A/C — the cross-party download path
// at `/api/portal/attachments/[id]` would then accept it because Partner
// A/C IS a party to negotiation X. This closes the "forge description to
// leak bait files into other negotiations" vector at the source.
import { getSupabase } from "@/lib/supabase/client";
// AUDIT16 — portal_email is encrypted at rest; decrypt for the stored
// uploaded_by_email + audit username (no-op on legacy plaintext rows).
import { decryptField } from "@/lib/crypto/field-encryption";

export const runtime = "nodejs";

/**
 * POST /api/portal/upload
 *
 * Portal-side multipart upload handler — fixes 2b2-F1.
 *
 * BEFORE this route existed, the portal-messages composer and the
 * marketplace negotiation-room document button both POSTed to
 * `/api/portal/upload` (singular). That URL had no handler — only the
 * admin-scoped `/api/portal-uploads/*` (plural) route existed, and it
 * only implemented a GET (list) + GET/[id] (metadata) + DELETE. So
 * every portal→admin attachment upload 404'd silently, the toast
 * "Upload failed." fired, and no attachment was ever stored. Even if
 * the URL had been corrected to the plural admin route, that route
 * is gated by `requireAuth` (admin) + `requirePermission("portal-uploads.read")`,
 * so a portal_client session cookie would 401 on download.
 *
 * This route is the portal-side counterpart:
 *   • Auth via `getPortalSessionAccess` (portal session cookie, NOT
 *     admin `requireAuth`).
 *   • Multipart form-data: `file` (required), `category` (default
 *     "general"), `doc_type` (optional), `description` (optional).
 *   • Stores the file in the `portal-uploads` Supabase Storage
 *     bucket under `<tenant_id>/<partner_id>/<category>/<timestamp>-<rand>.<ext>`.
 *   • Inserts a `portal_uploads` row scoped to the caller's tenant +
 *     partner + portal_access.
 *   • Returns the row so the frontend can construct the
 *     `/api/portal/attachments/<id>` download URL.
 *
 * The companion download route at `/api/portal/attachments/[id]`
 * (GET) verifies the upload belongs to the caller's tenant+partner
 * before minting a short-lived signed URL.
 *
 * 2b2-F1 — see worklog Task 2-b (round 2).
 */
export async function POST(req: NextRequest) {
  try {
    const access = await getPortalSessionAccess();
    if (!access) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    const store = await getStore();

    // ── Parse multipart form-data ───────────────────────────────────────
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return NextResponse.json({ error: "Invalid multipart body." }, { status: 400 });
    }

    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "File is required." }, { status: 400 });
    }

    // Category — must be one of the allowed portal-upload categories. We
    // only accept the categories that a portal client can legitimately
    // attach to a thread/negotiation (not "kyc" — that's a separate route
    // with its own KYC-submission ownership check).
    const rawCategory = (formData.get("category") as string | null) || "general";
    const ALLOWED_CATEGORIES: PortalUploadCategory[] = ["message", "rfq", "general", "other"];
    if (!ALLOWED_CATEGORIES.includes(rawCategory as PortalUploadCategory)) {
      return NextResponse.json({ error: "Invalid category." }, { status: 400 });
    }
    const category = rawCategory as PortalUploadCategory;

    const docType = (formData.get("doc_type") as string | null) || null;
    const description = (formData.get("description") as string | null) || null;

    // 8c-4: when the description encodes a marketplace negotiation
    // (`description = "Negotiation <uuid>"`), the UPLOADER must be a party
    // to that negotiation. Without this check, a malicious Partner B
    // (NOT party to negotiation X between A and C) could forge the
    // description and later share the upload-id with Partner A/C — the
    // cross-party download path at /api/portal/attachments/[id] would
    // accept it because Partner A/C IS party to negotiation X. Closing
    // the forge-description vector at the source (upload route) AND at
    // the destination (download route — see the matching fix below).
    if (category === "general" && docType === "marketplace_negotiation" && description && description.startsWith("Negotiation ")) {
      const negotiationId = description.slice("Negotiation ".length).trim();
      if (/^[a-f0-9-]{36}$/i.test(negotiationId)) {
        const sb = getSupabase();
        const { data: negRow } = await sb
          .from("marketplace_negotiations")
          .select("partner_id_a, partner_id_b, tenant_id_a, tenant_id_b")
          .eq("id", negotiationId)
          .maybeSingle();
        const neg = negRow as {
          partner_id_a: string;
          partner_id_b: string;
          tenant_id_a: string;
          tenant_id_b: string;
        } | null;
        const isUploaderParty = !!neg &&
          neg.tenant_id_a === access.tenant_id &&
          neg.tenant_id_b === access.tenant_id &&
          (neg.partner_id_a === access.partner_id || neg.partner_id_b === access.partner_id);
        if (!isUploaderParty) {
          // Audit-log the forge attempt so ops can spot the pattern of a
          // partner trying to leak bait files into other negotiations.
          try {
            await audit(
              store,
              {
                id: undefined,
                username: access.portal_email || `portal:${access.id}`,
                tenant_id: access.tenant_id,
              },
              req,
              "portal.upload_negotiation_forge_blocked",
              "marketplace_negotiation",
              negotiationId,
              {
                attempted_description: description,
                uploader_partner_id: access.partner_id,
                ip: getIp(req),
              },
            );
          } catch (e) {
            console.error("[portal.upload POST] audit (forge blocked) failed:", e);
          }
          return NextResponse.json(
            { error: "Cannot attach to a negotiation you are not a party to." },
            { status: 403 },
          );
        }
      }
    }

    // ── Size + MIME validation ───────────────────────────────────────────
    // 2b2-F1 — size cap from the shared constants (25 MB). The KYC route
    // uses MAX_KYC_UPLOAD_SIZE (10 MB); the portal-message/negotiation
    // attachment path uses the general MAX_UPLOAD_SIZE (25 MB).
    if (file.size > MAX_UPLOAD_SIZE) {
      return NextResponse.json({ error: "File too large. Max 25MB." }, { status: 400 });
    }
    if (file.size === 0) {
      return NextResponse.json({ error: "Empty file." }, { status: 400 });
    }

    // Read file buffer once and verify actual content via magic bytes
    // (prevents MIME spoofing — the client-supplied `file.type` is NOT
    // trusted; the verified `detectedType` is used for the storage path
    // extension AND for the inserted `mime_type`).
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const verification = verifyPortalUpload(buffer, file.type);
    if (!verification.isValid) {
      return NextResponse.json({ error: verification.error || "Invalid file." }, { status: 400 });
    }
    const verifiedMime = verification.detectedType || file.type;

    // ── Upload to Supabase Storage ──────────────────────────────────────
    // The path pattern is `<tenant>/<partner>/<category>/<ts>-<rand>.<ext>`
    // (mirrors `uploadKycDocument`). The bucket is the same
    // `portal-uploads` bucket the admin route reads from — admins see
    // every portal upload via `/api/portal-uploads` (admin-side).
    const uploadResult = await uploadPortalFile({
      tenantId: access.tenant_id,
      partnerId: access.partner_id,
      category,
      fileName: file.name,
      buffer,
      contentType: verifiedMime,
      size: file.size,
    });

    // ── Insert portal_uploads row ────────────────────────────────────────
    // Owned by the caller's tenant + partner + portal_access. The admin
    // route `/api/portal-uploads` filters by tenant_id; the portal-side
    // download route `/api/portal/attachments/[id]` filters by both
    // tenant_id AND partner_id (defense-in-depth).
    const row = await recordPortalUpload({
      tenant_id: access.tenant_id,
      partner_id: access.partner_id,
      portal_access_id: access.id,
      category,
      doc_type: docType,
      kyc_submission_id: null,
      message_id: null, // set later by the messages POST route if attached to a portal_message
      filename: file.name,
      storage_bucket: "portal-uploads",
      storage_path: uploadResult.path,
      mime_type: verifiedMime,
      size_bytes: file.size,
      // AUDIT16 — decrypt the uploader's email: the "Uploaded by" column
      // in the admin portal-uploads view showed the enc: ciphertext for
      // every API-created portal row (the row itself stays auditable;
      // the plaintext is what the UI is meant to display).
      uploaded_by_email: access.portal_email
        ? decryptField(access.portal_email) || access.portal_email
        : null,
      description,
    });

    // ── Audit ───────────────────────────────────────────────────────────
    // Separate audit event from the admin's `portal_upload.create` — this
    // is a portal-client action, so we use `portal.upload_created` and
    // pass `id: undefined` (FK to users.id is NULL because portal
    // clients have no users row) + `username: "portal:<email>"` for
    // traceability. Mirrors the audit pattern in
    // `src/app/api/portal/messages/route.ts`.
    try {
      await audit(
        store,
        {
          id: undefined,
          // AUDIT16 — audit usernames must be the DECRYPTED email, not the
          // enc: blob (audit15 pattern).
          username: access.portal_email
            ? decryptField(access.portal_email) || `portal:${access.id}`
            : `portal:${access.id}`,
          tenant_id: access.tenant_id,
        },
        req,
        "portal.upload_created",
        "portal_upload",
        row.id,
        {
          filename: file.name,
          category,
          doc_type: docType,
          mime_type: verifiedMime,
          size: file.size,
          storage_path: uploadResult.path,
        },
      );
    } catch (e) {
      console.error("[audit portal.upload_created]", e);
    }

    return NextResponse.json(row);
  } catch (e: any) {
    console.error("[portal.upload.POST]", e);
    return NextResponse.json({ error: sanitizeError(e)}, { status: 500 });
  }
}
