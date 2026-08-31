import { describe, it, expect } from "vitest";
import React from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { extractText, getDocumentProxy } from "unpdf";
import { buildPdfDocument } from "@/lib/pdf/templates";
import { renderPackingListPdf, buildPackingListInput } from "@/lib/pdf/packing-list";
import { renderTradeDocumentPDF } from "@/lib/marketplace/document-pdf";
import type { Offer, Invoice, Proforma, LetterOfIntent, OfferLineItem, Partner, Tenant } from "@/lib/supabase/types";

// 13-B: REAL end-to-end PDF rendering tests (audit12 uniformity round).
//
// Every test renders an actual PDF via @react-pdf/renderer, then parses the
// produced bytes with unpdf/pdfjs to assert on the *extracted text*. This
// directly verifies the user-facing guarantees:
//   • correct page numbers ("Page X of Y") on every page of every template
//   • correct document data (numbers, names, totals, terms)
//   • watermarks render FULL text (regression: CANCELLED was clipped to
//     "CANCELL" by the old left:50% + translate(-50%,-50%) positioning)
//   • uniform footers/watermarks across all three template families
//   • no "undefined"/"NaN"/"enc:" ciphertext ever leaks into a PDF

async function renderAndExtract(element: React.ReactElement) {
  const buf = await renderToBuffer(element as any);
  expect(buf.length).toBeGreaterThan(500); // a real PDF, not an empty buffer
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: false });
  return { pdf, pages: (text as unknown as string[]).map((p) => String(p)) };
}

// ─── Shared fixtures ────────────────────────────────────────────────────────

const tenant: Tenant = {
  id: "t1",
  name: "Aspidus Trading FZE",
  legal_name: "Aspidus Trading FZE LLC",
  country: "AE",
  currency: "USD",
  tax_id: "AE-100200300",
  vat_number: null,
  registration_number: "REG-778899",
  address_line: "Saif Zone, Block C, Warehouse 12",
  city: "Sharjah",
  postal_code: null,
  email: "trade@aspidus.example",
  phone: "+971 55 111 2222",
  website: "aspidus.example",
  bank_name: "Emirates NBD",
  bank_accounts: JSON.stringify([
    { bankName: "Emirates NBD", currency: "USD", swiftCode: "EBILAEAD", accountNumber: "1234567890" },
  ]),
  bank_iban: null,
  bank_swift: "EBILAEAD",
  logo_url: null,
  primary_color: null,
  plan: "business",
  status: "active",
} as unknown as Tenant;

const partner: Partner = {
  id: "p1",
  tenant_id: "t1",
  name: "Horn of Africa Import Export PLC",
  entity_type: "company" as any,
  type: "customer" as any,
  email: "buyer@hoaf.example",
  phone: "+251 91 123 4567",
  website: null,
  tax_id: "ET-0001234567",
  vat_number: null,
  registration_number: "ET-REG-4242",
  address_line: "Bole Road, Africa Avenue 42",
  city: "Addis Ababa",
  state: null,
  postal_code: "1000",
  country: "ET",
  contact_name: "Abebe Bekele",
  contact_email: "abebe@hoaf.example",
  contact_phone: null,
  bank_name: null,
  bank_account: null,
  bank_swift: null,
} as unknown as Partner;

function lineItem(overrides: Partial<OfferLineItem> = {}): OfferLineItem {
  return {
    product_id: "prod1",
    product_name: "Premium Sesame Seeds, Hulled",
    sku: "SES-HUL-001",
    quantity: 25000,
    unit: "kg",
    unit_price: 1.55,
    discount: 0,
    tax_rate: 0,
    total: 38750,
    hs_code: "1207.40",
    origin_country: "ET",
    brand: "Aspidus Gold",
    ...overrides,
  } as OfferLineItem;
}

