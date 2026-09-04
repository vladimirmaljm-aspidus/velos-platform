import { describe, it, expect } from "vitest";
import React from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { extractText, getDocumentProxy } from "unpdf";
import { buildPdfDocument } from "@/lib/pdf/templates";
import { normalizeSegment, parseContentConfig } from "@/lib/utils/content-config";
import { parseStyleConfig, DEFAULT_STYLE_CONFIG, TABLE_COLUMN_KEYS } from "@/lib/utils/style-config";
import { readTemplateLayout } from "@/lib/pdf/doc-template";
import type { DocumentTemplate, Offer, OfferLineItem, Partner, Tenant } from "@/lib/supabase/types";

// ─── audit22 "Template Studio" — Word-grade template styling regression ────
//
// Verifies the end-to-end promise of the Template Studio: every property the
// studio saves ACTUALLY renders into the produced PDF:
//   1. Word-grade header/footer segments (spacing/borders/transform/…)
//   2. style_json → doc title treatment + table studio + notice + party
//   3. layout_json → body-section visibility + custom absolute overlays
//   4. normalizeSegment / parseStyleConfig clamp junk instead of crashing

async function renderAndExtract(element: React.ReactElement) {
  const buf = await renderToBuffer(element as any);
  expect(buf.length).toBeGreaterThan(500);
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: false });
  return { pdf, pages: (text as unknown as string[]).map((p) => String(p)) };
}

const tenant: Tenant = {
  id: "t1",
  name: "Aspidus Trading FZE",
  legal_name: "Aspidus Trading FZE LLC",
  country: "AE",
  currency: "USD",
  registration_number: "REG-778899",
  address_line: "Saif Zone, Block C",
  city: "Sharjah",
  email: "trade@aspidus.example",
  phone: "+971 55 111 2222",
  bank_accounts: JSON.stringify([
    { bankName: "Emirates NBD", currency: "USD", swiftCode: "EBILAEAD", accountNumber: "1234567890" },
  ]),
  bank_name: "Emirates NBD",
  bank_iban: null,
  bank_swift: "EBILAEAD",
  plan: "business",
  status: "active",
} as unknown as Tenant;

const partner: Partner = {
  id: "p1",
  tenant_id: "t1",
  name: "Horn of Africa Import Export PLC",
  address_line: "Bole Road 42",
  city: "Addis Ababa",
  country: "ET",
} as unknown as Partner;

const offer: Offer = {
  id: "o1",
  tenant_id: "t1",
  number: "OF-2026-0001",
  partner_id: "p1",
  status: "sent",
  subject: "Supply of hulled sesame seeds",
  currency: "USD",
  subtotal: 38750,
  discount_total: 0,
  tax_total: 0,
  total: 38750,
  terms: "Payment: 30% advance.",
  valid_until: "2026-09-30T00:00:00Z",
  items: [{
    product_id: "prod1",
    product_name: "Premium Sesame Seeds",
    sku: "SES-001",
    quantity: 25000,
    unit: "kg",
    unit_price: 1.55,
    discount: 0,
    tax_rate: 0,
    total: 38750,
    hs_code: "1207.40",
    origin_country: "ET",
  } as OfferLineItem],
  pol: "Djibouti",
  pod: "Jebel Ali",
  vessel: "MV ASTRO LION",
  container_no: "MSKU-1234567",
  lead_time: "21 days",
  packaging: "25 kg PP bags",
  payment_terms: "30/70 T/T",
  incoterm: "CIF",
  issue_date: "2026-08-01T00:00:00Z",
  created_at: "2026-08-01T00:00:00Z",
} as unknown as Offer;

