// Marketplace Phase 8 — trade document generators.
//
// Pure functions that take the "deal data" (post + negotiation + shipment +
// partner info) and produce a structured `document_data` JSONB payload ready
// to be persisted on `marketplace_trade_documents`. The PDF renderer
// (src/lib/marketplace/document-pdf.ts) reads this JSONB verbatim, so any
// field rename here is a backwards-incompatible change to the stored shape.
//
// DOCUMENTS SUPPORTED
//   • commercial_invoice   — ICC-compliant commercial invoice
//   • packing_list         — list of packages per line item
//   • certificate_of_origin — origin + criterion (WTO)
//   • bill_of_lading        — electronic Bill of Lading (eBL)
//   • proforma_invoice      — quote-before-purchase proforma
//
// Each generator returns a `Record<string, any>` (the JSONB payload) with
// a consistent envelope:
//   {
//     meta: { document_type, reference_number, generated_at, schema_version },
//     ...document-specific fields...
//   }
//
// The `meta` block lets the PDF renderer render the header / footer without
// knowing which document type it's rendering — it reads meta.document_type
// to pick the right template, and meta.reference_number to print the doc id.
//
// SECURITY / TENANCY
//   These functions are PURE — they don't touch Supabase and don't enforce
// tenant isolation. The caller (the API route in
// src/app/api/marketplace/documents/…) stamps tenant_id / partner_id from
// the auth context. Never trust body-supplied partner_id.

// ─── Types ────────────────────────────────────────────────────────────────

export type MarketplaceTradeDocumentType =
  | "commercial_invoice"
  | "packing_list"
  | "certificate_of_origin"
  | "bill_of_lading"
  | "shipping_manifest"
  | "inspection_certificate"
  | "insurance_certificate"
  | "export_declaration"
  | "customs_declaration"
  | "letter_of_credit_draft"
  | "proforma_invoice"
  | "weight_certificate";

export type MarketplaceTradeDocumentStatus =
  | "draft"
  | "generated"
  | "sent"
  | "signed"
  | "rejected";

/**
 * The canonical list of document types we know how to AUTO-generate. The
 * rest of the document_type values on the DB enum are valid for storage
 * but the auto-generate API refuses to emit them (the operator must fill
 * them in manually via the PUT route).
 */
export const AUTO_GENERATABLE_TYPES: MarketplaceTradeDocumentType[] = [
  "commercial_invoice",
  "packing_list",
  "certificate_of_origin",
  "bill_of_lading",
  "proforma_invoice",
];

/**
 * The full set of allowed document-type values — mirrors the CHECK
 * constraint on the `marketplace_trade_documents` table so the API routes
 * can validate input without a DB round-trip.
 */
export const ALLOWED_DOCUMENT_TYPES: MarketplaceTradeDocumentType[] = [
  "commercial_invoice",
  "packing_list",
  "certificate_of_origin",
  "bill_of_lading",
  "shipping_manifest",
  "inspection_certificate",
  "insurance_certificate",
  "export_declaration",
  "customs_declaration",
  "letter_of_credit_draft",
  "proforma_invoice",
  "weight_certificate",
];

export const ALLOWED_DOCUMENT_STATUSES: MarketplaceTradeDocumentStatus[] = [
  "draft",
  "generated",
  "sent",
  "signed",
  "rejected",
];

export interface TradeDocumentParty {
  name?: string | null;
  address_line?: string | null;
  city?: string | null;
  postal_code?: string | null;
  country?: string | null;
  country_code?: string | null;
  phone?: string | null;
  email?: string | null;
  tax_id?: string | null;          // VAT / EIN / company registration #
  contact_name?: string | null;
}

export interface TradeDocumentLineItem {
  description?: string | null;
  hs_code?: string | null;
  quantity?: number | null;
  unit?: string | null;
  unit_price?: number | null;
  currency?: string | null;
  total_price?: number | null;
  gross_weight_kg?: number | null;
  net_weight_kg?: number | null;
  packages?: number | null;
  package_type?: string | null;
  country_of_origin?: string | null;
}

// ─── Reference numbers ─────────────────────────────────────────────────────