const offer: Offer = {
  id: "o1",
  tenant_id: "t1",
  number: "OF-2026-0001",
  deal_id: null,
  partner_id: "p1",
  owner_id: null,
  status: "sent",
  subject: "Supply of hulled sesame seeds — 2026 season",
  currency: "USD",
  subtotal: 38750,
  discount_total: 0,
  tax_total: 0,
  total: 38750,
  notes: null,
  terms: "Payment: 30% advance, 70% against B/L copy.",
  valid_until: "2026-09-30T00:00:00Z",
  sent_at: null,
  responded_at: null,
  items: [lineItem()],
  offer_no: null,
  bank_details: null,
  pol: "Djibouti",
  pod: "Jebel Ali",
  vessel: "MV ASTRO LION",
  container_no: "MSKU-1234567",
  lead_time: "21 days after advance",
  packaging: "25 kg PP bags",
  payment_terms: "30/70 T/T",
  tax_clause: null,
  incoterm: "CIF",
  selling_price: null,
  issue_date: "2026-08-01T00:00:00Z",
  created_at: "2026-08-01T00:00:00Z",
} as unknown as Offer;

const invoice: Invoice = {
  ...offer,
  id: "i1",
  number: "INV-2026-0001",
  status: "issued",
  subtotal: 38750,
  tax_total: 1937.5,
  total: 40687.5,
  due_date: "2026-09-15T00:00:00Z",
} as unknown as Invoice;

const proforma: Proforma = {
  ...offer,
  id: "pf1",
  number: "PRO-2026-0001",
  status: "issued",
} as unknown as Proforma;

const loi: LetterOfIntent = {
  id: "l1",
  tenant_id: "t1",
  number: "LOI-2026-0001",
  partner_id: "p1",
  buyer_name: "Aspidus Trading FZE LLC",
  buyer_address: null,
  buyer_contact: null,
  subject: "Intent to purchase hulled sesame seeds",
  product_name: "Premium Sesame Seeds, Hulled",
  product_description: "Moisture max 6%, purity min 99.95%",
  hs_code: "1207.40",
  origin_country: "ET",
  quantity: 25000,
  unit: "kg",
  unit_price: 1.55,
  currency: "USD",
  total_value: 38750,
  delivery_terms: "CIF Jebel Ali",
  delivery_date: "2026-09-15T00:00:00Z",
  payment_terms: "30/70 T/T",
  validity_until: "2026-09-30T00:00:00Z",
  status: "sent",
  notes: null,
  terms_text: null,
  sent_at: null,
  responded_at: null,
  created_by: null,
  deal_id: null,
  offer_id: null,
  created_at: "2026-08-01T00:00:00Z",
  issue_date: "2026-08-01T00:00:00Z",
} as unknown as LetterOfIntent;

function renderTradeDoc(doc: any, docType: "offer" | "invoice" | "proforma" | "loi", extra: Record<string, unknown> = {}) {
  return React.createElement(buildPdfDocument, {
    doc,
    docType,
    partner,
    tenant,
    memorandumSettings: null,
    ...extra,
  });
}

// ─── Trade document templates (offer/invoice/proforma/LOI) ─────────────────