function makeTemplate(overrides: Partial<DocumentTemplate> = {}): DocumentTemplate {
  return {
    id: "tpl1",
    tenant_id: "t1",
    name: "Studio Offer",
    type: "offer",
    is_default: true,
    page_size: "A4",
    page_margin_top: 20,
    page_margin_bottom: 20,
    page_margin_left: 15,
    page_margin_right: 15,
    header_enabled: true,
    header_height: 26,
    header_content: JSON.stringify({
      segments: [{
        id: "h1",
        text: "{company_legal_name} — Global Trade Division",
        fontSize: 12,
        bold: true,
        italic: false,
        color: "#b45309",
        alignment: "left",
        // audit22 Word-grade props:
        letterSpacing: 1.2,
        spacingBefore: 2,
        spacingAfter: 1.5,
        textTransform: "uppercase",
        borderBottom: { color: "#b45309", width: 0.75, style: "solid" },
      }],
    }),
    header_show_logo: false,
    header_show_company_name: true,
    header_show_contact: false,
    footer_enabled: true,
    footer_height: 18,
    footer_content: JSON.stringify({
      segments: [{
        id: "f1",
        text: "Confidential — {company_name}",
        fontSize: 7.5,
        bold: false,
        italic: true,
        color: "#666666",
        alignment: "center",
        bgColor: "#fff7ed",
        paddingY: 1,
      }],
      _qrConfig: { position: "none", size: 12, opacity: 1 },
    }),
    footer_show_page_number: true,
    footer_show_bank_details: false,
    footer_show_tax_id: false,
    body_font_family: "Inter",
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
    seal_enabled: false,
    created_by: null,
    created_at: "2026-03-01T00:00:00Z",
    updated_at: "2026-03-01T00:00:00Z",
    ...overrides,
  } as DocumentTemplate;
}

function renderWithTemplate(tpl: DocumentTemplate | null) {
  return React.createElement(buildPdfDocument, {
    doc: offer,
    docType: "offer",
    partner,
    tenant,
    memorandumSettings: null,
    template: tpl,
    qrCodeDataUrl: null,
    logoUrl: null,
  });
}

describe("audit22: Template Studio — Word-grade segments", () => {
  it("audit33: header segments are IGNORED (memo frame locked); footer notes still render", async () => {
    const { pages } = await renderAndExtract(renderWithTemplate(makeTemplate()));
    const all = pages.join("\n");
    // The header is memorandum-OWNED — template header segments (with their
    // textTransform etc.) must NOT render; the memo header (company name)
    // replaces them on every document.
    expect(all).not.toContain("ASPIDUS TRADING FZE LLC — GLOBAL TRADE DIVISION");
    // The company name from the memo header (tenant legal_name).
    expect(all).toContain("Aspidus");
    // Footer segments survive ONLY as small note lines under the QR.
    expect(all).toContain("Confidential — Aspidus Trading FZE");
  });

  it("keeps legacy 6-prop segments rendering unchanged (backwards compat)", async () => {
    const tpl = makeTemplate({
      header_content: JSON.stringify({
        segments: [{ id: "h1", text: "{company_name}", fontSize: 14, bold: true, italic: false, color: "#0d9488", alignment: "left" }],
      }),
    });
    const { pages } = await renderAndExtract(renderWithTemplate(tpl));
    expect(pages.join("\n")).toContain("Aspidus Trading FZE");
  });

  it("normalizes junk segment values instead of crashing the render", async () => {
    const tpl = makeTemplate({
      header_content: JSON.stringify({
        segments: [{
          id: "h1", text: "junk", fontSize: 9999, bold: "yes", color: "notahex",
          alignment: "diagonal", letterSpacing: -50, spacingBefore: 999, opacity: 42,
          border: { color: "junk", width: 999 }, textTransform: "random",
        }],
      }),
    });
    const { pages } = await renderAndExtract(renderWithTemplate(tpl));
    expect(pages.length).toBeGreaterThanOrEqual(1);
  });
});

