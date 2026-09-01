import { describe, it, expect } from "vitest";
import React from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { getDocumentProxy } from "unpdf";
import { buildPdfDocument } from "@/lib/pdf/templates";
import type { Offer, Partner, Tenant, DocumentTemplate } from "@/lib/supabase/types";

// ─────────────────────────────────────────────────────────────────────────────
// audit20 / 20-a — DocumentTemplate ↔ PDF wiring regression tests.
//
// Until audit20 the document_templates table was a write-only subsystem:
// the template editor saved page size, margins, header/footer segments,
// table styling, QR placement and bank-account selection — and NOTHING
// read them back. These tests pin the now-live wiring:
//
//   1. header/footer SEGMENTS render with {placeholder} substitution
//   2. {page_number}/{total_pages} in segments resolve PER PAGE
//   3. selected_bank_accounts filters the bank accounts shown
//   4. page_size "Letter" changes the physical page dimensions
//   5. Cyrillic partner names render + extract correctly (NotoSans fonts)
//   6. seal_enabled=false suppresses the seal even when a seal is passed
//   7. footer_show_bank_details / footer_show_tax_id append compact lines
//      INSIDE the pinned footer band
//   8. template-less renders (memo fallback) are unchanged
// ─────────────────────────────────────────────────────────────────────────────

interface TextItem {
  str: string;
  x: number;
  y: number; // distance from bottom edge (baseline)
}

async function renderPdf(element: React.ReactElement) {
  const buf = await renderToBuffer(element as any);
  expect(buf.length).toBeGreaterThan(500);
  return { buf, pdf: await getDocumentProxy(new Uint8Array(buf)) };
}