describe("PDF template rendering — offer", () => {
  it("renders correct document data, page numbers and branding", async () => {
    const { pdf, pages } = await renderAndExtract(renderTradeDoc(offer, "offer"));
    const all = pages.join("\n");
    expect(pdf.numPages).toBeGreaterThanOrEqual(1);
    // document identity. audit13: the docTitle renders UPPERCASE
    // ("OFFER") — the old title-case "Offer" existed only in the footer's
    // doc-type prefix, which audit13 removed (number prefix already encodes
    // the type; the old line also wrapped in the narrow footer column).
    expect(all).toContain("OF-2026-0001");
    expect(all).toContain("OFFER");
    // footer identifier: number + issue date, single line:
    expect(all).toContain("OF-2026-0001 · 01 Aug 2026");
    // parties
    expect(all).toContain("Aspidus Trading FZE LLC");
    expect(all).toContain("Horn of Africa Import Export PLC");
    // country resolved from ISO code, not the raw "ET"
    expect(all).toContain("Ethiopia");
    // trade terms
    expect(all).toContain("CIF");
    expect(all).toContain("Djibouti");
    expect(all).toContain("Jebel Ali");
    // line item + totals
    expect(all).toContain("Premium Sesame Seeds, Hulled");
    expect(all).toContain("$38,750.00");
    expect(all).toContain("GRAND TOTAL");
    // amount in words (the legal line) — normalise whitespace: the legend
    // wraps across 2 lines in the rendered PDF
    expect(all.replace(/\s+/g, " ")).toContain(
      "SAY: THIRTY-EIGHT THOUSAND SEVEN HUNDRED FIFTY US DOLLARS ONLY",
    );
    // page number on every page
    for (let i = 0; i < pages.length; i++) {
      expect(pages[i]).toContain(`Page ${i + 1} of ${pdf.numPages}`);
    }
    // no leaked junk
    expect(all).not.toContain("undefined");
    expect(all).not.toContain("NaN");
    expect(all).not.toContain("enc:");
  });

  it("renders a full CANCELLED watermark (regression: was clipped to 'CANCELL')", async () => {
    const { pages } = await renderAndExtract(
      renderTradeDoc({ ...offer, status: "cancelled" }, "offer"),
    );
    expect(pages.join("\n")).toContain("CANCELLED");
  });

  it("renders PRICE NOT CONFIRMED watermark in full (marketplace-derived docs)", async () => {
    const { pages } = await renderAndExtract(
      renderTradeDoc({ ...offer, status: "sent", document_data: { priceUnconfirmed: true } }, "offer"),
    );
    expect(pages.join("\n")).toContain("PRICE NOT CONFIRMED");
  });

  it("renders correct page numbers across a MULTI-page document (30 line items)", async () => {
    const items = Array.from({ length: 30 }, (_, i) =>
      lineItem({ product_name: `Line item ${i + 1}`, sku: `SKU-${i + 1}` }),
    );
    const { pdf, pages } = await renderAndExtract(
      renderTradeDoc({ ...offer, items }, "offer"),
    );
    expect(pdf.numPages).toBeGreaterThan(1);
    for (let i = 0; i < pages.length; i++) {
      expect(pages[i]).toContain(`Page ${i + 1} of ${pdf.numPages}`);
    }
  });
});

describe("PDF template rendering — invoice", () => {
  it("shows the VAT line when tax > 0", async () => {
    const { pdf, pages } = await renderAndExtract(renderTradeDoc(invoice, "invoice"));
    const all = pages.join("\n");
    // audit13: docTitle renders uppercase; footer shows number + date only.
    expect(all.toUpperCase()).toContain("COMMERCIAL INVOICE");
    expect(all).toContain("INV-2026-0001");
    expect(all).toContain("INV-2026-0001 · 01 Aug 2026");
    expect(all).toContain("VAT:");
    expect(all).toContain("$1,937.50");
    expect(all).toContain("$40,687.50");
    for (let i = 0; i < pages.length; i++) {
      expect(pages[i]).toContain(`Page ${i + 1} of ${pdf.numPages}`);
    }
  });

  it("shows the reverse-charge legend when tax = 0 (B2B cross-border)", async () => {
    const zeroTax = { ...invoice, tax_total: 0, total: 38750 };
    const { pages } = await renderAndExtract(renderTradeDoc(zeroTax, "invoice"));
    expect(pages.join("\n")).toContain("Reverse charge");
  });
});

describe("PDF template rendering — proforma", () => {
  it("carries the 'NOT A TAX INVOICE' banner", async () => {
    const { pages } = await renderAndExtract(renderTradeDoc(proforma, "proforma"));
    const all = pages.join("\n");
    expect(all).toContain("PROFORMA");
    expect(all).toContain("NOT A TAX INVOICE");
    expect(all).toContain("PRO-2026-0001");
  });
});

