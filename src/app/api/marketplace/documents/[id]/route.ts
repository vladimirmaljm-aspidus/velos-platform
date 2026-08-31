import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import {
  getDocument,
  sanitisePublicDocument,
  updateDocument,
  isValidDocumentStatus,
} from "@/lib/data/marketplace-trade-documents-store";
import { getSupabase } from "@/lib/supabase/client";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/documents/[id] — fetch a trade document.
// Auth: the issuer, OR a participant in the linked post / negotiation /
// shipment (the auth check is delegated to the store via the
// tenant-scoped read; per-participant access is verified here by
// following the FK chain).
async function _get(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const doc = await getDocument(id, access.tenant_id);
    if (!doc) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    // Per-participant auth check: the caller must be the issuer, OR be a
    // participant in the linked marketplace entity. We resolve each FK
    // and check the caller's partner_id against the post owner / the
    // negotiation pair / the booking partner. If none of these match,
    // the caller is not authorised to view this document.
    const isIssuer = doc.partner_id === access.partner_id;
    if (!isIssuer) {
      const authorised = await isParticipantInLinkedEntity(doc, access.partner_id);
      if (!authorised) {
        return NextResponse.json({ error: "Not found." }, { status: 404 });
      }
      // Non-issuer viewers see the sanitised shape (partner_id stripped).
      return NextResponse.json({ document: sanitisePublicDocument(doc), is_issuer: false });
    }
    return NextResponse.json({ document: doc, is_issuer: true });
  } catch (e: any) {
    console.error("[marketplace.documents.get]", e);
    return NextResponse.json({ error: "Failed to load document." }, { status: 500 });
  }
}

// PUT /api/marketplace/documents/[id] — update a trade document. Issuer
// only. Signed documents are immutable (the store refuses to update a
// row whose digital_signature column is non-null).
async function _put(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Validate enum fields when supplied.
  if (body.status !== undefined && body.status !== null && !isValidDocumentStatus(String(body.status))) {
    return NextResponse.json({ error: "Invalid status." }, { status: 400 });
  }
  if (body.document_data !== undefined && body.document_data !== null && (typeof body.document_data !== "object" || Array.isArray(body.document_data))) {
    return NextResponse.json({ error: "document_data must be an object." }, { status: 400 });
  }
  if (typeof body.reference_number === "string" && body.reference_number.length > 64) {
    return NextResponse.json({ error: "reference_number is too long (max 64 chars)." }, { status: 400 });
  }
  if (typeof body.generated_pdf_url === "string" && body.generated_pdf_url.length > 2048) {
    return NextResponse.json({ error: "generated_pdf_url is too long." }, { status: 400 });
  }

  try {
    const updated = await updateDocument(id, access.tenant_id, access.partner_id, {
      status: body.status,
      document_data: body.document_data,
      generated_pdf_url: body.generated_pdf_url,
      reference_number: body.reference_number,
    });
    if (!updated) {
      return NextResponse.json({ error: "Not found or not authorised." }, { status: 404 });
    }
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.document_updated",
        "marketplace_trade_documents",
        updated.id,
        { document_type: updated.document_type, status: updated.status },
      );
    } catch (e) {
      console.error("[marketplace.documents.update] audit failed:", e);
    }
    return NextResponse.json(updated);
  } catch (e: any) {
    console.error("[marketplace.documents.update]", e);
    const msg = sanitizeError(e);
    const status = /signed and cannot be modified/i.test(msg)
      ? 409
      : /not found/i.test(msg)
        ? 404
        : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/documents/[id]");
export const PUT = withApm(_put, "PUT /api/marketplace/documents/[id]");

// ─── Participant check ─────────────────────────────────────────────────────

/**
 * Resolve the linked marketplace entity on the document (post /
 * negotiation / shipment) and verify the caller's partner_id is one of
 * the participants (post owner / negotiation pair / booking partner).
 *
 * Returns true when authorised. The document is tenant-scoped at the
 * store layer so a partner from tenant A cannot reach a document in
 * tenant B even if they know the id — this function only resolves
 * cross-participant access within the same tenant.
 */
async function isParticipantInLinkedEntity(
  doc: { post_id: string | null; negotiation_id: string | null; shipment_id: string | null },
  partnerId: string,
): Promise<boolean> {
  const sb = getSupabase();

  if (doc.post_id) {
    const { data } = await sb
      .from("marketplace_posts")
      .select("partner_id")
      .eq("id", doc.post_id)
      .maybeSingle();
    const r = data as { partner_id: string } | null;
    if (r && r.partner_id === partnerId) return true;
  }

  if (doc.negotiation_id) {
    const { data } = await sb
      .from("marketplace_negotiations")
      .select("partner_id_a, partner_id_b")
      .eq("id", doc.negotiation_id)
      .maybeSingle();
    const r = data as { partner_id_a: string; partner_id_b: string } | null;
    if (r && (r.partner_id_a === partnerId || r.partner_id_b === partnerId)) return true;
  }

  if (doc.shipment_id) {
    const { data } = await sb
      .from("marketplace_shipments")
      .select("partner_id")
      .eq("id", doc.shipment_id)
      .maybeSingle();
    const r = data as { partner_id: string } | null;
    if (r && r.partner_id === partnerId) return true;
  }

  return false;
}
