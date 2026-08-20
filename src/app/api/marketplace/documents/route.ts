import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import {
  createDocument,
  listDocuments,
  isValidDocumentType,
  isValidDocumentStatus,
} from "@/lib/data/marketplace-trade-documents-store";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/documents — list the caller's trade documents.
// Optional query: ?post_id=…&negotiation_id=…&shipment_id=…&document_type=…&status=…&limit=50&offset=0
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  try {
    const url = new URL(req.url);
    const document_type = url.searchParams.get("document_type") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const limit = url.searchParams.get("limit");
    const offset = url.searchParams.get("offset");
    const post_id = url.searchParams.get("post_id") || undefined;
    const negotiation_id = url.searchParams.get("negotiation_id") || undefined;
    const shipment_id = url.searchParams.get("shipment_id") || undefined;

    // Validate enum filters when supplied.
    if (document_type && !isValidDocumentType(document_type)) {
      return NextResponse.json({ error: "Invalid document_type." }, { status: 400 });
    }
    if (status && !isValidDocumentStatus(status)) {
      return NextResponse.json({ error: "Invalid status." }, { status: 400 });
    }

    const result = await listDocuments(access.tenant_id, access.partner_id, {
      post_id: post_id || undefined,
      negotiation_id: negotiation_id || undefined,
      shipment_id: shipment_id || undefined,
      document_type: document_type as any,
      status: status as any,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return NextResponse.json(result);
  } catch (e: any) {
    console.error("[marketplace.documents.list]", e);
    return NextResponse.json({ error: "Failed to load documents." }, { status: 500 });
  }
}

// POST /api/marketplace/documents — create a new trade document (manual
// data). tenant_id + partner_id are stamped from the auth context — never
// trust a body-supplied partner_id. The auto-generate route is the
// preferred way to create docs from deal context; this route is for
// manual entry (operator fills the JSONB by hand).
async function _post(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body?.document_type || !isValidDocumentType(body.document_type)) {
    return NextResponse.json({ error: "Invalid document_type." }, { status: 400 });
  }
  if (body.status && !isValidDocumentStatus(body.status)) {
    return NextResponse.json({ error: "Invalid status." }, { status: 400 });
  }
  if (body.document_data && (typeof body.document_data !== "object" || Array.isArray(body.document_data))) {
    return NextResponse.json({ error: "document_data must be an object." }, { status: 400 });
  }
  // Reference-number length cap (UI affordance — the doc-number generator
  // emits 16-char strings; allow up to 64 for manual entry).
  if (typeof body.reference_number === "string" && body.reference_number.length > 64) {
    return NextResponse.json({ error: "reference_number is too long (max 64 chars)." }, { status: 400 });
  }

  try {
    const created = await createDocument(access.tenant_id, access.partner_id, {
      document_type: body.document_type,
      status: body.status,
      document_data: body.document_data ?? {},
      post_id: body.post_id,
      negotiation_id: body.negotiation_id,
      shipment_id: body.shipment_id,
      reference_number: body.reference_number,
      generated_pdf_url: body.generated_pdf_url,
    });
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.document_created",
        "marketplace_trade_documents",
        created.id,
        { document_type: created.document_type, reference_number: created.reference_number },
      );
    } catch (e) {
      console.error("[marketplace.documents.create] audit failed:", e);
    }
    return NextResponse.json(created, { status: 201 });
  } catch (e: any) {
    console.error("[marketplace.documents.create]", e);
    const msg = e?.message || "Failed to create document.";
    const status = /not found/i.test(msg) ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/documents");
export const POST = withApm(_post, "POST /api/marketplace/documents");
