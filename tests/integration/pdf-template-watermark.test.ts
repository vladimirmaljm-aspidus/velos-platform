import { describe, it, expect } from "vitest";
import React from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { extractText, getDocumentProxy } from "unpdf";
import { buildPdfDocument } from "@/lib/pdf/templates";
import { parseStyleConfig, DEFAULT_STYLE_CONFIG } from "@/lib/utils/style-config";
import { resolveDocumentTemplate } from "@/lib/pdf/doc-template";
import { sanitizeTemplatePayload } from "@/lib/api/template-payload";
import type { DocumentTemplate, Offer, OfferLineItem, Partner, Tenant } from "@/lib/supabase/types";

// ─── audit23 — LOI template type + custom watermark + preview sanitizer ──────
//
// 1. resolveDocumentTemplate picks the dedicated "loi" template for LOI PDFs
//    (loi → generic → offer candidate order).
// 2. style_json.watermark renders as a rotated custom watermark that
//    REPLACES the automatic status watermark.
// 3. parseStyleConfig clamps junk watermark values.
// 4. sanitizeTemplatePayload (shared by save + preview routes) whitelists
//    columns, clamps numerics and drops junk.

async function renderAndExtract(element: React.ReactElement) {
  const buf = await renderToBuffer(element as any);
  expect(buf.length).toBeGreaterThan(500);
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: false });
  return { pages: (text as unknown as string[]).map((p) => String(p)) };
}

const tenant: Tenant = {
  id: "t1",
  name: "Aspidus Trading FZE",
  country: "AE",
  currency: "USD",
  bank_accounts: null,
  bank_name: "Emirates NBD",
  bank_iban: null,
  bank_swift: "EBILAEAD",
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
  // "draft" would normally stamp the automatic DRAFT watermark — the custom
  // watermark must replace it when enabled.
  status: "draft",
  subject: "Supply of hulled sesame seeds",
  currency: "USD",
  subtotal: 38750,
  discount_total: 0,
  tax_total: 0,
  total: 38750,
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
  issue_date: "2026-08-01T00:00:00Z",
  created_at: "2026-08-01T00:00:00Z",
} as unknown as Offer;

