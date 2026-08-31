import { describe, it, expect } from "vitest";
import React from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { extractText, getDocumentProxy } from "unpdf";
import { buildPdfDocument } from "@/lib/pdf/templates";
import type { LetterOfIntent, Partner, Tenant, MemorandumSettings } from "@/lib/supabase/types";

// audit13: REAL end-to-end regression tests for the PDF bugs the user
// reported from production ("memorandum gresi svaki put, dupliranje podataka
// i informacija u footeru"):
//
//   1. Address duplication — tenant address_line "…, Dubai, UAE" + city
//      "Dubai" + country "AE" used to render "…, Dubai, UAE, Dubai, United
//      Arab Emirates" in the footer AND the FROM/TO party boxes.
//   2. Page numbers with memorandum settings — the audit12 tests only ran
//      with memorandumSettings: null; production always has a settings row
//      (line height 1.4, Times-Roman header…). "Page X of Y" must survive.
//   3. Footer identifier — was "LETTER OF INTENT LOI-2026-000005 · 29 Aug
//      2026" (repeated the doc title AND wrapped to two lines). Now just
//      "LOI-2026-000005 · 29 Aug 2026".
//   4. Redundant LOI body header — "Letter of Intent" section header made
//      the title appear 3× per page. Removed.
//
// The fixtures below are EXACT copies of the live production data (tenant
// ASPIDUS DMCC, partner EDGE GROUP GLOBAL FZCO, LOI-2026-000005, and the
// tenant's real memorandum_settings row).

async function renderAndExtract(element: React.ReactElement) {
  const buf = await renderToBuffer(element as any);
  expect(buf.length).toBeGreaterThan(500);
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = (text as unknown as string[]).map((p) => String(p));
  return { all: pages.join("\n"), pages };
}

// ─── EXACT production data (read-only copies) ───────────────────────────────

const tenant: Tenant = {
  id: "c889572d-d35b-43ec-bca1-a5359d95603d",
  name: "ASPIDUS DMCC",
  legal_name: "ASPIDUS DMCC",
  country: "AE",
  currency: "USD",
  tax_id: null,
  vat_number: null,
  registration_number: "DMCC-889293",
  // ← the free-text line ALREADY ends with "Dubai, UAE" — this is what made
  // every footer/party box duplicate the city + country before audit13.
  address_line: "GoldCrest Executive Tower, 1002-A, JLT Cluster C, Dubai, UAE",
  city: "Dubai",
  postal_code: null,
  email: null,
  phone: null,
  website: "www.aspidus.co",
  bank_name: null,
  bank_accounts: null,
  bank_iban: null,
  bank_swift: null,
  logo_url: null,
  primary_color: null,
  plan: "business",
  status: "active",
} as unknown as Tenant;

const partner: Partner = {
  id: "p1",
  tenant_id: tenant.id,
  name: "EDGE GROUP GLOBAL FZCO",
  tax_id: "EDGGROGL",
  vat_number: null,
  registration_number: null,
  // "Dubai Silicon Oasis" contains the word "Dubai" — the city "Dubai" must
  // not be appended again; the country is NOT mentioned → "United Arab
  // Emirates" must be.
  address_line: "IFZA Business Park, Building A2, Dubai Silicon Oasis",
  city: "Dubai",
  postal_code: null,
  country: "AE",
  email: null,
  phone: null,
  website: null,
} as unknown as Partner;

const loi: LetterOfIntent = {
  id: "loi1",
  tenant_id: tenant.id,
  number: "LOI-2026-000005",
  partner_id: "p1",
  buyer_name: "ASPIDUS DMCC",
  subject: "Sugar Icumsa 45",
  product_name: "Refined Sugar ICUMSA 45",
  product_description: "Refined Sugar ICUMSA 45",
  hs_code: "1701991000",
  origin_country: "BR",
  quantity: 31000,
  unit: "MT",
  unit_price: 550,
  total_value: 17050000,
  currency: "USD",
  delivery_terms: "CIF Fujairah",
  delivery_date: "2026-09-13T00:00:00Z",
  payment_terms: "TBD",
  validity_until: "2026-09-04T00:00:00Z",
  issue_date: "2026-08-29T00:00:00Z",
  status: "draft",
  terms_text: null,
  notes: null,
  coa_params: null,
  specifications: null,
  created_at: "2026-08-29T00:00:00Z",
} as unknown as LetterOfIntent;