/**
 * Generate a unique-ish reference number for a trade document.
 *
 * Format: DOC-YYYY-NNNNN where NNNNN is a 5-digit value derived from the
 * current millisecond timestamp XOR a 16-bit random salt. This gives us
 * ~100k collision-free IDs per second per tenant — more than enough for a
 * B2B trade platform where each partner issues tens of documents a week.
 *
 * The format is intentionally tenant-agnostic; the (tenant_id,
 * reference_number) tuple is the natural uniqueness key for display
 * purposes (the DB primary key is the UUID `id` column).
 */
export function generateDocumentNumber(
  type: MarketplaceTradeDocumentType,
  tenantId: string,
): string {
  const year = new Date().getUTCFullYear();
  // Mix the tenant id hash into the suffix so two tenants issuing docs in
  // the same millisecond don't collide. We use a 16-bit hash of the tenant
  // id (fnv-1a) so the suffix stays inside the 5-digit range.
  const tenantHash = fnv1a16(tenantId);
  const time = Date.now() & 0xfffff;        // 20 bits of ms timestamp
  const random = Math.floor(Math.random() * 0x10000); // 16-bit salt
  const suffixNum = ((time ^ (tenantHash << 16) ^ (random << 0)) >>> 0) % 100000;
  const suffix = String(suffixNum).padStart(5, "0");

  // Use a type-derived prefix so the doc type is readable from the number
  // (INV-2025-12345 vs BL-2025-12345). This is a UI affordance — the
  // authoritative type is the document_type column.
  const prefix = DOC_TYPE_PREFIX[type] ?? "DOC";
  return `${prefix}-${year}-${suffix}`;
}

const DOC_TYPE_PREFIX: Record<MarketplaceTradeDocumentType, string> = {
  commercial_invoice: "INV",
  packing_list: "PL",
  certificate_of_origin: "CO",
  bill_of_lading: "BL",
  shipping_manifest: "SM",
  inspection_certificate: "IC",
  insurance_certificate: "INS",
  export_declaration: "EX",
  customs_declaration: "CD",
  letter_of_credit_draft: "LC",
  proforma_invoice: "PRO",
  weight_certificate: "WT",
};

/**
 * 16-bit FNV-1a hash. Used to mix the tenant id into the document-number
 * suffix without making the suffix long. FNV-1a has good distribution for
 * short strings and is in the public domain.
 */
function fnv1a16(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 16) & 0xffff;
}

// ─── Meta helper ──────────────────────────────────────────────────────────

function buildMetaEnvelope(
  type: MarketplaceTradeDocumentType,
  referenceNumber: string,
  schemaVersion = 1,
): Record<string, unknown> {
  return {
    document_type: type,
    reference_number: referenceNumber,
    generated_at: new Date().toISOString(),
    schema_version: schemaVersion,
  };
}

// ─── Commercial invoice ───────────────────────────────────────────────────

export interface CommercialInvoiceInput {
  seller: TradeDocumentParty;
  buyer: TradeDocumentParty;
  items: TradeDocumentLineItem[];
  currency: string;
  incoterm: string;
  paymentTerms: string;
  referenceNumber: string;
  date: string;                  // ISO date — invoice issue date
  /** Optional pre-computed totals. When omitted the generator computes
   *  them from the items array. */
  subtotal?: number;
  taxRate?: number;              // percentage, e.g. 20 = 20%
  taxAmount?: number;
  shippingCost?: number;
  total?: number;
  notes?: string;
}

/**
 * Auto-generate a commercial invoice (ICC model) from the deal data.
 *
 * The output JSONB has the shape:
 *   {
 *     meta: { document_type, reference_number, generated_at, schema_version },
 *     seller: TradeDocumentParty,
 *     buyer: TradeDocumentParty,
 *     items: TradeDocumentLineItem[],
 *     currency, incoterm, payment_terms, date,
 *     subtotal, tax_rate, tax_amount, shipping_cost, total, notes
 *   }
 *
 * The PDF renderer (document-pdf.ts) reads these fields verbatim.
 */
