import { describe, it, expect } from "vitest";
import React from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { getDocumentProxy } from "unpdf";
import { buildPdfDocument } from "@/lib/pdf/templates";
import type { Offer, LetterOfIntent, Partner, Tenant, MemorandumSettings } from "@/lib/supabase/types";

// audit14: REAL geometric regression tests for the footer position + content
// bugs the user reported from production:
//
//   1. "na drugim stranama footer pomera na sredinu stranice umesto da
//      bude fiksan na dno na svakoj stranici" — the footer View flowed with
//      the body content, so on every page where the content ended early
//      (typically the LAST page) the footer landed mid-page. It is now
//      absolutely positioned at bottom:0. These tests verify the geometry:
//      on EVERY page the page-number text sits inside the pinned footer
//      band, and no body text ever enters it.
//   2. "ne treba biti 6 puta ista informacija na jednom dokumentu" — the
//      footer carried the tenant address/contact (duplicating the party
//      boxes) and the doc number + date (duplicating the title meta) on
//      EVERY page. Now each appears exactly once, on page 1 only.
//
// Geometry source: pdfjs getTextContent() items carry `transform`
// [a,b,c,d,e,f] where (e, f) is the baseline position in PDF coordinates
// (origin bottom-left) — f is the distance from the BOTTOM of the page.

interface TextItem {
  str: string;
  x: number; // distance from left edge
  y: number; // distance from bottom edge (baseline)
}

async function renderPdf(element: React.ReactElement) {
  const buf = await renderToBuffer(element as any);
  expect(buf.length).toBeGreaterThan(500);
  return getDocumentProxy(new Uint8Array(buf));
}

async function pageItems(pdf: any, pageNum: number): Promise<{ items: TextItem[]; height: number }> {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items: TextItem[] = (content.items as any[])
    .filter((it) => typeof it.str === "string" && it.str.trim().length > 0)
    .map((it) => ({ str: it.str as string, x: (it.transform as number[])[4], y: (it.transform as number[])[5] }));
  return { items, height: viewport.height as number };
}

// ─── Fixtures (production-shaped) ────────────────────────────────────────────

const tenant: Tenant = {
  id: "t1",
  name: "ASPIDUS DMCC",
  legal_name: "ASPIDUS DMCC",
  country: "AE",
  currency: "USD",
  tax_id: null,
  vat_number: null,
  registration_number: "DMCC-889293",
  address_line: "GoldCrest Executive Tower, 1002-A, JLT Cluster C, Dubai, UAE",
  city: "Dubai",
  postal_code: null,
  email: "desk@aspidus.co",
  phone: "+971 4 000 0000",
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
  address_line: "IFZA Business Park, Building A2, Dubai Silicon Oasis",
  city: "Dubai",
  postal_code: null,
  country: "AE",
  email: null,
  phone: null,
  website: null,
} as unknown as Partner;

const memoSettings = {
  footer_enabled: true,
  footer_height_mm: 17, // ≈ 48.2pt — the footer band height
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
  header_enabled: true,
  header_height_mm: 23,
  header_bg_color: "#ffffff",
  header_left_font_family: "Times-Roman",
  header_left_font_size: 14,
  header_left_font_color: "#3457D5",
  header_left_font_bold: true,
  logo_enabled: true,
  logo_max_width_mm: 50,
  logo_max_height_mm: 20,
  logo_position_x_mm: 14,
  logo_position_y_mm: 0,
  logo_fit_mode: "contain",
  body_font_family: "Helvetica",
  body_font_size: 9,
  body_line_height: 1.4,
  body_text_color: "#000000",
  primary_color: "#3457D5",
} as unknown as MemorandumSettings;

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
  coa_params: { Moisture: "0.05%", Polarization: "99.80", ICUMSA: "45", Color: "Sparkling White" },
  specifications: { Ash: "0.03%", Solubility: "100%", Granulation: "Fine" },
  created_at: "2026-08-29T00:00:00Z",
} as unknown as LetterOfIntent;

// 34 line items → an 8-page document: the exact shape that exposed the
// footer-position bug most dramatically (pages 2..8 have varying content
// heights; the last page ends about 40% down).
const items = Array.from({ length: 34 }, (_, i) => ({
  id: `li${i}`,
  offer_id: "o1",
  product_name: `Refined Sugar ICUMSA 45 — batch ${i + 1} long description text to wrap lines`,
  sku: `SKU-${1000 + i}`,
  brand: "Brand X",
  hs_code: "1701991000",
  origin_country: "BR",
  quantity: 1000 + i * 37,
  unit: "kg",
  unit_price: 0.55,
  total: (1000 + i * 37) * 0.55,
}));

const offer: Offer = {
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
  discount_total: 0,
  tax_total: 0,
  total: 17050000,
  items,
  subject: "Sugar supply",
  terms: "Standard terms apply. This offer is subject to confirmation.",
  notes: null,
} as unknown as Offer;

const FOOTER_BAND = 48.2 + 6; // footer_height_mm 17 → 48.19pt + tolerance