function makeTemplate(overrides: Partial<DocumentTemplate> = {}): DocumentTemplate {
  return {
    id: "tpl1",
    tenant_id: "t1",
    name: "Test Template",
    type: "offer",
    is_default: false,
    page_size: "A4",
    page_margin_top: 20,
    page_margin_bottom: 20,
    page_margin_left: 15,
    page_margin_right: 15,
    header_enabled: true,
    header_height: 24,
    header_content: "",
    header_show_logo: false,
    header_show_company_name: true,
    header_show_contact: false,
    footer_enabled: true,
    footer_height: 18,
    footer_content: "",
    footer_show_page_number: true,
    footer_show_bank_details: false,
    footer_show_tax_id: false,
    body_font_family: "Helvetica",
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

// ─── 1. Resolver: dedicated LOI type wins ────────────────────────────────────

describe("audit23: resolveDocumentTemplate — LOI candidate order", () => {
  const loiTpl = makeTemplate({ id: "loi-1", name: "LOI Template", type: "loi", is_default: true });
  const genericTpl = makeTemplate({ id: "gen-1", name: "Generic Template", type: "generic", is_default: true });
  const offerTpl = makeTemplate({ id: "off-1", name: "Offer Template", type: "offer", is_default: true });

  it("prefers the dedicated 'loi' template over generic/offer", async () => {
    const store = { listDocumentTemplates: async () => [offerTpl, genericTpl, loiTpl] };
    const picked = await resolveDocumentTemplate(store, "t1", "loi");
    expect(picked?.id).toBe("loi-1");
  });

  it("falls back to generic when no loi row exists", async () => {
    const store = { listDocumentTemplates: async () => [offerTpl, genericTpl] };
    const picked = await resolveDocumentTemplate(store, "t1", "loi");
    expect(picked?.id).toBe("gen-1");
  });

  it("falls back to offer when neither loi nor generic exist", async () => {
    const store = { listDocumentTemplates: async () => [offerTpl] };
    const picked = await resolveDocumentTemplate(store, "t1", "loi");
    expect(picked?.id).toBe("off-1");
  });

  it("picks the is_default loi row even when a newer non-default loi exists", async () => {
    const newerNonDefault = makeTemplate({ id: "loi-2", type: "loi", is_default: false, updated_at: "2027-01-01T00:00:00Z" });
    const store = { listDocumentTemplates: async () => [newerNonDefault, loiTpl] };
    const picked = await resolveDocumentTemplate(store, "t1", "loi");
    expect(picked?.id).toBe("loi-1");
  });

  it("never throws when the store rejects (broken table must not break PDFs)", async () => {
    const store = { listDocumentTemplates: async () => { throw new Error("db down"); } };
    const picked = await resolveDocumentTemplate(store, "t1", "loi");
    expect(picked).toBeNull();
  });
});

// ─── 2. Custom watermark render ──────────────────────────────────────────────

describe("audit23: custom watermark (style_json.watermark)", () => {
  it("renders the custom watermark text and REPLACES the status watermark", async () => {
    const tpl = makeTemplate({
      style_json: { watermark: { enabled: true, text: "CONFIDENTIAL", color: "#94a3b8", opacity: 0.12, rotation: -45, fontSize: 56 } },
    });
    const { pages } = await renderAndExtract(renderWithTemplate(tpl));
    const all = pages.join("\n");
    expect(all).toContain("CONFIDENTIAL");
    // status watermark (doc.status = draft) must NOT render alongside
    expect(all).not.toMatch(/\bDRAFT\b/);
  });

  it("keeps the automatic status watermark when the custom one is disabled", async () => {
    const tpl = makeTemplate({
      style_json: { watermark: { enabled: false, text: "CONFIDENTIAL", color: "#94a3b8", opacity: 0.12, rotation: -45, fontSize: 56 } },
    });
    const { pages } = await renderAndExtract(renderWithTemplate(tpl));
    expect(pages.join("\n")).toMatch(/\bDRAFT\b/);
  });

  it("renders rotated watermark without crashing (transform syntax accepted)", async () => {
    const tpl = makeTemplate({
      style_json: { watermark: { enabled: true, text: "POVERLJIVO", color: "#b91c1c", opacity: 0.2, rotation: -30, fontSize: 40 } },
    });
    const { pages } = await renderAndExtract(renderWithTemplate(tpl));
    expect(pages.join("\n")).toContain("POVERLJIVO");
  });
});

// ─── 3. parseStyleConfig watermark normalization ─────────────────────────────

describe("audit23: parseStyleConfig — watermark clamps", () => {
  it("defaults match DEFAULT_STYLE_CONFIG.watermark (backwards compat)", () => {
    const cfg = parseStyleConfig(null);
    expect(cfg.watermark).toEqual(DEFAULT_STYLE_CONFIG.watermark);
    expect(cfg.watermark.enabled).toBe(false);
  });

  it("clamps junk watermark values instead of crashing the render", () => {
    const cfg = parseStyleConfig({
      watermark: { enabled: "yes", text: 42, color: "notahex", opacity: 9, rotation: 400, fontSize: -5 },
    });
    // bool() only accepts real booleans — a truthy string degrades to the
    // default (disabled), same as every other junk value in the parser.
    expect(cfg.watermark.enabled).toBe(false);
    expect(cfg.watermark.text).toBe(DEFAULT_STYLE_CONFIG.watermark.text); // non-string → default
    expect(cfg.watermark.color).toBe(DEFAULT_STYLE_CONFIG.watermark.color);
    expect(cfg.watermark.opacity).toBeLessThanOrEqual(0.3);
    expect(cfg.watermark.rotation).toBeLessThanOrEqual(90);
    expect(cfg.watermark.fontSize).toBeGreaterThanOrEqual(20);
  });

  it("uppercases and clamps long watermark text", () => {
    const cfg = parseStyleConfig({ watermark: { text: "a".repeat(50) } });
    expect(cfg.watermark.text.length).toBeLessThanOrEqual(32);
  });
});

// ─── 4. Shared payload sanitizer (save + preview routes) ─────────────────────

describe("audit23: sanitizeTemplatePayload (save + preview parity)", () => {
  it("accepts a loi template type", () => {
    const { sanitized } = sanitizeTemplatePayload({ name: "X", type: "loi" });
    expect(sanitized.type).toBe("loi");
  });

  it("rejects an unknown template type", () => {
    expect(() => sanitizeTemplatePayload({ type: "newsletter" })).toThrow(/Invalid template type/);
  });

  it("drops unknown columns and meta keys", () => {
    const { sanitized, dropped } = sanitizeTemplatePayload({
      name: "X",
      id: "evil",
      tenant_id: "evil",
      created_by: "evil",
      hacked_column: "nope",
    });
    expect(sanitized.id).toBeUndefined();
    expect(sanitized.tenant_id).toBeUndefined();
    expect(dropped).toContain("hacked_column");
  });

  it("clamps numeric columns into their safe ranges", () => {
    const { sanitized } = sanitizeTemplatePayload({
      name: "X",
      page_margin_top: 999,
      body_font_size: 2,
      header_height: -50,
    });
    expect(sanitized.page_margin_top).toBe(60);
    expect(sanitized.body_font_size).toBe(6);
    expect(sanitized.header_height).toBe(0);
  });

  it("drops oversized style_json (preview payloads stay bounded)", () => {
    const big = { filler: "x".repeat(40000) };
    const { sanitized } = sanitizeTemplatePayload({ name: "X", style_json: big });
    expect(sanitized.style_json).toBeUndefined();
  });

  it("passes a well-formed watermark style_json through", () => {
    const styleJson = { watermark: { enabled: true, text: "CONFIDENTIAL", color: "#94a3b8", opacity: 0.12, rotation: -45, fontSize: 56 } };
    const { sanitized } = sanitizeTemplatePayload({ name: "X", style_json: styleJson });
    expect(sanitized.style_json).toEqual(styleJson);
  });
});
