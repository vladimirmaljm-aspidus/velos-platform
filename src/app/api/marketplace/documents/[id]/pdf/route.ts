import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import {
  getDocument,
  updateDocument,
} from "@/lib/data/marketplace-trade-documents-store";
import { renderTradeDocumentPDF } from "@/lib/marketplace/document-pdf";
import { getStore } from "@/lib/data/store";
import { audit, getIp } from "@/lib/api/helpers";
import { safeFilename } from "@/lib/security/safe-filename";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/documents/[id]/pdf — render and stream the PDF for
// a trade document. The PDF is generated on demand from the stored
// `document_data` JSONB; the generated_pdf_url column on the row is NOT
// used as the source — we always re-render so a stored row whose PDF
// URL is stale (e.g. host changed) still produces a valid download.
//
// Auth: same per-participant check as GET /api/marketplace/documents/[id]
// — the caller must be the issuer OR a participant in the linked
// marketplace entity. Non-issuers get a sanitised filename (no partner_id
// in the filename) so a download doesn't leak the issuer's internal id.
async function _get(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // 9a-N3: per-IP rate limit — marketplace PDF rendering is also CPU-heavy
  // (renderTradeDocumentPDF + JSON canonicalisation + SHA-256 fingerprint).
  // 30 renders per IP per minute aligns with portal interactive patterns.
  const _rl = await checkRateLimit(`mkt-pdf:ip:${getIp(req)}`, 30, 60_000);
  if (!_rl.allowed) {
    return NextResponse.json(
      { error: "Too many PDF requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(Math.ceil((_rl.retryAfter ?? 60_000) / 1000)) } },
    );
  }
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

    // Per-participant auth check (mirror of GET /documents/[id]).
    const isIssuer = doc.partner_id === access.partner_id;
    if (!isIssuer) {
      const authorised = await isParticipantInLinkedEntity(doc, access.partner_id);
      if (!authorised) {
        return NextResponse.json({ error: "Not found." }, { status: 404 });
      }
    }

    // Resolve the issuer's tenant name (for the letterhead).
    let issuerName = "VELOS Marketplace";
    try {
      const store = await getStore();
      const tenant = await store.getTenant(access.tenant_id);
      if (tenant?.name) issuerName = tenant.name;
    } catch (e) {
      console.warn("[m[marketplace.documents.pdf] tenant lookup failed:", e);
    }

    // Render the PDF.
    let buffer: Buffer;
    try {
      buffer = await renderTradeDocumentPDF(
        doc.document_type,
        doc.document_data as Record<string, any>,
        { issuerName },
      );
    } catch (e: any) {
      console.error("[m[marketplace.documents.pdf] render failed:", e);
      return NextResponse.json(
        { error: "Failed to render PDF: " + (e?.message || "unknown error") },
        { status: 500 },
      );
    }

    // Persist the generated_pdf_url hint (best-effort) — a marker that
    // the PDF has been rendered at least once so the UI can show a
    // "Generated" badge without an extra round-trip. We don't actually
    // have a hosting URL (the PDF is streamed live), so we store a
    // sentinel `inline:pdf` value to mark "rendered".
    if (isIssuer && !doc.generated_pdf_url) {
      try {
        await updateDocument(id, access.tenant_id, access.partner_id, {
          generated_pdf_url: "inline:pdf",
        });
      } catch (e) {
        console.warn("[m[marketplace.documents.pdf] generated_pdf_url update failed:", e);
      }
    }

    // Audit the download.
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.document_pdf_downloaded",
        "marketplace_trade_documents",
        doc.id,
        { document_type: doc.document_type, reference_number: doc.reference_number },
      );
    } catch (e) {
      console.error("[m[marketplace.documents.pdf] audit failed:", e);
    }

    // 9a-N2: use shared safeFilename — strips CRLF / quotes / control chars.
    // reference_number is partner-editable via PUT /api/marketplace/documents/[id],
    // so it can carry header-injection chars. Inline .replace(/[^a-zA-Z0-9_-]/g, "_")
    // did NOT strip CRLF/quote/control chars (only non-alphanumerics).
    const safeRef = safeFilename(doc.reference_number, doc.id).replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `${doc.document_type}_${safeRef}.pdf`;

    // Convert the Node.js Buffer to a Uint8Array view — NextResponse's
    // BodyInit type accepts Uint8Array but not Buffer directly (the
    // underlying Buffer subclass of Uint8Array trips up TS' overload
    // resolution in Next 15's stricter dom typing).
    const body = new Uint8Array(buffer);

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(buffer.length),
        "Cache-Control": "private, max-age=0, must-revalidate",
      },
    });
  } catch (e: any) {
    console.error("[m[marketplace.documents.pdf]", e);
    return NextResponse.json({ error: "Failed to generate PDF." }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/documents/[id]/pdf");

// ─── Participant check (duplicated from GET /documents/[id]) ───────────────
//
// Duplicated rather than extracted into a shared helper to keep this
// route self-contained (the GET /documents/[id] route has its own copy
// too). A shared helper would require a new module that both routes
// import; the duplication cost is small (two FK lookups) and the
// readability win is real (each route is self-contained).

async function isParticipantInLinkedEntity(
  doc: { post_id: string | null; negotiation_id: string | null; shipment_id: string | null },
  partnerId: string,
): Promise<boolean> {
  // Lazy import so we don't pay the cost on every PDF render when the
  // caller IS the issuer (the common case).
  const { getSupabase } = await import("@/lib/supabase/client");
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