// EXACT memorandum_settings row of the production tenant (ASPIDUS DMCC).
const memoSettings = {
  header_enabled: true,
  header_height_mm: 23,
  header_bg_color: "#ffffff",
  header_left_font_family: "Times-Roman", // ← the font the UI saves
  header_left_font_size: 14,
  header_left_font_color: "#3457D5",
  header_left_font_bold: true,
  logo_enabled: true,
  logo_max_width_mm: 50,
  logo_max_height_mm: 20,
  logo_position_x_mm: 14,
  logo_position_y_mm: 0,
  logo_fit_mode: "contain",
  footer_enabled: true,
  footer_height_mm: 17,
  footer_bg_color: "#ffffff",
  qr_enabled: true,
  qr_size_mm: 10,
  qr_position_x_mm: -8,
  qr_position_y_mm: -1,
  footer_center_font_family: "Helvetica",
  footer_center_font_size: 7,
  footer_center_font_color: "#666666",
  footer_center_alignment: "center",
  footer_right_font_family: "Helvetica",
  footer_right_font_size: 8,
  footer_right_font_color: "#666666",
  footer_left_width_pct: 25,
  footer_center_width_pct: 50,
  footer_right_width_pct: 25,
  body_font_family: "Helvetica",
  body_font_size: 9,
  body_line_height: 1.4,
  body_text_color: "#000000",
  primary_color: "#3457D5",
} as unknown as MemorandumSettings;

