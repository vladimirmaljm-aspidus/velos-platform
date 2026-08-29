import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { generateQrCodeDataUrl, generateVerificationCode } from "@/lib/pdf/qr";

export const runtime = "nodejs";

function escapeHtml(str: string): string {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * GET /api/lois/[id]/pdf — render the LOI as a printable HTML page.
 * The user can print to PDF via the browser's native print dialog.
 * Returns Content-Type: text/html with a @media print stylesheet.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;
    const store = await getStore();
    const loi = await store.getLoi(id);
    if (!loi) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && loi.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    const partner = await store.getPartner(loi.partner_id);
    const tenant = await store.getTenant(loi.tenant_id);

    // ── QR code + verification record ─────────────────────────────────
    // Mirror the offers/invoices/proformas PDF pattern: generate a
    // verification code, create/update a document_verifications row, and
    // embed the QR code in the footer so the recipient can verify the LOI's
    // authenticity at /verify/{code}.
    let verificationCode: string | undefined;
    let qrCodeDataUrl: string | undefined;
    try {
      verificationCode = generateVerificationCode("loi", loi.number);
      qrCodeDataUrl = await generateQrCodeDataUrl(verificationCode);

      // Persist the verification record (idempotent — if one exists, reuse it).
      const sb = (await import("@/lib/supabase/client")).getSupabase();
      const { data: existing } = await sb
        .from("document_verifications")
        .select("id, verification_code")
        .eq("tenant_id", loi.tenant_id)
        .eq("document_type", "loi")
        .eq("document_id", loi.id)
        .maybeSingle();
      if (!existing) {
        await sb.from("document_verifications").insert({
          tenant_id: loi.tenant_id,
          document_type: "loi",
          document_id: loi.id,
          document_number: loi.number,
          verification_code: verificationCode,
          verified: false,
        });
      } else {
        verificationCode = existing.verification_code;
        qrCodeDataUrl = await generateQrCodeDataUrl(verificationCode || "");
      }
    } catch (e: any) {
      console.warn("[loi.pdf] verification/QR failed:", e?.message || e);
      // Non-fatal — the PDF still renders without the QR code.
    }

    // Audit the PDF download.
    try {
      await audit(store, auth.user, req, "loi.pdf_downloaded", "loi", id, {
        number: loi.number,
        verification_code: verificationCode,
      });
    } catch (e: any) {
      console.warn("[loi.pdf] audit failed:", e?.message || e);
    }

    const fmtMoney = (n: number, cur: string) =>
      new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(n || 0);
    const fmtDate = (d: string | null) =>
      d ? new Intl.DateTimeFormat("en-US", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(d)) : "—";

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LOI — ${escapeHtml(loi.number)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 40px; color: #1f2937; line-height: 1.5; }
  .loi-header { border-bottom: 3px solid #0f766e; padding-bottom: 16px; margin-bottom: 32px; display: flex; justify-content: space-between; align-items: flex-start; }
  .loi-header h1 { font-size: 22px; font-weight: 700; margin: 0; color: #0f766e; letter-spacing: 0.5px; }
  .loi-header .loi-number { font-size: 13px; color: #6b7280; margin-top: 4px; }
  .loi-header .loi-date { font-size: 13px; color: #6b7280; }
  .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 32px; }
  .party { padding: 16px; border: 1px solid #e5e7eb; border-radius: 8px; background: #f9fafb; }
  .party-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #6b7280; margin-bottom: 8px; font-weight: 600; }
  .party-name { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
  .party-detail { font-size: 12px; color: #4b5563; white-space: pre-wrap; }
  .subject-block { margin-bottom: 32px; }
  .subject-block h2 { font-size: 16px; font-weight: 600; margin: 0 0 8px; }
  .subject-block p { font-size: 14px; color: #374151; margin: 0; }
  .section { margin-bottom: 28px; }
  .section h3 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; color: #6b7280; margin: 0 0 12px; font-weight: 600; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; }
  .product-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .product-table td { padding: 10px 8px; border-bottom: 1px solid #f3f4f6; }
  .product-table td:first-child { color: #6b7280; width: 40%; }
  .product-table td:last-child { font-weight: 500; }
  .terms-text { font-size: 13px; color: #374151; white-space: pre-wrap; line-height: 1.6; }
  .notes { font-size: 12px; color: #6b7280; font-style: italic; margin-top: 12px; }
  .signatures { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 48px; padding-top: 32px; }
  .sig-block { text-align: center; }
  .sig-line { border-top: 1px solid #374151; margin-top: 48px; padding-top: 8px; font-size: 12px; color: #6b7280; }
  .sig-name { font-size: 13px; font-weight: 600; margin-bottom: 32px; }
  .footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 11px; color: #9ca3af; text-align: center; }
  @media print {
    @page { size: A4; margin: 2cm; }
    body { padding: 0; }
    .no-print { display: none !important; }
    .loi-header, .parties, .signatures, .footer { break-inside: avoid; }
    .section { break-inside: avoid; }
    .product-table { break-inside: avoid; }
  }
  .print-btn { position: fixed; top: 16px; right: 16px; background: #0f766e; color: white; border: none; padding: 10px 20px; border-radius: 6px; font-size: 13px; cursor: pointer; }
  .print-btn:hover { background: #0c5d56; }
</style>
</head>
<body>
  <button class="print-btn no-print" onclick="window.print()">Print / Save PDF</button>
  <div class="loi-header">
    <div>
      <h1>LETTER OF INTENT</h1>
      <div class="loi-number">${escapeHtml(loi.number)}</div>
    </div>
    <div style="text-align:right;">
      <div class="loi-date">Issued: ${fmtDate(loi.created_at)}</div>
      <div class="loi-date">Valid Until: ${fmtDate(loi.validity_until)}</div>
    </div>
  </div>

  <div class="parties">
    <div class="party">
      <div class="party-label">From (Buyer)</div>
      <div class="party-name">${escapeHtml(loi.buyer_name)}</div>
      <div class="party-detail">${escapeHtml(loi.buyer_address || "")}${loi.buyer_contact ? "\\n" + escapeHtml(loi.buyer_contact) : ""}</div>
    </div>
    <div class="party">
      <div class="party-label">To (Seller)</div>
      <div class="party-name">${escapeHtml(partner?.name || "")}</div>
      <div class="party-detail">${escapeHtml(tenant?.name || "")}</div>
    </div>
  </div>

  <div class="subject-block">
    <h2>Subject</h2>
    <p>${escapeHtml(loi.subject)}</p>
  </div>

  <div class="section">
    <h3>Product Details</h3>
    <table class="product-table">
      <tr><td>Product Name</td><td>${escapeHtml(loi.product_name)}</td></tr>
      ${loi.product_description ? `<tr><td>Description</td><td>${escapeHtml(loi.product_description)}</td></tr>` : ""}
      ${loi.hs_code ? `<tr><td>HS Code</td><td>${escapeHtml(loi.hs_code)}</td></tr>` : ""}
      ${loi.origin_country ? `<tr><td>Origin Country</td><td>${escapeHtml(loi.origin_country)}</td></tr>` : ""}
      <tr><td>Quantity</td><td>${loi.quantity} ${escapeHtml(loi.unit)}</td></tr>
      <tr><td>Unit Price</td><td>${fmtMoney(loi.unit_price, loi.currency)}</td></tr>
      <tr><td>Total Value</td><td><strong>${fmtMoney(loi.total_value, loi.currency)}</strong></td></tr>
    </table>
  </div>

  <div class="section">
    <h3>Delivery & Payment Terms</h3>
    <table class="product-table">
      <tr><td>Delivery Terms</td><td>${escapeHtml(loi.delivery_terms || "—")}</td></tr>
      <tr><td>Delivery Date</td><td>${fmtDate(loi.delivery_date)}</td></tr>
      <tr><td>Payment Terms</td><td>${escapeHtml(loi.payment_terms || "—")}</td></tr>
    </table>
  </div>

  ${loi.terms_text ? `<div class="section"><h3>Terms & Conditions</h3><div class="terms-text">${escapeHtml(loi.terms_text)}</div></div>` : ""}

  ${loi.notes ? `<div class="notes">Notes: ${escapeHtml(loi.notes)}</div>` : ""}

  <div class="signatures">
    <div class="sig-block">
      <div class="sig-name">${escapeHtml(loi.buyer_name)}</div>
      <div class="sig-line">Authorized Signature — Buyer</div>
    </div>
    <div class="sig-block">
      <div class="sig-name">${escapeHtml(partner?.name || "")}</div>
      <div class="sig-line">Authorized Signature — Seller</div>
    </div>
  </div>

  <div class="footer">
    ${qrCodeDataUrl ? `
      <div style="margin-bottom: 16px;">
        <img src="${qrCodeDataUrl}" alt="Verification QR Code" style="width: 100px; height: 100px; margin: 0 auto 8px; display: block;" />
        <div style="font-size: 10px; color: #6b7280;">Scan to verify: ${escapeHtml(verificationCode || "")}</div>
      </div>
    ` : ""}
    This Letter of Intent is a non-binding expression of intent to purchase. Generated by VELOS on ${new Date().toISOString().split("T")[0]}.
  </div>

  <script>
    // Auto-open print dialog on load
    window.addEventListener('load', function() {
      setTimeout(function() { window.print(); }, 500);
    });
  </script>
</body>
</html>`;

    const headers = new Headers();
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("Content-Disposition", `inline; filename="LOI-${loi.number}.html"`);
    return new NextResponse(html, { status: 200, headers });
  } catch (e: any) {
    console.error("[lois.pdf]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