describe("PDF template rendering — LOI", () => {
  it("renders the LOI body, product spec table and buyer/seller roles", async () => {
    const { pages } = await renderAndExtract(renderTradeDoc(loi, "loi"));
    const all = pages.join("\n");
    expect(all).toContain("LETTER OF INTENT");
    expect(all).toContain("LOI-2026-0001");
    // LOI roles: tenant is the BUYER, partner is the SELLER
    expect(all).toContain("FROM (BUYER)");
    expect(all).toContain("TO (SELLER)");
    expect(all).toContain("Buyer Signature");
    expect(all).toContain("Seller Acceptance");
    // product spec table (section headers render UPPERCASE via textTransform)
    expect(all).toContain("PRODUCT SPECIFICATIONS");
    expect(all).toContain("25,000 kg");
    // delivery terms
    expect(all).toContain("DELIVERY & PAYMENT TERMS");
  });
});

// ─── Packing list template ──────────────────────────────────────────────────

describe("Packing list PDF rendering", () => {
  it("renders correct page numbers across multiple pages + full DELIVERED watermark", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => ({
      description: `Cargo line ${i + 1}`,
      packages: 20,
      package_type: "PP bag",
      unit_weight_kg: 25,
    }));
    const buf = await renderPackingListPdf({
      tenantName: "Aspidus Trading FZE",
      requestNumber: "LR-2026-0042",
      mode: "sea",
      containerType: "40ft HC",
      incoterm: "CIF",
      createdAt: "2026-08-01T00:00:00Z",
      targetPickupDate: "2026-06-01T00:00:00Z",
      targetDeliveryDate: "2026-07-01T00:00:00Z",
      origin: { company: "Origin Co", port: "Djibouti" },
      destination: { company: "Dest Co", port: "Jebel Ali" },
      cargo: { description: "Hulled sesame seeds", is_hazardous: false },
      packingList: lines,
    });
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = (text as unknown as string[]).map((p) => String(p));

    expect(pdf.numPages).toBeGreaterThan(1);
    // page numbers on EVERY page (regression: the old hardcoded left:540
    // positioning produced the number on every page but was fragile)
    for (let i = 0; i < pages.length; i++) {
      expect(pages[i]).toContain(`Page ${i + 1} of ${pdf.numPages}`);
    }
    const all = pages.join("\n");
    // full watermark text — no clipping (regression: "DELIVERED" was cut to "DELIVERE")
    expect(all).toContain("DELIVERED");
    // header + route
    expect(all).toContain("LR-2026-0042");
    expect(all).toContain("40ft HC");
    expect(all).toContain("Djibouti");
    expect(all).toContain("Jebel Ali");
    // packing lines + totals
    expect(all.toUpperCase()).toContain("PACKING LINES (30)");
    expect(all).toContain("Cargo line 1");
    expect(all).toContain("Cargo line 30");
  });

  it("buildPackingListInput maps an LR row faithfully (shared by admin + portal routes)", () => {
    const lr = {
      number: "LR-9", mode: "air", container_type: null, incoterm: "FOB",
      created_at: "2026-01-01", target_pickup_date: null, target_delivery_date: null,
      origin_company: "OC", origin_address_line: "OA", origin_city: "O city", origin_postal_code: "1",
      origin_country: "ET", origin_port: "OP", origin_contact_name: "Oc", origin_contact_phone: "01",
      destination_company: "DC", destination_address_line: "DA", destination_city: "D city",
      destination_postal_code: "2", destination_country: "AE", destination_port: "DP",
      destination_contact_name: "Dc", destination_contact_phone: "02",
      cargo_description: "desc", hs_codes: "1,2", is_hazardous: true, is_temperature_controlled: false,
      temperature_range: null, insurance_required: true, cargo_value: 99, cargo_currency: "USD",
      total_weight_kg: 100, total_volume_cbm: 2, total_packages: 10,
      packing_list: [{ description: "x" }],
      special_instructions: "handle with care",
    };
    const input = buildPackingListInput(lr, "Tenant");
    expect(input.tenantName).toBe("Tenant");
    expect(input.requestNumber).toBe("LR-9");
    expect(input.mode).toBe("air");
    expect(input.origin).toMatchObject({ company: "OC", port: "OP", country: "ET" });
    expect(input.destination).toMatchObject({ company: "DC", port: "DP", country: "AE" });
    expect(input.cargo).toMatchObject({ description: "desc", is_hazardous: true, total_weight_kg: 100 });
    expect(input.packingList).toEqual([{ description: "x" }]);
    expect(input.specialInstructions).toBe("handle with care");
    // non-array packing_list → empty array (human error / legacy rows)
    const bad = buildPackingListInput({ ...lr, packing_list: "not-an-array" }, "T");
    expect(bad.packingList).toEqual([]);
  });
});