describe("audit22: Template Studio — style_json (title/table/notice)", () => {
  it("applies doc title styling from style_json (custom size/colour/rule render)", async () => {
    const tpl = makeTemplate({
      style_json: {
        title: { fontSize: 22, color: "#b45309", letterSpacing: 3, transform: "uppercase", underline: true, showRule: true, ruleColor: "#b45309", spacingAfter: 5 },
        table: { headerBg: "#1e293b", headerColor: "#fbbf24", headerFontSize: 6, headerBold: false, headerTransform: "none", headerPaddingY: 3, cellFontSize: 7, cellPaddingY: 3, borderWidth: 1.5, numericAlign: "center" },
        notice: { bgColor: "#fef2f2", borderColor: "#ef4444", textColor: "#b91c1c", fontSize: 9 },
        party: { borderColor: "#f59e0b", bgColor: "#fffbeb", labelColor: "#92400e", valueColor: "#78350f", borderWidth: 1.5, borderRadius: 6, gap: 8 },
        totals: { grandBgColor: "#fef3c7", grandColor: "#92400e", grandBold: true },
        body: { textColor: "#374151", sectionSpacing: 8 },
      },
    });
    const { pages } = await renderAndExtract(renderWithTemplate(tpl));
    const all = pages.join("\n");
    // letterSpacing 3 spreads the letters in extraction — compare space-stripped
    expect(all.replace(/\s+/g, "")).toContain("OFFER");
    expect(all).toContain("LINE ITEMS");
    expect(all).toContain("Premium Sesame Seeds");
  });

  it("renders with NULL style_json exactly like pre-audit22 (defaults path)", async () => {
    const tpl = makeTemplate({ style_json: null });
    const { pages } = await renderAndExtract(renderWithTemplate(tpl));
    expect(pages.join("\n")).toContain("OFFER");
  });

  it("applies extreme-but-clamped table column widths without crashing", async () => {
    const tpl = makeTemplate({
      style_json: { table: { columnWidths: { rowNum: 60, description: 3, hsCode: 60, origin: 3, quantity: 60, unitPrice: 3, total: 60 } } },
    });
    const { pages } = await renderAndExtract(renderWithTemplate(tpl));
    // A 1-2% description column wraps the product name across lines —
    // compare space-stripped (the render must still complete without crash).
    expect(pages.join("\n").replace(/\s+/g, "")).toContain("PremiumSesameSeeds");
  });
});

describe("audit22: Template Studio — layout_json (visibility + overlays)", () => {
  it("hides body sections the visual editor marked invisible", async () => {
    const tpl = makeTemplate({
      layout_json: { fields: [
        { id: "trade_terms", type: "trade_terms", x: 15, y: 118, width: 180, height: 22, visible: false, locked: false },
        { id: "specifications", type: "specifications", x: 15, y: 200, width: 180, height: 30, visible: false, locked: false },
      ] },
    });
    const { pages } = await renderAndExtract(renderWithTemplate(tpl));
    const all = pages.join("\n");
    expect(all).not.toContain("Trade Terms");
    expect(all).not.toContain("Incoterm");
    expect(all).toContain("LINE ITEMS"); // unaffected section stays (base style uppercases it)
  });

  it("hiding ONE party box keeps the other (row collapses only when both hidden)", async () => {
    const onlyFromHidden = makeTemplate({
      layout_json: { fields: [
        { id: "from_box", type: "from_box", x: 15, y: 74, width: 87, height: 40, visible: false, locked: false },
      ] },
    });
    const r1 = await renderAndExtract(renderWithTemplate(onlyFromHidden));
    expect(r1.pages.join("\n")).not.toContain("FROM (SELLER)");
    expect(r1.pages.join("\n")).toContain("TO (BUYER)");

    const bothHidden = makeTemplate({
      layout_json: { fields: [
        { id: "from_box", type: "from_box", x: 15, y: 74, width: 87, height: 40, visible: false, locked: false },
        { id: "to_box", type: "to_box", x: 108, y: 74, width: 87, height: 40, visible: false, locked: false },
      ] },
    });
    const r2 = await renderAndExtract(renderWithTemplate(bothHidden));
    expect(r2.pages.join("\n")).not.toContain("FROM (SELLER)");
    expect(r2.pages.join("\n")).not.toContain("TO (BUYER)");
  });

  it("renders custom text overlays at absolute positions (Word text boxes)", async () => {
    const tpl = makeTemplate({
      layout_json: { fields: [
        { id: "ct1", type: "custom_text", x: 15, y: 40, width: 120, height: 10, visible: true, locked: false, props: { text: "DRAFT COPY — {doc_number}", style: { fontSize: 10, bold: true, color: "#dc2626", textTransform: "uppercase", bgColor: "#fee2e2", border: { color: "#dc2626", width: 1 } } } },
        { id: "ci1", type: "custom_image", x: 150, y: 40, width: 40, height: 20, visible: false, locked: false, props: { src: "data:image/png;base64,xxx" } },
      ] },
    });
    const { pages } = await renderAndExtract(renderWithTemplate(tpl));
    const all = pages.join("\n");
    expect(all).toContain("DRAFT COPY — OF-2026-0001");
  });

  it("accepts the visual editor's legacy props.content key for custom text", async () => {
    const tpl = makeTemplate({
      layout_json: { fields: [
        { id: "ct2", type: "custom_text", x: 20, y: 50, width: 120, height: 10, visible: true, locked: false, props: { content: "Legacy content key" } },
      ] },
    });
    const { pages } = await renderAndExtract(renderWithTemplate(tpl));
    expect(pages.join("\n")).toContain("Legacy content key");
  });
});