function renderLoi(extra: Record<string, unknown> = {}) {
  return React.createElement(buildPdfDocument, {
    doc: loi,
    docType: "loi" as const,
    partner,
    tenant,
    memorandumSettings: memoSettings,
    verificationCode: "ASP-DC05-000-E6042C",
    qrCodeDataUrl: null,
    logoUrl: null,
    sealImageUrl: null,
    seal: null,
    ...extra,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("audit13 — production LOI regression (memorandum + footer)", () => {
  it("renders at all with the production settings (Times-Roman header etc.)", async () => {
    const { all } = await renderAndExtract(renderLoi());
    expect(all).toContain("LOI-2026-000005");
    expect(all).toContain("ASPIDUS DMCC");
  });

  it("footer + party boxes contain NO duplicated city/country", async () => {
    const { all } = await renderAndExtract(renderLoi());
    // The exact duplication the user saw:
    expect(all).not.toContain("Dubai, UAE, Dubai");
    expect(all).not.toContain("Dubai, United");
    // audit14: the footer no longer carries the tenant address at all — it
    // duplicated the FROM/TO party boxes on every page of a multi-page
    // document ("same information 6 times"). The deduped address now
    // renders EXACTLY ONCE, in the party box on page 1:
    const footerAddr = "GoldCrest Executive Tower, 1002-A, JLT Cluster C, Dubai, UAE";
    const occurrences = all.split(footerAddr).length - 1;
    expect(occurrences).toBe(1);
    // Partner box: city "Dubai" is inside "Dubai Silicon Oasis" → not
    // appended; country appended once:
    expect(all).toContain("IFZA Business Park, Building A2, Dubai Silicon Oasis");
    expect(all).toContain("United Arab Emirates");
  });

  it("page numbers render WITH memorandum settings (audit12 gap)", async () => {
    const { pages } = await renderAndExtract(renderLoi());
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pages[0]).toContain("Page 1 of");
    expect(pages[1]).toContain("Page 2 of");
    expect(pages[0]).toMatch(/Page 1 of \d+/);
    expect(pages[1]).toMatch(/Page 2 of \d+/);
  });

  it("footer carries NO duplicated document identifier (number/date live in the title meta)", async () => {
    const { all, pages } = await renderAndExtract(renderLoi());
    // The number + issue date render ONCE, in the title meta block
    // ("Document No.:" / "Date of Issue:") on page 1:
    expect(pages[0]).toContain("LOI-2026-000005");
    expect(pages[0]).toContain("29 Aug 2026");
    // audit14: the footer identifier line is GONE entirely — every page
    // used to repeat "LOI-2026-000005 · 29 Aug 2026" at the bottom:
    expect(all).not.toContain("LOI-2026-000005 · 29 Aug 2026");
    // …and page 2 carries NEITHER the number NOR the date (only its own
    // page number):
    expect(pages[1]).not.toContain("LOI-2026-000005");
    expect(pages[1]).not.toContain("29 Aug 2026");
    // The old footer repeated the title before the number:
    expect(all).not.toContain("LETTER OF INTENT LOI-2026-000005");
  });

  it("LOI title appears exactly ONCE as an uppercase heading (no 3× duplication)", async () => {
    const { pages } = await renderAndExtract(renderLoi());
    const page1 = pages[0];
    // The 18pt docTitle renders UPPERCASE ("LETTER OF INTENT"). The old
    // mid-body section header ALSO rendered uppercase (textTransform) — so
    // before audit13 there were 2+ uppercase occurrences on page 1 plus the
    // uppercase footer prefix. Now exactly 1 (the title block); the intro
    // paragraph mention ("…this Letter of Intent…") is natural-case prose:
    const titleCount = page1.match(/LETTER OF INTENT/g)?.length ?? 0;
    expect(titleCount).toBe(1);
    expect(page1).toContain("Dear EDGE GROUP GLOBAL FZCO");
    // The intro-paragraph mention is natural-case prose (PDF line breaks
    // can split it — normalise whitespace before checking):
    const normalized = page1.replace(/\s+/g, " ");
    expect(normalized).toContain("stated in this Letter of Intent");
  });

  it("section headers stay with their tables (no orphaned 'Delivery & Payment Terms')", async () => {
    const { pages } = await renderAndExtract(renderLoi());
    // Find which page carries the table content:
    const tablePage = pages.findIndex((p) => p.includes("CIF Fujairah"));
    expect(tablePage).toBeGreaterThanOrEqual(0);
    // The header must be on the SAME page as its table:
    expect(pages[tablePage]).toContain("DELIVERY & PAYMENT TERMS");
  });

  it("contact line still renders once (website) in the party box — footer is clean", async () => {
    const { all, pages } = await renderAndExtract(renderLoi());
    // audit14: the website renders ONCE (party box, page 1) — the footer
    // used to repeat it on every page:
    expect(all).toContain("www.aspidus.co");
    const webCount = all.split("www.aspidus.co").length - 1;
    expect(webCount).toBe(1);
    expect(pages[1]).not.toContain("www.aspidus.co");
  });

  it("offer documents get the same deduped footer (uniformity)", async () => {
    const offer = {
      id: "o1",
      tenant_id: tenant.id,
      number: "OFF-2026-000009",
      partner_id: "p1",
      currency: "USD",
      status: "draft",
      valid_until: "2026-09-30T00:00:00Z",
      issue_date: "2026-08-29T00:00:00Z",
      created_at: "2026-08-29T00:00:00Z",
      subtotal: 17050000,
      discount: 0,
      tax_rate: 0,
      tax_amount: 0,
      total: 17050000,
      items: [],
      partner_name: null,
      subject: null,
      terms_text: null,
    } as unknown as any;
    const { all } = await renderAndExtract(
      renderLoi({ doc: offer, docType: "offer" as const }),
    );
    expect(all).not.toContain("Dubai, UAE, Dubai");
    expect(all).toContain("OFF-2026-000009");
    expect(all).toContain("Page 1 of");
    // audit14: footer carries no doc identifier at all — the number lives
    // in the title meta block and is NOT repeated in the footer:
    expect(all).not.toContain("OFF-2026-000009 · 29 Aug 2026");
    expect(all).not.toContain("OFFER OFF-2026-000009");
  });
});