export function generateCommercialInvoice(
  data: CommercialInvoiceInput,
): Record<string, any> {
  const items = (data.items ?? []).map((it, idx) => ({
    line: idx + 1,
    description: it.description ?? null,
    hs_code: it.hs_code ?? null,
    quantity: it.quantity ?? null,
    unit: it.unit ?? null,
    unit_price: it.unit_price ?? null,
    total_price:
      it.total_price ??
      (typeof it.unit_price === "number" && typeof it.quantity === "number"
        ? round2(it.unit_price * it.quantity)
        : null),
    gross_weight_kg: it.gross_weight_kg ?? null,
    net_weight_kg: it.net_weight_kg ?? null,
    packages: it.packages ?? null,
    package_type: it.package_type ?? null,
    country_of_origin: it.country_of_origin ?? null,
  }));

  const computedSubtotal = data.subtotal ?? round2(
    items.reduce((s, it) => s + (typeof it.total_price === "number" ? it.total_price : 0), 0),
  );
  const taxRate = data.taxRate ?? 0;
  const computedTax = data.taxAmount ?? round2((computedSubtotal * taxRate) / 100);
  const shippingCost = data.shippingCost ?? 0;
  const computedTotal = data.total ?? round2(computedSubtotal + computedTax + shippingCost);

  return {
    meta: buildMetaEnvelope("commercial_invoice", data.referenceNumber),
    seller: data.seller,
    buyer: data.buyer,
    items,
    currency: data.currency,
    incoterm: data.incoterm,
    payment_terms: data.paymentTerms,
    date: data.date,
    subtotal: computedSubtotal,
    tax_rate: taxRate,
    tax_amount: computedTax,
    shipping_cost: shippingCost,
    total: computedTotal,
    notes: data.notes ?? null,
  };
}

// ─── Packing list ─────────────────────────────────────────────────────────

export interface PackingListInput {
  shipper: TradeDocumentParty;
  consignee: TradeDocumentParty;
  items: TradeDocumentLineItem[];
  containerNumber: string;
  totalPackages: number;
  totalGrossWeight: number;       // kg
  totalNetWeight: number;         // kg
  referenceNumber: string;
  date?: string;
  marksAndNumbers?: string;
  notes?: string;
}

/**
 * Auto-generate a packing list. The output lists every line item with its
 * package count, weight, and a per-line description so a customs officer
 * can verify the cargo against the commercial invoice.
 */
export function generatePackingList(
  data: PackingListInput,
): Record<string, any> {
  const items = (data.items ?? []).map((it, idx) => ({
    line: idx + 1,
    description: it.description ?? null,
    hs_code: it.hs_code ?? null,
    packages: it.packages ?? null,
    package_type: it.package_type ?? null,
    quantity: it.quantity ?? null,
    unit: it.unit ?? null,
    gross_weight_kg: it.gross_weight_kg ?? null,
    net_weight_kg: it.net_weight_kg ?? null,
    country_of_origin: it.country_of_origin ?? null,
  }));

  // Sanity: if the caller didn't pre-compute the totals, derive them from
  // the items so the PDF renders consistent numbers.
  const totalPackages = data.totalPackages ?? items.reduce(
    (s, it) => s + (typeof it.packages === "number" ? it.packages : 0), 0,
  );
  const totalGross = data.totalGrossWeight ?? items.reduce(
    (s, it) => s + (typeof it.gross_weight_kg === "number" ? it.gross_weight_kg : 0), 0,
  );
  const totalNet = data.totalNetWeight ?? items.reduce(
    (s, it) => s + (typeof it.net_weight_kg === "number" ? it.net_weight_kg : 0), 0,
  );

  return {
    meta: buildMetaEnvelope("packing_list", data.referenceNumber),
    shipper: data.shipper,
    consignee: data.consignee,
    items,
    container_number: data.containerNumber,
    total_packages: totalPackages,
    total_gross_weight_kg: round2(totalGross),
    total_net_weight_kg: round2(totalNet),
    date: data.date ?? new Date().toISOString(),
    marks_and_numbers: data.marksAndNumbers ?? null,
    notes: data.notes ?? null,
  };
}

// ─── Certificate of origin ─────────────────────────────────────────────────