function renderTrade(doc: any, docType: "offer" | "invoice" | "proforma" | "loi") {
  return React.createElement(buildPdfDocument, {
    doc,
    docType,
    partner,
    tenant,
    memorandumSettings: memoSettings,
    verificationCode: "ASP-OF26-009-ABC123",
    qrCodeDataUrl: null,
    logoUrl: null,
    sealImageUrl: null,
    seal: null,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("audit14 — footer pinned to the bottom on EVERY page (geometry)", () => {
  it("8-page offer: 'Page N of M' sits in the bottom footer band on all 8 pages; no body text enters it", async () => {
    const pdf = await renderPdf(renderTrade(offer, "offer"));
    expect(pdf.numPages).toBeGreaterThanOrEqual(6);
    for (let p = 1; p <= pdf.numPages; p++) {
      const { items: its } = await pageItems(pdf, p);
      const joined = its.map((i) => i.str).join("");
      // 1. The page number text is present on this page…
      expect(joined).toContain(`Page ${p} of ${pdf.numPages}`);
      // 2. …and its baseline is INSIDE the pinned footer band (near the
      //    bottom edge). Before audit14 the footer flowed with the content —
      //    on short pages (esp. the last) "Page X" landed ~150pt above the
      //    bottom (mid-page).
      const pgItems = its.filter((i) => i.str.startsWith("Page ") || (i.str === `${p} of ${pdf.numPages}`) || /^of \d+$/.test(i.str));
      expect(pgItems.length).toBeGreaterThan(0);
      for (const item of pgItems) {
        expect(item.y).toBeLessThan(FOOTER_BAND);
        expect(item.y).toBeGreaterThan(0);
      }
      // 3. Only FRAME content lives in the band (audit33: canonical footer =
      //    address LEFT + QR CENTER + page number RIGHT + note lines) —
      //    body content (line items etc.) never overlaps the pinned footer.
      const bandText = its.filter((i) => i.y < 45).map((i) => i.str).join("\n");
      expect(bandText).not.toContain("Sesame");
      expect(bandText).not.toContain("OFF-");
      // The frame: address (memo footer-left) + page number, every page.
      expect(bandText).toContain("Page");
      expect(bandText).toContain("GoldCrest");
    }
  });

  it("2-page LOI: page number in the bottom band on both pages — including the short last page", async () => {
    const pdf = await renderPdf(renderTrade(loi, "loi"));
    expect(pdf.numPages).toBeGreaterThanOrEqual(2);
    for (let p = 1; p <= pdf.numPages; p++) {
      const { items: its } = await pageItems(pdf, p);
      const joined = its.map((i) => i.str).join("");
      expect(joined).toContain(`Page ${p} of ${pdf.numPages}`);
      const pgItems = its.filter((i) => i.str.startsWith("Page ") || (i.str === `${p} of ${pdf.numPages}`) || /^of \d+$/.test(i.str));
      expect(pgItems.length).toBeGreaterThan(0);
      for (const item of pgItems) {
        expect(item.y).toBeLessThan(FOOTER_BAND);
      }
    }
  });
});

describe("audit14 — footer content: no information duplicated across the document", () => {
  it("tenant address / contact / doc number appear EXACTLY ONCE in an 8-page document (page 1, party box + meta)", async () => {
    const pdf = await renderPdf(renderTrade(offer, "offer"));
    for (let p = 1; p <= pdf.numPages; p++) {
      const { items: its } = await pageItems(pdf, p);
      const joined = its.map((i) => i.str).join(" ");
      if (p === 1) {
        // page 1 carries the party box (address, website, email, phone)
        // and the title meta (doc number + issue date) — once each:
        expect(joined).toContain("GoldCrest Executive Tower");
        expect(joined).toContain("www.aspidus.co");
        expect(joined).toContain("OFF-2026-000009");
      } else {
        // audit33 canonical: pages 2..8 carry the tenant ADDRESS (memo
        // footer-left zone — the LOI look) but NEITHER the contact info
        // nor the doc number (those stay page-1-only, no duplication):
        expect(joined).toContain("GoldCrest");
        expect(joined).not.toContain("www.aspidus.co");
        expect(joined).not.toContain("desk@aspidus.co");
        expect(joined).not.toContain("OFF-2026-000009");
      }
    }
  });

  it("audit33: the footer band carries the canonical frame — address + page number, no identifiers", async () => {
    const pdf = await renderPdf(renderTrade(offer, "offer"));
    for (let p = 1; p <= pdf.numPages; p++) {
      const { items: its } = await pageItems(pdf, p);
      const bandStrs = its.filter((i) => i.y < 45).map((i) => i.str);
      const band = bandStrs.join("\n");
      // Canonical LOI look: company address LEFT + page number RIGHT.
      expect(band).toMatch(/Page \d+ of \d+/);
      expect(band).toContain("GoldCrest Executive Tower");
      // NO identifiers that duplicate the title meta / party contact info:
      expect(band).not.toContain("OFF-");
      expect(band).not.toContain("www.aspidus.co");
      expect(band).not.toContain("desk@aspidus.co");
      expect(band).not.toContain("+971");
    }
  });
});
