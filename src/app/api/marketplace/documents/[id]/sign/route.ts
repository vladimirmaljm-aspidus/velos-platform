import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getDocument, signDocument } from "@/lib/data/marketplace-trade-documents-store";
import { computeDocumentFingerprint } from "@/lib/marketplace/document-pdf";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { triggerWebhooks } from "@/lib/webhooks/deliver";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// POST /api/marketplace/documents/[id]/sign — apply a digital signature
// to a trade document. The signature is a SHA-256 over the canonicalised
// `document_data` JSONB + the signer's partner_id (so the same payload
// signed by two different partners produces two different signatures).
//
// Auth: the issuing partner only (the store filters by tenant_id +
// partner_id). The signer must be the issuer — a counterparty cannot
// sign a document they did not create; they sign their acceptance by
// issuing their own counter-document (e.g. a counter-invoice).
//
// SIGNED DOCUMENTS ARE IMMUTABLE: once signed, the document_data cannot
// be modified (the store refuses any PUT to a signed row). The signature
// + signed_at + signed_by columns are committed atomically.
async function _post(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;

  // Parse an optional body. The route accepts an empty body (the standard
  // path) OR { notes?: string } for an audit-trail annotation.
  let body: { notes?: string } = {};
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as { notes?: string };
    }
  } catch {
    // Empty body is fine.
  }

  try {
    // Fetch the doc to (a) verify it exists + belongs to caller's tenant
    // and (b) read the JSONB so we can compute the fingerprint. The
    // fingerprint is computed over the *current* document_data — if the
    // caller has already modified the data, the signature reflects that
    // latest version (signing is a "snapshot" of the doc as-is).
    const doc = await getDocument(id, access.tenant_id);
    if (!doc) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (doc.partner_id !== access.partner_id) {
      return NextResponse.json(
        { error: "Only the issuing partner can sign this document." },
        { status: 403 },
      );
    }
    if (doc.digital_signature) {
      // Already signed — idempotent return of the current state.
      return NextResponse.json({ document: doc, already_signed: true });
    }

    const signature = computeDocumentFingerprint(
      doc.document_data as Record<string, any>,
      access.partner_id,
    );

    const signed = await signDocument(id, access.tenant_id, access.partner_id, signature);
    if (!signed) {
      return NextResponse.json(
        { error: "Failed to sign document." },
        { status: 500 },
      );
    }

    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.document_signed",
        "marketplace_trade_documents",
        signed.id,
        {
          document_type: signed.document_type,
          reference_number: signed.reference_number,
          signature_prefix: signature.slice(0, 12),
          notes: body.notes ?? null,
        },
      );
      // Phase 12 — fire marketplace.document_signed webhook
      // (fire-and-forget). Receivers can use this to trigger downstream
      // flows: eBL hand-off to the carrier, customs filing of the
      // signed commercial invoice, payment-schedule activation, etc.
      void triggerWebhooks(store, access.tenant_id, "marketplace.document_signed", "marketplace_trade_document", signed.id, {
        document_id: signed.id,
        document_type: signed.document_type,
        reference_number: signed.reference_number,
        signed_by: access.partner_id,
        signed_at: signed.signed_at,
        signature_prefix: signature.slice(0, 12),
      }).catch(() => {});
    } catch (e) {
      console.error("[marketplace.documents.sign] audit failed:", e);
    }

    return NextResponse.json({ document: signed, already_signed: false });
  } catch (e: any) {
    console.error("[marketplace.documents.sign]", e);
    const msg = e?.message || "Failed to sign document.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export const POST = withApm(_post, "POST /api/marketplace/documents/[id]/sign");