// ─── Marketplace trade documents ────────────────────────────────────────────

describe("Marketplace trade document PDF rendering", () => {
  const mktInvoice = {
    status: "draft",
    meta: { reference_number: "CI-MKT-0007", generated_at: "2026-08-01T00:00:00Z" },
    seller: { name: "Seller GmbH", country: "DE" },
    buyer: { name: "Buyer FZE", country: "AE" },
    currency: "USD",
    incoterm: "FOB",
    payment_terms: "T/T 30 days",
    date: "2026-08-01",
    items: [
      { description: "Copper wire", hs_code: "8544.49", quantity: 1000, unit: "kg", unit_price: 12.5, total_price: 12500 },
      { description: "Copper strip", hs_code: "7409.21", quantity: 500, unit: "kg", unit_price: 9.2, total_price: 4600 },
    ],
    subtotal: 17100,
    tax_rate: 0,
    total: 17100,
  };

  it("commercial invoice: data + page numbers + full DRAFT watermark + reverse-charge legend", async () => {
    const buf = await renderTradeDocumentPDF("commercial_invoice", mktInvoice);
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = (text as unknown as string[]).map((p) => String(p));
    const all = pages.join("\n");

    expect(pdf.numPages).toBe(1);
    expect(pages[0]).toContain("Page 1 of 1");
    expect(all).toContain("CI-MKT-0007");
    expect(all).toContain("Seller GmbH");
    expect(all).toContain("Buyer FZE");
    expect(all).toContain("Copper wire");
    expect(all).toContain("$17,100.00");
    // tax_rate=0 → reverse-charge legend, full text on one line
    expect(all).toContain("Reverse charge");
    expect(all).toContain("settled by the recipient");
    // full DRAFT watermark (marketplace family)
    expect(all).toContain("DRAFT");
    // SHA-256 fingerprint in the footer
    expect(all).toMatch(/sha256:[0-9a-f]{17,}/);
    expect(all).not.toContain("undefined");
    expect(all).not.toContain("NaN");
  });

  it("renders a full REJECTED watermark (regression: 8-char statuses were clipped)", async () => {
    const buf = await renderTradeDocumentPDF("commercial_invoice", {
      ...mktInvoice,
      status: "rejected",
    });
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    expect(String(text)).toContain("REJECTED");
  });

  it("proforma: single Grand Total row (no duplicate Subtotal=Total)", async () => {
    const buf = await renderTradeDocumentPDF("proforma_invoice", {
      ...mktInvoice,
      meta: { reference_number: "PF-MKT-0001", generated_at: "2026-08-01T00:00:00Z" },
      subtotal: 17100,
      tax_rate: 0,
      total: 17100, // the common marketplace case: total = subtotal
      validity_days: 30,
    });
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    const t = String(text);
    expect(t).toContain("Proforma Invoice");
    expect(t).toContain("Grand Total");
    expect(t).toContain("$17,100.00");
    expect(t).toContain("Page 1 of 1");
  });

  it("multi-page marketplace doc renders page numbers on every page", async () => {
    const items = Array.from({ length: 45 }, (_, i) => ({
      description: `Marketplace item ${i + 1} with a fairly long description to force wrapping`,
      hs_code: "1234.56",
      quantity: 10,
      unit: "kg",
      unit_price: 2,
      total_price: 20,
    }));
    const buf = await renderTradeDocumentPDF("commercial_invoice", {
      ...mktInvoice,
      items,
      subtotal: 900,
      total: 900,
    });
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = (text as unknown as string[]).map((p) => String(p));
    expect(pdf.numPages).toBeGreaterThan(1);
    for (let i = 0; i < pages.length; i++) {
      expect(pages[i]).toContain(`Page ${i + 1} of ${pdf.numPages}`);
    }
  });
});