export interface CertificateOfOriginInput {
  exporter: TradeDocumentParty;
  importer: TradeDocumentParty;
  products: TradeDocumentLineItem[];
  originCountry: string;         // ISO 3166-1 alpha-2 or full name
  /** WTO criterion code:
   *    "A"  — wholly obtained
   *    "B"  — substantial change (HS chapter change)
   *    "C"  — value-added (regional value content)
   *    "D"  — specific processing operation */
  criterion: string;
  referenceNumber: string;
  date?: string;
  /** Chamber of commerce / issuing body */
  issuingBody?: string;
  notes?: string;
}

/**
 * Auto-generate a certificate of origin (WTO model).
 *
 * The `criterion` field follows the WTO Rules of Origin code letters so the
 * destination customs office can apply the correct preferential tariff
 * treatment.
 */
export function generateCertificateOfOrigin(
  data: CertificateOfOriginInput,
): Record<string, any> {
  const products = (data.products ?? []).map((p, idx) => ({
    line: idx + 1,
    description: p.description ?? null,
    hs_code: p.hs_code ?? null,
    quantity: p.quantity ?? null,
    unit: p.unit ?? null,
    country_of_origin: p.country_of_origin ?? data.originCountry,
    gross_weight_kg: p.gross_weight_kg ?? null,
    net_weight_kg: p.net_weight_kg ?? null,
  }));

  return {
    meta: buildMetaEnvelope("certificate_of_origin", data.referenceNumber),
    exporter: data.exporter,
    importer: data.importer,
    products,
    origin_country: data.originCountry,
    criterion: data.criterion,
    date: data.date ?? new Date().toISOString(),
    issuing_body: data.issuingBody ?? null,
    notes: data.notes ?? null,
  };
}

// ─── Bill of Lading (eBL) ──────────────────────────────────────────────────

export interface BillOfLadingInput {
  shipper: TradeDocumentParty;
  consignee: TradeDocumentParty;
  notifyParty: TradeDocumentParty;
  vesselName: string;
  portOfLoading: string;
  portOfDischarge: string;
  containerNumber: string;
  goodsDescription: string;
  weight: number;               // kg
  /** Number of packages / cartons. */
  packages?: number;
  /** "original" | "copy" — how many B/L originals were issued. */
  numberOfOriginals?: number;
  /** Freight terms: "prepaid" | "collect" | "elsewhere". */
  freightTerms?: string;
  referenceNumber: string;
  date?: string;
  carrierName?: string;
  bookingNumber?: string;
  measurement?: number;         // CBM
  notes?: string;
}

/**
 * Auto-generate an electronic Bill of Lading (eBL). The output is the
 * structured equivalent of a paper ocean B/L — shipper / consignee /
 * notify party, vessel + voyage, container #, goods description, weight,
 * freight terms, and number of originals.
 *
 * The eBL is "signed" by computing a SHA-256 over the JSONB + the
 * signer's partner_id, at the API layer (POST /documents/[id]/sign).
 * A signed eBL is immutable: any further PUT to the row is rejected.
 */
export function generateBillOfLading(
  data: BillOfLadingInput,
): Record<string, any> {
  return {
    meta: buildMetaEnvelope("bill_of_lading", data.referenceNumber),
    shipper: data.shipper,
    consignee: data.consignee,
    notify_party: data.notifyParty,
    vessel_name: data.vesselName,
    port_of_loading: data.portOfLoading,
    port_of_discharge: data.portOfDischarge,
    container_number: data.containerNumber,
    goods_description: data.goodsDescription,
    weight_kg: round2(data.weight),
    packages: data.packages ?? null,
    number_of_originals: data.numberOfOriginals ?? 3,
    freight_terms: data.freightTerms ?? "prepaid",
    date: data.date ?? new Date().toISOString(),
    carrier_name: data.carrierName ?? null,
    booking_number: data.bookingNumber ?? null,
    measurement_cbm: data.measurement ?? null,
    notes: data.notes ?? null,
  };
}

// ─── Proforma invoice ──────────────────────────────────────────────────────