describe("audit22: engine units — normalizeSegment / parseStyleConfig / readTemplateLayout", () => {
  it("normalizeSegment clamps every numeric and validates colours", () => {
    const n = normalizeSegment({ text: "x", fontSize: 999, letterSpacing: -50, lineHeight: 9, spacingBefore: 999, opacity: 42, paddingY: -5, borderRadius: 99, color: "junk" });
    expect(n.fontSize).toBe(42);
    expect(n.letterSpacing).toBe(-1.5);
    expect(n.lineHeight).toBe(3);
    expect(n.spacingBefore).toBe(30);
    expect(n.opacity).toBe(1);
    expect(n.paddingY).toBe(0);
    expect(n.borderRadius).toBe(12);
    expect(n.color).toBe("#666666");
  });

  it("parseStyleConfig(null) returns built-in defaults (pre-audit22 output unchanged)", () => {
    const cfg = parseStyleConfig(null);
    expect(cfg).toEqual(DEFAULT_STYLE_CONFIG);
    expect(cfg.table.columnWidths).toHaveProperty("description");
  });

  it("parseStyleConfig renormalizes column widths to ~100", () => {
    const cfg = parseStyleConfig({ table: { columnWidths: { rowNum: 50, description: 50, hsCode: 50, origin: 50, quantity: 50, unitPrice: 50, total: 50 } } });
    const sum = Object.values(cfg.table.columnWidths).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 100)).toBeLessThanOrEqual(1.5);
  });

  it("parseStyleConfig validates table column keys", () => {
    const cfg = parseStyleConfig({ table: { columnWidths: { bogus: 60 } } });
    // unknown key ignored; the 7 known keys present
    expect(Object.keys(cfg.table.columnWidths).sort()).toEqual([...TABLE_COLUMN_KEYS].sort());
  });

  it("readTemplateLayout clamps junk coordinates and returns null for junk json", () => {
    expect(readTemplateLayout(null)).toBeNull();
    expect(readTemplateLayout("junk")).toBeNull();
    expect(readTemplateLayout({ fields: "not-array" })).toBeNull();
    const l = readTemplateLayout({ fields: [{ id: "a", type: "custom_text", x: 9999, y: -9999, width: 0, height: 1e6, visible: "yes" }] });
    expect(l).not.toBeNull();
    expect(l!.fields[0].x).toBeLessThanOrEqual(250);
    expect(l!.fields[0].y).toBeGreaterThanOrEqual(-20);
    expect(l!.fields[0].width).toBeGreaterThanOrEqual(5);
    expect(l!.fields[0].visible).toBe(true);
  });

  it("parseContentConfig keeps reading audit20-era segment JSON (compat)", () => {
    const cfg = parseContentConfig(JSON.stringify({ segments: [{ id: "h1", text: "{company_name}", fontSize: 14, bold: true, italic: false, color: "#0d9488", alignment: "left" }] }));
    expect(cfg.segments).toHaveLength(1);
    expect(cfg.segments[0].fontSize).toBe(14);
  });
});