async function pageItems(pdf: any, pageNum: number): Promise<{ items: TextItem[]; width: number; height: number }> {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items: TextItem[] = (content.items as any[])
    .filter((it) => typeof it.str === "string" && it.str.trim().length > 0)
    .map((it) => ({ str: it.str as string, x: (it.transform as number[])[4], y: (it.transform as number[])[5] }));
  return { items, width: viewport.width as number, height: viewport.height as number };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const tenant: Tenant = {
  id: "t1",
  name: "ASPIDUS DMCC",
  legal_name: "ASPIDUS DMCC",
  country: "AE",
  city: "Dubai",
  currency: "USD",
  tax_id: "AE100200300",
  vat_number: null,
  registration_number: "DMCC-889293",
  address_line: "GoldCrest Executive Tower, JLT Cluster C, Dubai",
  email: "desk@aspidus.co",
  phone: "+971 4 000 0000",
  website: "www.aspidus.co",
  // Three accounts — the template selects only index 1 (Mashreq).
  bank_accounts: JSON.stringify([
    { bankName: "Emirates NBD", currency: "USD", swiftCode: "EBILAEAD", accountNumber: "EA11 0000 0000 1111" },
    { bankName: "Mashreq Bank", currency: "USD", swiftCode: "BOMLAEAD", accountNumber: "MB22 0000 0000 2222" },
    { bankName: "ADIB", currency: "USD", swiftCode: "ADIBAEAA", accountNumber: "AD33 0000 0000 3333" },
  ]),
  bank_name: null,
  bank_iban: null,
  bank_swift: null,
  logo_url: null,
  plan: "business",
  status: "active",
} as unknown as Tenant;

const partner: Partner = {
  id: "p1",
  tenant_id: tenant.id,
  // Cyrillic + Serbian-Latin glyphs — impossible with the WinAnsi built-ins.
  name: "ООО Велос Трейдинг",
  tax_id: "VELOTR123",
  address_line: "Ленинградский проспект 12, Москва",
  city: "Москва",
  country: "RU",
  email: "info@velos-trade.ru",
  phone: null,
  website: null,
} as unknown as Partner;

const manyItems = Array.from({ length: 26 }, (_, i) => ({
  id: `li-${i}`,
  product_name: `Premium Hulled Sesame Seeds, Crop 2026, Lot ${i + 1} — food grade, machine cleaned`,
  sku: `SES-2026-${String(i + 1).padStart(3, "0")}`,
  brand: null,
  quantity: 2500,
  unit: "kg",
  unit_price: 1.55,
  total: 3875,
  hs_code: "1207.40",
  origin_country: "ET",
  packaging: "25kg pp bags",
  specifications: { moisture: "max 6%", purity: "min 99.95%" },
  detailed_spec: null,
}));

const offer: Offer = {
  id: "of1",
  tenant_id: tenant.id,
  number: "OF-2026-0014",
  partner_id: partner.id,
  subject: "Hulled sesame seeds — CFR offer",
  status: "issued",
  currency: "USD",
  incoterm: "CFR",
  pol: "Djibouti",
  pod: "Jebel Ali",
  payment_terms: "30/70 T/T",
  lead_time: "21 days",
  items: manyItems as any,
  subtotal: 101125,
  tax_total: 0,
  total: 101125,
  valid_until: "2026-04-14",
  issue_date: "2026-03-14",
  created_at: "2026-03-14T00:00:00Z",
} as unknown as Offer;

const HEADER_SEGMENTS = JSON.stringify({
  segments: [
    { id: "h1", text: "{company_legal_name}", fontSize: 13, bold: true, italic: false, color: "#0f766e", alignment: "left" },
    { id: "h2", text: "{company_address}", fontSize: 8, bold: false, italic: false, color: "#666666", alignment: "left" },
  ],
});

const FOOTER_SEGMENTS = JSON.stringify({
  segments: [
    { id: "f1", text: "{company_name} · Reg#: {company_reg}", fontSize: 7.5, bold: false, italic: false, color: "#666666", alignment: "left" },
    { id: "f2", text: "Page {page_number} of {total_pages}", fontSize: 7.5, bold: false, italic: false, color: "#666666", alignment: "right" },
  ],
  _qrConfig: { position: "footer-right", size: 12, opacity: 0.9 },
});

function makeTemplate(overrides: Partial<DocumentTemplate> = {}): DocumentTemplate {
  return {
    id: "tpl1",
    tenant_id: tenant.id,
    name: "Professional Offer",
    type: "offer",
    is_default: true,
    page_size: "A4",
    page_margin_top: 20,
    page_margin_bottom: 20,
    page_margin_left: 15,
    page_margin_right: 15,
    header_enabled: true,
    header_height: 26,
    header_content: HEADER_SEGMENTS,
    header_show_logo: true,
    header_show_company_name: true,
    header_show_contact: true,
    footer_enabled: true,
    footer_height: 20,
    footer_content: FOOTER_SEGMENTS,
    footer_show_page_number: true,
    footer_show_bank_details: true,
    footer_show_tax_id: true,
    body_font_family: "Inter, system-ui, sans-serif",
    body_font_size: 9,
    body_line_height: 1.4,
    primary_color: "#0d9488",
    accent_color: "#64748b",
    table_header_bg: "#0d9488",
    table_header_color: "#ffffff",
    table_border_color: "#e2e8f0",
    table_stripe: true,
    letterhead_id: null,
    seal_id: null,
    seal_enabled: true,
    selected_bank_accounts: [1],
    created_by: null,
    created_at: "2026-03-01T00:00:00Z",
    updated_at: "2026-03-01T00:00:00Z",
    ...overrides,
  } as DocumentTemplate;
}

// A 1×1 transparent PNG seal, as a data: URL.
const SEAL_PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const seal = {
  id: "seal1",
  tenant_id: tenant.id,
  name: "Company Seal",
  image_url: SEAL_PNG_1PX,
  image_width_mm: 30,
  image_height_mm: 30,
  position: "bottom-right",
  opacity: 0.85,
  rotation_deg: 0,
} as any;

function renderWithTemplate(tpl: DocumentTemplate | null, extra: Record<string, unknown> = {}) {
  return React.createElement(buildPdfDocument, {
    doc: offer,
    docType: "offer",
    partner,
    tenant,
    memorandumSettings: null,
    template: tpl,
    seal: tpl ? seal : null,
    sealImageUrl: tpl && tpl.seal_enabled !== false ? SEAL_PNG_1PX : null,
    ...extra,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("audit20: DocumentTemplate wiring — offer", () => {
  it("renders header/footer SEGMENTS with placeholders substituted", async () => {
    const { pdf } = await renderPdf(renderWithTemplate(makeTemplate()));
    const { items } = await pageItems(pdf, 1);
    const all = items.map((i) => i.str).join("\n");

    // Header segments — {company_legal_name} + {company_address} substituted
    expect(all).toContain("ASPIDUS DMCC");
    expect(all).toContain("GoldCrest Executive Tower, JLT Cluster C, Dubai");
    // Raw tokens must NOT leak into the render
    expect(all).not.toContain("{company_legal_name}");
    expect(all).not.toContain("{company_address}");
    expect(all).not.toContain("{company_name}");
    expect(all).not.toContain("{company_reg}");
  });

  it("resolves {page_number}/{total_pages} in footer segments PER PAGE", async () => {
    const { pdf } = await renderPdf(renderWithTemplate(makeTemplate()));
    expect(pdf.numPages).toBeGreaterThanOrEqual(2);
    const p1 = (await pageItems(pdf, 1)).items.map((i) => i.str).join(" ");
    const p2 = (await pageItems(pdf, 2)).items.map((i) => i.str).join(" ");
    expect(p1).toContain("Page 1 of");
    expect(p2).toContain("Page 2 of");
    expect(p1).not.toContain("Page 2 of");
    // The left footer segment substitutes too
    expect(p1).toContain("ASPIDUS DMCC · Reg#: DMCC-889293");
  });

  it("filters bank accounts by selected_bank_accounts (index 1 → Mashreq only)", async () => {
    const { pdf } = await renderPdf(renderWithTemplate(makeTemplate()));
    const { items } = await pageItems(pdf, 1);
    const all = items.map((i) => i.str).join("\n");
    // Selected account present…
    expect(all).toContain("Mashreq Bank");
    expect(all).toContain("MB22 0000 0000 2222");
    // …unselected accounts suppressed in the body AND the footer line
    expect(all).not.toContain("Emirates NBD");
    expect(all).not.toContain("EA11");
    expect(all).not.toContain("ADIB");
    expect(all).not.toContain("AD33");
  });

  it("footer bank/tax lines render inside the pinned footer band", async () => {
    const { pdf } = await renderPdf(renderWithTemplate(makeTemplate()));
    const { items, height } = await pageItems(pdf, 1);
    // footer band: bottom 20mm ≈ 57pt
    const band = items.filter((i) => i.y < 57);
    const bandText = band.map((i) => i.str).join("\n");
    expect(bandText).toContain("Mashreq Bank: MB22 0000 0000 2222 · SWIFT BOMLAEAD");
    expect(bandText).toContain("Tax ID: AE100200300");
    // no body text inside the band
    expect(band.some((i) => i.str.includes("Sesame Seeds"))).toBe(false);
    expect(height).toBeGreaterThan(0);
  });

  it("honours page_size Letter (612×792pt)", async () => {
    const { pdf } = await renderPdf(renderWithTemplate(makeTemplate({ page_size: "Letter" })));
    const { width, height } = await pageItems(pdf, 1);
    expect(Math.round(width)).toBe(612);
    expect(Math.round(height)).toBe(792);
  });

  it("renders Cyrillic partner names correctly (Unicode fonts)", async () => {
    const { pdf } = await renderPdf(renderWithTemplate(makeTemplate()));
    const { items } = await pageItems(pdf, 1);
    const all = items.map((i) => i.str).join("\n");
    // WinAnsi Helvetica produced mojibake for this exact string — with the
    // registered NotoSans subsets it must extract verbatim.
    expect(all).toContain("ООО Велос Трейдинг");
    expect(all).toContain("Москва");
  });

  it("seal_enabled=false suppresses the seal image", async () => {
    const on = await renderPdf(renderWithTemplate(makeTemplate()));
    const off = await renderPdf(renderWithTemplate(makeTemplate({ seal_enabled: false })));
    // The seal image (and its bytes) must be absent when disabled —
    // approximate via buffer size: a rendered image inflates the PDF.
    // Both PDFs otherwise render identically.
    expect(on.buf.length).toBeGreaterThan(off.buf.length);
    expect(off.pdf.numPages).toBe(on.pdf.numPages);
  });

  it("header_show_company_name=false + no segments renders an empty header band", async () => {
    const { pdf } = await renderPdf(renderWithTemplate(makeTemplate({
      header_content: "",
      header_show_company_name: false,
      header_show_contact: false,
    })));
    const { items } = await pageItems(pdf, 1);
    const headerBand = items.filter((i) => i.y > 780); // top 26mm ≈ 74pt of A4 (842pt)
    expect(headerBand.length).toBe(0);
    // …while the body still renders normally
    const all = items.map((i) => i.str).join("\n");
    expect(all).toContain("OFFER");
  });

  it("template-less render (memo fallback) keeps the classic layout", async () => {
    const { pdf } = await renderPdf(renderWithTemplate(null));
    const p1 = await pageItems(pdf, 1);
    expect(p1.items.some((i) => i.str.includes("ASPIDUS DMCC"))).toBe(true);
    expect(p1.items.some((i) => i.str.includes("OFFER"))).toBe(true);
    expect(p1.items.some((i) => /Page 1 of/.test(i.str))).toBe(true);
    // No template → bank list unfiltered — the Bank Details section lives
    // at the END of the document, so extract every page.
    const last = await pageItems(pdf, pdf.numPages);
    const lastText = last.items.map((i) => i.str).join("\n");
    expect(lastText).toContain("Emirates NBD");
    expect(lastText).toContain("ADIB");
    expect(lastText).not.toContain("Mashreq-only-exclusivity"); // sanity
  });

  it("skips the body notice when a footer segment carries the same legal text", async () => {
    // The proforma starter ships its customs disclaimer as footer_content —
    // audit20 dedup: the body noticeBox must not repeat it.
    const proformaFooter = JSON.stringify({
      segments: [
        { id: "f1", text: "This proforma invoice is issued for customs/bank purposes only and is not a tax invoice.", fontSize: 7.5, bold: false, italic: false, color: "#666666", alignment: "center" },
      ],
    });
    const doc = { ...offer, number: "PRO-2026-0001" } as any;
    const el = React.createElement(buildPdfDocument, {
      doc,
      docType: "proforma",
      partner,
      tenant,
      memorandumSettings: null,
      template: makeTemplate({ type: "proforma", footer_content: proformaFooter }),
    });
    const { pdf } = await renderPdf(el);
    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      pages.push((await pageItems(pdf, i)).items.map((x) => x.str).join("\n"));
    }
    const all = pages.join("\n");
    const occurrences = all.split("customs/bank purposes").length - 1;
    // Footer repeats per page; the BODY notice must be gone → occurrences
    // must equal the page count (footer only), not pages + 1.
    expect(occurrences).toBeLessThanOrEqual(pdf.numPages);
    expect(all).toContain("PROFORMA");
    expect(all).toContain("PRO-2026-0001");
  });

  it("footer qr_position none keeps the page number but drops the QR", async () => {
    const noQr = JSON.stringify({
      segments: [
        { id: "f1", text: "{company_name}", fontSize: 7.5, bold: false, italic: false, color: "#666666", alignment: "center" },
      ],
      _qrConfig: { position: "none", size: 15, opacity: 1 },
    });
    const withQr = makeTemplate();
    const withoutQr = makeTemplate({ footer_content: noQr });
    const a = await renderPdf(renderWithTemplate(withQr, { qrCodeDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" }));
    const b = await renderPdf(renderWithTemplate(withoutQr, { qrCodeDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" }));
    expect(a.buf.length).toBeGreaterThan(b.buf.length);
    const { items } = await pageItems(b.pdf, 1);
    expect(items.some((i) => /Page 1 of/.test(i.str))).toBe(true);
  });
});