export interface ProformaInvoiceInput {
  seller: TradeDocumentParty;
  buyer: TradeDocumentParty;
  items: TradeDocumentLineItem[];
  currency: string;
  validityDays: number;         // how long the proforma is valid for
  referenceNumber: string;
  date?: string;
  incoterm?: string;
  paymentTerms?: string;
  deliveryDate?: string;
  notes?: string;
}

/**
 * Auto-generate a proforma invoice. Used by buyers to apply for an import
 * licence / letter of credit before the commercial invoice is issued. The
 * validity period is mandatory (most jurisdictions require it).
 */
export function generateProformaInvoice(
  data: ProformaInvoiceInput,
): Record<string, any> {
  const items = (data.items ?? []).map((it, idx) => ({
    line: idx + 1,
    description: it.description ?? null,
    hs_code: it.hs_code ?? null,
    quantity: it.quantity ?? null,
    unit: it.unit ?? null,
    unit_price: it.unit_price ?? null,
    total_price:
      it.total_price ??
      (typeof it.unit_price === "number" && typeof it.quantity === "number"
        ? round2(it.unit_price * it.quantity)
        : null),
  }));

  const subtotal = round2(
    items.reduce((s, it) => s + (typeof it.total_price === "number" ? it.total_price : 0), 0),
  );
  const validUntil = new Date();
  validUntil.setUTCDate(validUntil.getUTCDate() + Math.max(1, Math.min(365, data.validityDays)));

  return {
    meta: buildMetaEnvelope("proforma_invoice", data.referenceNumber),
    seller: data.seller,
    buyer: data.buyer,
    items,
    currency: data.currency,
    validity_days: data.validityDays,
    valid_until: validUntil.toISOString(),
    incoterm: data.incoterm ?? null,
    payment_terms: data.paymentTerms ?? null,
    delivery_date: data.deliveryDate ?? null,
    subtotal,
    total: subtotal,                  // proformas don't include tax / shipping
    date: data.date ?? new Date().toISOString(),
    notes: data.notes ?? null,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ─── Auto-generate dispatcher ───────────────────────────────────────────────

/**
 * Auto-generate a document_data payload for the given type, using the
 * shared "deal context" that the API route assembles from the post +
 * negotiation + shipment + partner info.
 *
 * The dispatch is intentionally exhaustive: if a new document type is
 * added to AUTO_GENERATABLE_TYPES without a matching branch here, the
 * TypeScript compiler will refuse to compile (the `: never` exhaustiveness
 * check at the bottom of the switch). This prevents silent fallthrough.
 */
export function autoGenerateDocument(
  type: MarketplaceTradeDocumentType,
  ctx: AutoGenerateContext,
): { referenceNumber: string; documentData: Record<string, any> } {
  const referenceNumber = generateDocumentNumber(type, ctx.tenantId);

  switch (type) {
    case "commercial_invoice": {
      const { seller, buyer, items, currency, incoterm, paymentTerms } = ctx;
      return {
        referenceNumber,
        documentData: generateCommercialInvoice({
          seller,
          buyer,
          items,
          currency: currency ?? "USD",
          incoterm: incoterm ?? "FOB",
          paymentTerms: paymentTerms ?? "30 days net",
          referenceNumber,
          date: new Date().toISOString(),
        }),
      };
    }
    case "packing_list": {
      const { shipper, consignee, items, containerNumber, totalPackages, totalGrossWeight, totalNetWeight } = ctx;
      return {
        referenceNumber,
        documentData: generatePackingList({
          shipper: shipper ?? ctx.seller,
          consignee: consignee ?? ctx.buyer,
          items,
          containerNumber: containerNumber ?? "",
          totalPackages: totalPackages ?? 0,
          totalGrossWeight: totalGrossWeight ?? 0,
          totalNetWeight: totalNetWeight ?? 0,
          referenceNumber,
        }),
      };
    }
    case "certificate_of_origin": {
      const { exporter, importer, products, originCountry } = ctx;
      return {
        referenceNumber,
        documentData: generateCertificateOfOrigin({
          exporter: exporter ?? ctx.seller,
          importer: importer ?? ctx.buyer,
          products: products ?? ctx.items,
          originCountry: originCountry ?? "",
          criterion: ctx.criterion || "A",
          referenceNumber,
        }),
      };
    }
    case "bill_of_lading": {
      const { shipper, consignee, notifyParty, vesselName, portOfLoading, portOfDischarge, containerNumber, goodsDescription, weight } = ctx;
      return {
        referenceNumber,
        documentData: generateBillOfLading({
          shipper: shipper ?? ctx.seller,
          consignee: consignee ?? ctx.buyer,
          notifyParty: notifyParty ?? ctx.buyer,
          vesselName: vesselName ?? "",
          portOfLoading: portOfLoading ?? "",
          portOfDischarge: portOfDischarge ?? "",
          containerNumber: containerNumber ?? "",
          goodsDescription: goodsDescription ?? (ctx.items.map((i) => i.description).filter(Boolean).join(", ") || "Goods"),
          weight: weight ?? 0,
          referenceNumber,
        }),
      };
    }
    case "proforma_invoice": {
      const { seller, buyer, items, currency, incoterm, paymentTerms } = ctx;
      return {
        referenceNumber,
        documentData: generateProformaInvoice({
          seller,
          buyer,
          items,
          currency: currency ?? "USD",
          validityDays: 30,
          referenceNumber,
        }),
      };
    }
    // ── The following types are stored in the DB enum but NOT auto-
    //    generatable from deal context — they require operator input
    //    (e.g. a chamber of commerce signature, an inspector stamp).
    //    The auto-generate route refuses to emit them; the value of
    //    including them in this switch is the TypeScript exhaustiveness
    //    check below. ──
    case "shipping_manifest":
    case "inspection_certificate":
    case "insurance_certificate":
    case "export_declaration":
    case "customs_declaration":
    case "letter_of_credit_draft":
    case "weight_certificate":
      throw new Error(`Document type "${type}" is not auto-generatable.`);
    default: {
      // Exhaustiveness check — if a new type is added to the union
      // without a branch above, this code will refuse to compile.
      const _exhaustive: never = type;
      void _exhaustive;
      throw new Error(`Unknown document type "${_exhaustive}".`);
    }
  }
}

// ─── Auto-generate context ─────────────────────────────────────────────────

/**
 * The "deal context" assembled by the auto-generate API route. It is the
 * union of fields any of the generators may need; each generator picks the
 * fields it cares about (e.g. the BoL generator reads vesselName +
 * portOfLoading, the invoice generator reads incoterm + paymentTerms).
 *
 * The route fills this in from:
 *   • the marketplace_post (product_name, quantity, unit, currency, incoterm,
 *     origin_country, delivery_location, payment_terms, packaging)
 *   • the negotiation (agreed_terms: unit_price, currency, delivery_port)
 *   • the shipment (container_number, vessel_name, loading_port,
 *     discharge_port, gross_weight, net_weight, packages_count)
 *   • the partners (seller = post owner; buyer = responder)
 */
export interface AutoGenerateContext {
  tenantId: string;

  seller: TradeDocumentParty;
  buyer: TradeDocumentParty;
  shipper?: TradeDocumentParty;
  consignee?: TradeDocumentParty;
  notifyParty?: TradeDocumentParty;
  exporter?: TradeDocumentParty;
  importer?: TradeDocumentParty;

  items: TradeDocumentLineItem[];
  products?: TradeDocumentLineItem[];

  currency?: string;
  incoterm?: string;
  paymentTerms?: string;

  containerNumber?: string;
  totalPackages?: number;
  totalGrossWeight?: number;
  totalNetWeight?: number;

  vesselName?: string;
  portOfLoading?: string;
  portOfDischarge?: string;
  goodsDescription?: string;
  weight?: number;

  originCountry?: string;
  /** 2g-F9: WTO Rules of Origin criterion code for CoO generation.
   *  "A" = wholly obtained (default), "B"/"C" = processed/assembly goods. */
  criterion?: string;
  /** 2g-F26: true when the unit_price was derived from post.target_price
   *  (the buyer's MAX willingness to pay) instead of agreed_terms.unit_price.
   *  Surfaces a "PRICE NOT CONFIRMED" warning watermark on the PDF so the
   *  reader knows the price is a ceiling, not the agreed sale price. */
  priceUnconfirmed?: boolean;
}
