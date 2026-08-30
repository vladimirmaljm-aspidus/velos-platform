import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getStore } from "@/lib/data/store";
import { getPortalUpload } from "@/lib/portal/uploads";
import { getSupabase } from "@/lib/supabase/client";
import { audit } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * GET /api/portal/attachments/[id]
 *
 * Portal-side download route — fixes 2b2-F1.
 *
 * BEFORE this route existed, the only download surface for a
 * portal_uploads row was `/api/portal-uploads/[id]/download` (admin,
 * `requireAuth` + `requirePermission("portal-uploads.download")`). A
 * portal_client session cookie would 401 at that route — the portal
 * user could not download their own uploaded attachment.
 *
 * This route is the portal-side counterpart:
 *   • Auth via `getPortalSessionAccess` (portal session cookie, NOT
 *     admin `requireAuth`).
 *   • Looks up the `portal_uploads` row by id (without the tenant
 *     filter — we need the row to compare its tenant_id against the
 *     caller's tenant_id; the comparison IS the security check).
 *   • Rejects if `upload.tenant_id !== access.tenant_id` (cross-tenant
 *     block — defense-in-depth, the store layer also enforces this).
 *   • Allows if `upload.partner_id === access.partner_id` (uploader).
 *   • ALSO allows if the upload is a marketplace negotiation attachment
 *     (`doc_type === "marketplace_negotiation"`) AND the description
 *     encodes a negotiation id AND the caller's partner_id is one of
 *     that negotiation's two parties. Closes the cross-party download
 *     case for marketplace negotiation rooms (Partner A uploads,
 *     Partner B needs to download).
 *   • Returns a 302 redirect to a short-lived (5-min) signed URL.
 *
 * 2b2-F1 — see worklog Task 2-b (round 2).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await getPortalSessionAccess();
    if (!access) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    const store = await getStore();

    const { id } = await params;

    // Fetch the upload row WITHOUT a tenant filter — we need the row to
    // compare its tenant_id against the caller's. The cross-tenant
    // check below is the security boundary.
    const sb = getSupabase();
    const { data: rawRow, error: rowErr } = await sb
      .from("portal_uploads")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (rowErr) {
      console.error("[portal.attachments.GET] row lookup failed:", rowErr.message);
      return NextResponse.json({ error: "Lookup failed." }, { status: 500 });
    }
    if (!rawRow) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const upload = rawRow as any;

    // ── Security: tenant boundary ───────────────────────────────────────
    // Always required — no cross-tenant access regardless of any other
    // check below. A portal_client of Tenant B can NEVER download a
    // Tenant A upload, period.
    if (upload.tenant_id !== access.tenant_id) {
      // Return 404 (not 403) to avoid leaking the existence of the row
      // to a caller from another tenant.
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    // Soft-deleted rows are gone — admin can still see metadata via
    // `/api/portal-uploads/[id]` (which surfaces `deleted_at`), but the
    // portal client only ever sees "deleted" for their own uploads.
    if (upload.deleted_at) {
      return NextResponse.json({ error: "This file was deleted." }, { status: 410 });
    }

    // ── Security: partner ownership OR marketplace negotiation party ────
    let allowed = upload.partner_id === access.partner_id;

    if (!allowed && upload.category === "general" && upload.doc_type === "marketplace_negotiation") {
      // Marketplace negotiation attachment: the other party to the
      // negotiation must be able to download. The negotiation id is
      // encoded in `description` as "Negotiation <uuid>" (set by the
      // negotiation-room.tsx upload code).
      const desc: string | null = upload.description || null;
      if (desc && desc.startsWith("Negotiation ")) {
        const negotiationId = desc.slice("Negotiation ".length).trim();
        // Validate it looks like a UUID — defense-in-depth against a
        // maliciously-crafted description (the description is
        // client-supplied via the upload form).
        if (/^[a-f0-9-]{36}$/i.test(negotiationId)) {
          const { data: negRow } = await sb
            .from("marketplace_negotiations")
            .select("partner_id_a, partner_id_b, tenant_id_a, tenant_id_b")
            .eq("id", negotiationId)
            .maybeSingle();
          const n = negRow as
            | {
                partner_id_a: string;
                partner_id_b: string;
                tenant_id_a: string;
                tenant_id_b: string;
              }
            | null;
          if (
            n &&
            n.tenant_id_a === access.tenant_id &&
            n.tenant_id_b === access.tenant_id &&
            (n.partner_id_a === access.partner_id || n.partner_id_b === access.partner_id) &&
            // 8c-4: ALSO verify the UPLOADER (upload.partner_id) is a party
            // to the same negotiation. Without this, a malicious Partner B
            // (NOT party to negotiation X between A and C) could forge the
            // description at upload time (now blocked at /api/portal/upload
            // by the matching 8c-4 fix, but old rows + future bypass
            // vectors are still a concern) and share the upload-id with
            // Partner A/C — Partner A/C IS a party to their own negotiation
            // so the previous check would pass and the bait file would be
            // served. Defense-in-depth: the destination check mirrors the
            // source check.
            (n.partner_id_a === upload.partner_id || n.partner_id_b === upload.partner_id)
          ) {
            allowed = true;
          }
        }
      }
    }

    if (!allowed) {
      // 404 not 403 — same reason as the tenant check above.
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    // ── Mint short-lived signed URL ─────────────────────────────────────
    // `?mode=inline` → browser renders (PDF preview, image preview).
    // Default (no mode or `?mode=attachment`) → trigger a download with
    // the original filename via Supabase's `download` option.
    const inline = new URL(req.url).searchParams.get("mode") === "inline";
    const { data: signedData, error: signedErr } = await sb.storage
      .from(upload.storage_bucket)
      .createSignedUrl(
        upload.storage_path,
        300, // 5-minute TTL — short to limit link leakage.
        inline ? undefined : { download: upload.filename || true },
      );
    if (signedErr || !signedData?.signedUrl) {
      console.error(
        "[portal.attachments.GET] signed-url mint failed:",
        signedErr?.message || "unknown",
      );
      return NextResponse.json({ error: "Storage unavailable." }, { status: 502 });
    }

    // Audit the download. Mirrors the admin route's
    // `portal_upload.download` event so the audit log captures both
    // admin and portal-client downloads of the same row.
    try {
      await audit(
        store,
        {
          id: undefined,
          username: access.portal_email || `portal:${access.id}`,
          tenant_id: access.tenant_id,
        },
        req,
        "portal.attachment_downloaded",
        "portal_upload",
        id,
        { filename: upload.filename, mode: inline ? "inline" : "attachment" },
      );
    } catch (e) {
      console.error("[audit portal.attachment_downloaded]", e);
    }

    return NextResponse.redirect(signedData.signedUrl, 302);
  } catch (e: any) {
    console.error("[portal.attachments.GET]", e);
    return NextResponse.json({ error: e?.message || "Internal server error." }, { status: 500 });
  }
}

// Suppress unused-import warning for `getPortalUpload` — the import is
// kept here so future maintainers can swap the manual `select("*")`
// above for the typed `getPortalUpload(id, tenantId)` helper without
// re-discovering the helper. (Currently the helper adds an `.eq("tenant_id",
// tenantId)` filter that we explicitly DON'T want — the cross-tenant
// check is the security boundary, so we look up by id alone.)
void getPortalUpload;
