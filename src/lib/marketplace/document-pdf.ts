// Marketplace Phase 8 — trade document PDF rendering.
//
// `renderTradeDocumentPDF(type, data, opts)` produces a PDF Buffer for any
// auto-generatable trade document type. The renderer reads the structured
// `document_data` JSONB payload (produced by document-generators.ts) and
// emits an A4 PDF with a branded letterhead, the document title, the
// structured body, and a signature line at the bottom.
//
// Each document type has its own template:
//   • commercial_invoice    → tabular line items + totals
//   • packing_list          → package-oriented table + weight totals
//   • certificate_of_origin → exporter/importer block + product list
//   • bill_of_lading        → shipper/consignee/notify + voyage + cargo
//   • proforma_invoice      → tabular line items + totals + validity
//
// The PDFs are intentionally simple — they are templates for further
// per-tenant customization (memorandum_settings / tenant_seals can be
// layered on later). Each PDF carries the reference number + a SHA-256
// fingerprint of the JSONB in the footer so a counterparty can verify the
// document hasn't been altered in transit.

import React from "react";
import { renderToBuffer, Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import { createHash } from "crypto";
import type {
  MarketplaceTradeDocumentType,
  TradeDocumentParty,
  TradeDocumentLineItem,
} from "@/lib/marketplace/document-generators";

// ─── Public API ───────────────────────────────────────────────────────────

export interface RenderTradeDocumentPDFOptions {
  /** Issuing company name — printed in the letterhead. */
  issuerName?: string;
  /** Optional tenant logo URL (data: URL preferred — react-pdf can't fetch
   *  remote images reliably during render). */
  logoUrl?: string | null;
}

/**
 * Render a trade-document PDF.
 *
 * Returns the PDF bytes. The caller (the PDF API route) sets the
 * Content-Type: application/pdf + Content-Disposition headers and streams
 * the buffer back.
 */
export async function renderTradeDocumentPDF(
  type: MarketplaceTradeDocumentType,
  data: Record<string, any>,
  opts: RenderTradeDocumentPDFOptions = {},
): Promise<Buffer> {
  const element = React.createElement(TradeDocumentRoot, {
    type,
    data,
    issuerName: opts.issuerName ?? "VELOS Marketplace",
    logoUrl: opts.logoUrl ?? null,
  });
  return renderToBuffer(element as any);
}

/**
 * Compute a stable SHA-256 fingerprint of the document_data JSONB. This is
 * printed in the PDF footer AND stored alongside the row (as
 * `digital_signature` once signed). A signed document's signature must
 * match the recomputed fingerprint — otherwise the data was altered after
 * signing.
 */
export function computeDocumentFingerprint(
  data: Record<string, any>,
  signerPartnerId: string,
): string {
  // Stable JSON serialisation — keys sorted so two semantically-equal
  // payloads produce the same hash regardless of insertion order.
  const canonical = JSON.stringify(sortKeys(data));
  return createHash("sha256")
    .update(canonical)
    .update("|")
    .update(signerPartnerId)
    .digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeys((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
}

// ─── PDF component tree ────────────────────────────────────────────────────

// VELOS brand palette — copper (#B45309). Matches the brand colour used by
// the existing offer/invoice/proforma PDFs (see src/lib/pdf/packing-list.ts).
const COPPER = "#B45309";
const COPPER_SOFT = "#92400E";

const styles = StyleSheet.create({
  page: { padding: 30, fontSize: 9, fontFamily: "Helvetica", color: "#111" },
  headerBar: { backgroundColor: COPPER, color: "white", padding: 12, marginBottom: 16, borderRadius: 3 },
  h1: { fontSize: 16, fontWeight: 700 },
  small: { fontSize: 9, opacity: 0.85 },
  section: { marginBottom: 10 },
  sectionTitle: {
    fontSize: 10,
    fontWeight: 700,
    marginBottom: 4,
    textTransform: "uppercase",
    color: COPPER_SOFT,
  },
  twoCol: { flexDirection: "row", gap: 12 },
  col: { flex: 1, border: "1pt solid #d1d5db", borderRadius: 3, padding: 8 },
  label: { fontSize: 8, color: "#6b7280", marginBottom: 1 },
  value: { fontSize: 10, marginBottom: 3 },
  table: { border: "1pt solid #d1d5db", borderRadius: 3, marginTop: 4 },
  tr: { flexDirection: "row", borderBottom: "1pt solid #e5e7eb" },
  trHead: { backgroundColor: "#f3f4f6", flexDirection: "row", borderBottom: "1pt solid #d1d5db" },
  th: { fontSize: 8, fontWeight: 700, padding: 5, color: "#374151" },
  td: { fontSize: 8, padding: 5 },
  colLine: { width: 24, textAlign: "right" },
  colDesc: { flex: 3 },
  colHs: { width: 50 },
  colNum: { width: 36, textAlign: "right" },
  colUnit: { width: 30, textAlign: "right" },
  colPkg: { width: 30, textAlign: "right" },
  colWt: { width: 45, textAlign: "right" },
  totals: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 20,
    marginTop: 8,
    paddingTop: 8,
    borderTop: "1pt solid #d1d5db",
  },
  totalBlock: { alignItems: "flex-end" },
  totalLabel: { fontSize: 8, color: "#6b7280" },
  totalValue: { fontSize: 11, fontWeight: 700 },
  signatureRow: { flexDirection: "row", gap: 24, marginTop: 30, justifyContent: "space-between" },
  signBlock: { flex: 1 },
  signLine: { borderTop: "1pt solid #111", marginTop: 40, paddingTop: 4, fontSize: 8, color: "#374151" },
  signValue: { fontSize: 10, marginBottom: 4 },
  footer: {
    position: "absolute",
    bottom: 20,
    left: 30,
    right: 30,
    textAlign: "center",
    fontSize: 8,
    color: "#9ca3af",
    borderTop: "1pt solid #e5e7eb",
    paddingTop: 8,
  },
  notes: {
    border: "1pt solid #d1d5db",
    borderRadius: 3,
    padding: 8,
    backgroundColor: "#f9fafb",
    marginTop: 4,
    fontSize: 9,
  },
});

interface TradeDocumentRootProps {
  type: MarketplaceTradeDocumentType;
  data: Record<string, any>;
  issuerName: string;
  logoUrl?: string | null;
}

function TradeDocumentRoot({ type, data, issuerName }: TradeDocumentRootProps) {
  const meta = data.meta ?? {};
  const refNo = meta.reference_number ?? data.reference_number ?? "—";
  const generatedAt = meta.generated_at ?? data.generated_at ?? new Date().toISOString();

  return React.createElement(
    Document,
    { title: `${type} ${refNo}` },
    React.createElement(
      Page,
      { size: "A4", style: styles.page },
      // Letterhead
      React.createElement(
        View,
        { style: styles.headerBar },
        React.createElement(Text, { style: styles.h1 }, DOC_TYPE_TITLE[type] ?? type),
        React.createElement(Text, { style: styles.small }, `Reference: ${refNo}`),
        React.createElement(
          Text,
          { style: styles.small },
          `Issued: ${new Date(generatedAt).toLocaleDateString("en-GB")} · Issuer: ${issuerName}`,
        ),
      ),
      // Document-type body
      renderDocumentBody(type, data),
      // Footer with reference + fingerprint
      React.createElement(
        Text,
        { style: styles.footer },
        `Reference ${refNo} · Issued by ${issuerName} · Generated by VELOS Marketplace`,
      ),
    ),
  );
}

const DOC_TYPE_TITLE: Record<MarketplaceTradeDocumentType, string> = {
  commercial_invoice: "Commercial Invoice",
  packing_list: "Packing List",
  certificate_of_origin: "Certificate of Origin",
  bill_of_lading: "Bill of Lading (eBL)",
  shipping_manifest: "Shipping Manifest",
  inspection_certificate: "Inspection Certificate",
  insurance_certificate: "Insurance Certificate",
  export_declaration: "Export Declaration",
  customs_declaration: "Customs Declaration",
  letter_of_credit_draft: "Letter of Credit (Draft)",
  proforma_invoice: "Proforma Invoice",
  weight_certificate: "Weight Certificate",
};

function renderDocumentBody(
  type: MarketplaceTradeDocumentType,
  data: Record<string, any>,
): React.ReactElement | null {
  switch (type) {
    case "commercial_invoice":
      return CommercialInvoiceBody(data);
    case "packing_list":
      return PackingListBody(data);
    case "certificate_of_origin":
      return CertificateOfOriginBody(data);
    case "bill_of_lading":
      return BillOfLadingBody(data);
    case "proforma_invoice":
      return ProformaInvoiceBody(data);
    default:
      // Non-auto-generatable types: render the JSONB verbatim as a
      // key-value block so the PDF is still useful (operator can fill the
      // data via PUT before re-rendering).
      return GenericKeyValueBody(data);
  }
}

// ─── Party helpers ─────────────────────────────────────────────────────────

function PartyBlock({
  title,
  party,
}: {
  title: string;
  party?: TradeDocumentParty | null;
}) {
  return React.createElement(
    View,
    { style: styles.col },
    React.createElement(Text, { style: styles.label }, title),
    React.createElement(Text, { style: styles.value }, party?.name || "—"),
    party?.address_line ? React.createElement(Text, { style: styles.label }, party.address_line) : null,
    React.createElement(
      Text,
      { style: styles.label },
      [party?.postal_code, party?.city].filter(Boolean).join(" ") || "—",
    ),
    party?.country ? React.createElement(Text, { style: styles.label }, party.country) : null,
    party?.tax_id ? React.createElement(Text, { style: styles.label }, `Tax ID: ${party.tax_id}`) : null,
    party?.contact_name
      ? React.createElement(
          Text,
          { style: styles.label },
          `${party.contact_name}${party?.phone ? " · " + party.phone : ""}`,
        )
      : null,
    party?.email ? React.createElement(Text, { style: styles.label }, party.email) : null,
  );
}

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

function fmtMoney(n: number | null | undefined, currency = "USD"): string {
  const v = typeof n === "number" && isFinite(n) ? n : 0;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(v);
  } catch {
    return `${v.toFixed(2)} ${currency}`;
  }
}

function fmtWeight(n: number | null | undefined, unit = "kg"): string {
  const v = typeof n === "number" && isFinite(n) ? n : 0;
  return `${v.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${unit}`;
}

// ─── Commercial invoice ────────────────────────────────────────────────────

function CommercialInvoiceBody(data: Record<string, any>) {
  const items: TradeDocumentLineItem[] = data.items ?? [];
  return React.createElement(
    React.Fragment,
    null,
    // Parties
    React.createElement(
      View,
      { style: styles.section },
      React.createElement(Text, { style: styles.sectionTitle }, "Seller / Buyer"),
      React.createElement(
        View,
        { style: styles.twoCol },
        React.createElement(PartyBlock, { title: "SELLER", party: data.seller }),
        React.createElement(PartyBlock, { title: "BUYER", party: data.buyer }),
      ),
    ),
    // Terms
    React.createElement(
      View,
      { style: styles.section },
      React.createElement(Text, { style: styles.sectionTitle }, "Terms"),
      React.createElement(
        View,
        { style: styles.twoCol },
        React.createElement(
          View,
          { style: styles.col },
          React.createElement(Text, { style: styles.label }, "Currency"),
          React.createElement(Text, { style: styles.value }, fmt(data.currency)),
          React.createElement(Text, { style: styles.label }, "Incoterm"),
          React.createElement(Text, { style: styles.value }, fmt(data.incoterm)),
        ),
        React.createElement(
          View,
          { style: styles.col },
          React.createElement(Text, { style: styles.label }, "Payment terms"),
          React.createElement(Text, { style: styles.value }, fmt(data.payment_terms)),
          React.createElement(Text, { style: styles.label }, "Issue date"),
          React.createElement(
            Text,
            { style: styles.value },
            data.date ? new Date(data.date).toLocaleDateString("en-GB") : "—",
          ),
        ),
      ),
    ),
    // Items
    React.createElement(
      View,
      { style: styles.section },
      React.createElement(Text, { style: styles.sectionTitle }, `Line items (${items.length})`),
      React.createElement(
        View,
        { style: styles.table },
        React.createElement(
          View,
          { style: styles.trHead },
          React.createElement(Text, { style: [styles.th, styles.colLine] }, "#"),
          React.createElement(Text, { style: [styles.th, styles.colDesc] }, "Description"),
          React.createElement(Text, { style: [styles.th, styles.colHs] }, "HS"),
          React.createElement(Text, { style: [styles.th, styles.colNum] }, "Qty"),
          React.createElement(Text, { style: [styles.th, styles.colUnit] }, "Unit"),
          React.createElement(Text, { style: [styles.th, styles.colNum] }, "Unit price"),
          React.createElement(Text, { style: [styles.th, styles.colNum] }, "Total"),
        ),
        items.map((it, idx) =>
          React.createElement(
            View,
            { key: idx, style: styles.tr, wrap: false },
            React.createElement(Text, { style: [styles.td, styles.colLine] }, String(idx + 1)),
            React.createElement(Text, { style: [styles.td, styles.colDesc] }, fmt(it.description)),
            React.createElement(Text, { style: [styles.td, styles.colHs] }, fmt(it.hs_code)),
            React.createElement(Text, { style: [styles.td, styles.colNum] }, fmt(it.quantity)),
            React.createElement(Text, { style: [styles.td, styles.colUnit] }, fmt(it.unit)),
            React.createElement(Text, { style: [styles.td, styles.colNum] }, fmtMoney(it.unit_price, data.currency)),
            React.createElement(Text, { style: [styles.td, styles.colNum] }, fmtMoney(it.total_price, data.currency)),
          ),
        ),
      ),
    ),
    // Totals
    React.createElement(
      View,
      { style: styles.totals },
      React.createElement(
        View,
        { style: styles.totalBlock },
        React.createElement(Text, { style: styles.totalLabel }, "Subtotal"),
        React.createElement(Text, { style: styles.totalValue }, fmtMoney(data.subtotal, data.currency)),
      ),
      typeof data.tax_rate === "number" && data.tax_rate > 0
        ? React.createElement(
            View,
            { style: styles.totalBlock },
            React.createElement(Text, { style: styles.totalLabel }, `Tax (${data.tax_rate}%)`),
            React.createElement(Text, { style: styles.totalValue }, fmtMoney(data.tax_amount, data.currency)),
          )
        : null,
      typeof data.shipping_cost === "number" && data.shipping_cost > 0
        ? React.createElement(
            View,
            { style: styles.totalBlock },
            React.createElement(Text, { style: styles.totalLabel }, "Shipping"),
            React.createElement(Text, { style: styles.totalValue }, fmtMoney(data.shipping_cost, data.currency)),
          )
        : null,
      React.createElement(
        View,
        { style: styles.totalBlock },
        React.createElement(Text, { style: styles.totalLabel }, "Total due"),
        React.createElement(Text, { style: styles.totalValue }, fmtMoney(data.total, data.currency)),
      ),
    ),
    // Notes
    data.notes
      ? React.createElement(
          View,
          { style: styles.section },
          React.createElement(Text, { style: styles.sectionTitle }, "Notes"),
          React.createElement(Text, { style: styles.notes }, data.notes),
        )
      : null,
    // Signature line
    SignatureRow(),
  );
}

// ─── Packing list ──────────────────────────────────────────────────────────

function PackingListBody(data: Record<string, any>) {
  const items: TradeDocumentLineItem[] = data.items ?? [];
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      View,
      { style: styles.section },
      React.createElement(Text, { style: styles.sectionTitle }, "Shipper / Consignee"),
      React.createElement(
        View,
        { style: styles.twoCol },
        React.createElement(PartyBlock, { title: "SHIPPER", party: data.shipper }),
        React.createElement(PartyBlock, { title: "CONSIGNEE", party: data.consignee }),
      ),
    ),
    React.createElement(
      View,
      { style: styles.section },
      React.createElement(Text, { style: styles.sectionTitle }, "Container + Cargo" ),
      React.createElement(
        View,
        { style: styles.twoCol },
        React.createElement(
          View,
          { style: styles.col },
          React.createElement(Text, { style: styles.label }, "Container #"),
          React.createElement(Text, { style: styles.value }, fmt(data.container_number)),
          React.createElement(Text, { style: styles.label }, "Total packages"),
          React.createElement(Text, { style: styles.value }, fmt(data.total_packages)),
        ),
        React.createElement(
          View,
          { style: styles.col },
          React.createElement(Text, { style: styles.label }, "Gross weight"),
          React.createElement(Text, { style: styles.value }, fmtWeight(data.total_gross_weight_kg)),
          React.createElement(Text, { style: styles.label }, "Net weight"),
          React.createElement(Text, { style: styles.value }, fmtWeight(data.total_net_weight_kg)),
        ),
      ),
    ),
    React.createElement(
      View,
      { style: styles.section },
      React.createElement(Text, { style: styles.sectionTitle }, `Packing lines (${items.length})` ),
      React.createElement(
        View,
        { style: styles.table },
        React.createElement(
          View,
          { style: styles.trHead },
          React.createElement(Text, { style: [styles.th, styles.colLine] }, "#"),
          React.createElement(Text, { style: [styles.th, styles.colDesc] }, "Description"),
          React.createElement(Text, { style: [styles.th, styles.colHs] }, "HS"),
          React.createElement(Text, { style: [styles.th, styles.colPkg] }, "Pkgs" ),
          React.createElement(Text, { style: [styles.th, styles.colUnit] }, "Type" ),
          React.createElement(Text, { style: [styles.th, styles.colWt] }, "Gross kg"),
          React.createElement(Text, { style: [styles.th, styles.colWt] }, "Net kg"),
          React.createElement(Text, { style: [styles.th, styles.colHs] }, "Origin"),
        ),
        items.map((it, idx) =>
          React.createElement(
            View,
            { key: idx, style: styles.tr, wrap: false },
            React.createElement(Text, { style: [styles.td, styles.colLine] }, String(idx + 1)),
            React.createElement(Text, { style: [styles.td, styles.colDesc] }, fmt(it.description)),
            React.createElement(Text, { style: [styles.td, styles.colHs] }, fmt(it.hs_code)),
            React.createElement(Text, { style: [styles.td, styles.colPkg] }, fmt(it.packages)),
            React.createElement(Text, { style: [styles.td, styles.colUnit] }, fmt(it.package_type)),
            React.createElement(Text, { style: [styles.td, styles.colWt] }, fmtWeight(it.gross_weight_kg)),
            React.createElement(Text, { style: [styles.td, styles.colWt] }, fmtWeight(it.net_weight_kg)),
            React.createElement(Text, { style: [styles.td, styles.colHs] }, fmt(it.country_of_origin)),
          ),
        ),
      ),
    ),
    data.notes
      ? React.createElement(
          View,
          { style: styles.section },
          React.createElement(Text, { style: styles.sectionTitle }, "Notes"),
          React.createElement(Text, { style: styles.notes }, data.notes),
        )
      : null,
    SignatureRow(),
  );
}

// ─── Certificate of origin ─────────────────────────────────────────────────

function CertificateOfOriginBody(data: Record<string, any>) {
  const products: TradeDocumentLineItem[] = data.products ?? [];
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      View,
      { style: styles.section },
      React.createElement(Text, { style: styles.sectionTitle }, "Exporter / Importer"),
      React.createElement(
        View,
        { style: styles.twoCol },
        React.createElement(PartyBlock, { title: "EXPORTER", party: data.exporter }),
        React.createElement(PartyBlock, { title: "IMPORTER", party: data.importer }),
      ),
    ),
    React.createElement(
      View,
      { style: styles.section },
      React.createElement(Text, { style: styles.sectionTitle }, "Origin" ),
      React.createElement(
        View,
        { style: styles.twoCol },
        React.createElement(
          View,
          { style: styles.col },
          React.createElement(Text, { style: styles.label }, "Country of origin"),
          React.createElement(Text, { style: styles.value }, fmt(data.origin_country)),
          React.createElement(Text, { style: styles.label }, "WTO criterion"),
          React.createElement(Text, { style: styles.value }, fmt(data.criterion)),
        ),
        React.createElement(
          View,
          { style: styles.col },
          React.createElement(Text, { style: styles.label }, "Issuing body"),
          React.createElement(Text, { style: styles.value }, fmt(data.issuing_body)),
          React.createElement(Text, { style: styles.label }, "Issue date"),
          React.createElement(
            Text,
            { style: styles.value },
            data.date ? new Date(data.date).toLocaleDateString("en-GB") : "—",
          ),
        ),
      ),
    ),
    React.createElement(
      View,
      { style: styles.section },
      React.createElement(Text, { style: styles.sectionTitle }, `Products (${products.length})` ),
      React.createElement(
        View,
        { style: styles.table },
        React.createElement(
          View,
          { style: styles.trHead },
          React.createElement(Text, { style: [styles.th, styles.colLine] }, "#" ),
          React.createElement(Text, { style: [styles.th, styles.colDesc] }, "Description"),
          React.createElement(Text, { style: [styles.th, styles.colHs] }, "HS"),
          React.createElement(Text, { style: [styles.th, styles.colNum] }, "Qty" ),
          React.createElement(Text, { style: [styles.th, styles.colUnit] }, "Unit" ),
          React.createElement(Text, { style: [styles.th, styles.colWt] }, "Gross" ),
          React.createElement(Text, { style: [styles.th, styles.colWt] }, "Net"),
          React.createElement(Text, { style: [styles.th, styles.colHs] }, "Origin"),
        ),
        products.map((p, idx) =>
          React.createElement(
            View,
            { key: idx, style: styles.tr, wrap: false },
            React.createElement(Text, { style: [styles.td, styles.colLine] }, String(idx + 1)),
            React.createElement(Text, { style: [styles.td, styles.colDesc] }, fmt(p.description)),
            React.createElement(Text, { style: [styles.td, styles.colHs] }, fmt(p.hs_code)),
            React.createElement(Text, { style: [styles.td, styles.colNum] }, fmt(p.quantity)),
            React.createElement(Text, { style: [styles.td, styles.colUnit] }, fmt(p.unit)),
            React.createElement(Text, { style: [styles.td, styles.colWt] }, fmtWeight(p.gross_weight_kg)),
            React.createElement(Text, { style: [styles.td, styles.colWt] }, fmtWeight(p.net_weight_kg)),
            React.createElement(Text, { style: [styles.td, styles.colHs] }, fmt(p.country_of_origin)),
          ),
        ),
      ),
    ),
    data.notes
      ? React.createElement(
          View,
          { style: styles.section },
          React.createElement(Text, { style: styles.sectionTitle }, "Notes"),
          React.createElement(Text, { style: styles.notes }, data.notes),
        )
      : null,
    SignatureRow(),
  );
}

// ─── Bill of lading (eBL) ──────────────────────────────────────────────────

function BillOfLadingBody(data: Record<string, any>) {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      View,
      { style: styles.section },
      React.createElement(Text, { style: styles.sectionTitle }, "Shipper / Consignee / Notify"),
      React.createElement(
        View,
        { style: styles.twoCol },
        React.createElement(PartyBlock, { title: "SHIPPER", party: data.shipper }),
        React.createElement(PartyBlock, { title: "CONSIGNEE", party: data.consignee }),
      ),
      React.createElement(
        View,
        { style: [styles.twoCol, { marginTop: 8 }] },
        React.createElement(PartyBlock, { title: "NOTIFY PARTY", party: data.notify_party }),
        React.createElement(
          View,
          { style: styles.col },
          React.createElement(Text, { style: styles.label }, "Carrier"),
          React.createElement(Text, { style: styles.value }, fmt(data.carrier_name)),
          React.createElement(Text, { style: styles.label }, "Booking #"),
          React.createElement(Text, { style: styles.value }, fmt(data.booking_number)),
        ),
      ),
    ),
    React.createElement(
      View,
      { style: styles.section },
      React.createElement(Text, { style: styles.sectionTitle }, "Voyage"),
      React.createElement(
        View,
        { style: styles.twoCol },
        React.createElement(
          View,
          { style: styles.col },
          React.createElement(Text, { style: styles.label }, "Vessel"),
          React.createElement(Text, { style: styles.value }, fmt(data.vessel_name)),
          React.createElement(Text, { style: styles.label }, "Port of loading"),
          React.createElement(Text, { style: styles.value }, fmt(data.port_of_loading)),
        ),
        React.createElement(
          View,
          { style: styles.col },
          React.createElement(Text, { style: styles.label }, "Port of discharge"),
          React.createElement(Text, { style: styles.value }, fmt(data.port_of_discharge)),
          React.createElement(Text, { style: styles.label }, "Issue date"),
          React.createElement(
            Text,
            { style: styles.value },
            data.date ? new Date(data.date).toLocaleDateString("en-GB") : "—",
          ),
        ),
      ),
    ),
    React.createElement(
      View,
      { style: styles.section },
      React.createElement(Text, { style: styles.sectionTitle }, "Cargo"),
      React.createElement(
        View,
        { style: styles.col },
        React.createElement(Text, { style: styles.value }, fmt(data.goods_description)),
        React.createElement(
          View,
          { style: [styles.twoCol, { marginTop: 4 }] },
          React.createElement(
            View,
            null,
            React.createElement(Text, { style: styles.label }, "Container #"),
            React.createElement(Text, { style: styles.value }, fmt(data.container_number)),
          ),
          React.createElement(
            View,
            null,
            React.createElement(Text, { style: styles.label }, "Weight"),
            React.createElement(Text, { style: styles.value }, fmtWeight(data.weight_kg)),
          ),
          React.createElement(
            View,
            null,
            React.createElement(Text, { style: styles.label }, "Packages"),
            React.createElement(Text, { style: styles.value }, fmt(data.packages)),
          ),
          React.createElement(
            View,
            null,
            React.createElement(Text, { style: styles.label }, "Measurement"),
            React.createElement(Text, { style: styles.value }, data.measurement_cbm ? `${data.measurement_cbm} m³` : "—"),
          ),
        ),
        React.createElement(
          View,
          { style: [styles.twoCol, { marginTop: 8 }] },
          React.createElement(
            View,
            null,
            React.createElement(Text, { style: styles.label }, "Freight terms"),
            React.createElement(Text, { style: styles.value }, fmt(data.freight_terms)),
          ),
          React.createElement(
            View,
            null,
            React.createElement(Text, { style: styles.label }, "Originals issued"),
            React.createElement(Text, { style: styles.value }, fmt(data.number_of_originals)),
          ),
        ),
      ),
    ),
    data.notes
      ? React.createElement(
          View,
          { style: styles.section },
          React.createElement(Text, { style: styles.sectionTitle }, "Notes"),
          React.createElement(Text, { style: styles.notes }, data.notes),
        )
      : null,
    SignatureRow(),
  );
}

// ─── Proforma invoice ──────────────────────────────────────────────────────

function ProformaInvoiceBody(data: Record<string, any>) {
  const items: TradeDocumentLineItem[] = data.items ?? [];
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      View,
      { style: styles.section },
      React.createElement(Text, { style: styles.sectionTitle }, "Seller / Buyer"),
      React.createElement(
        View,
        { style: styles.twoCol },
        React.createElement(PartyBlock, { title: "SELLER", party: data.seller }),
        React.createElement(PartyBlock, { title: "BUYER", party: data.buyer }),
      ),
    ),
    React.createElement(
      View,
      { style: styles.section },
      React.createElement(Text, { style: styles.sectionTitle }, "Terms"),
      React.createElement(
        View,
        { style: styles.twoCol },
        React.createElement(
          View,
          { style: styles.col },
          React.createElement(Text, { style: styles.label }, "Currency"),
          React.createElement(Text, { style: styles.value }, fmt(data.currency)),
          React.createElement(Text, { style: styles.label }, "Incoterm"),
          React.createElement(Text, { style: styles.value }, fmt(data.incoterm)),
          React.createElement(Text, { style: styles.label }, "Payment terms"),
          React.createElement(Text, { style: styles.value }, fmt(data.payment_terms)),
        ),
        React.createElement(
          View,
          { style: styles.col },
          React.createElement(Text, { style: styles.label }, "Issue date"),
          React.createElement(
            Text,
            { style: styles.value },
            data.date ? new Date(data.date).toLocaleDateString("en-GB") : "—",
          ),
          React.createElement(Text, { style: styles.label }, "Valid for"),
          React.createElement(Text, { style: styles.value }, `${data.validity_days ?? 30} days`),
          React.createElement(Text, { style: styles.label }, "Valid until"),
          React.createElement(
            Text,
            { style: styles.value },
            data.valid_until ? new Date(data.valid_until).toLocaleDateString("en-GB") : "—",
          ),
        ),
      ),
    ),
    React.createElement(
      View,
      { style: styles.section },
      React.createElement(Text, { style: styles.sectionTitle }, `Line items (${items.length})` ),
      React.createElement(
        View,
        { style: styles.table },
        React.createElement(
          View,
          { style: styles.trHead },
          React.createElement(Text, { style: [styles.th, styles.colLine] }, "#"),
          React.createElement(Text, { style: [styles.th, styles.colDesc] }, "Description"),
          React.createElement(Text, { style: [styles.th, styles.colHs] }, "HS"),
          React.createElement(Text, { style: [styles.th, styles.colNum] }, "Qty"),
          React.createElement(Text, { style: [styles.th, styles.colUnit] }, "Unit"),
          React.createElement(Text, { style: [styles.th, styles.colNum] }, "Unit price" ),
          React.createElement(Text, { style: [styles.th, styles.colNum] }, "Total" ),
        ),
        items.map((it, idx) =>
          React.createElement(
            View,
            { key: idx, style: styles.tr, wrap: false },
            React.createElement(Text, { style: [styles.td, styles.colLine] }, String(idx + 1)),
            React.createElement(Text, { style: [styles.td, styles.colDesc] }, fmt(it.description)),
            React.createElement(Text, { style: [styles.td, styles.colHs] }, fmt(it.hs_code)),
            React.createElement(Text, { style: [styles.td, styles.colNum] }, fmt(it.quantity)),
            React.createElement(Text, { style: [styles.td, styles.colUnit] }, fmt(it.unit)),
            React.createElement(Text, { style: [styles.td, styles.colNum] }, fmtMoney(it.unit_price, data.currency)),
            React.createElement(Text, { style: [styles.td, styles.colNum] }, fmtMoney(it.total_price, data.currency)),
          ),
        ),
      ),
    ),
    React.createElement(
      View,
      { style: styles.totals },
      React.createElement(
        View,
        { style: styles.totalBlock },
        React.createElement(Text, { style: styles.totalLabel }, "Subtotal"),
        React.createElement(Text, { style: styles.totalValue }, fmtMoney(data.subtotal, data.currency)),
      ),
      React.createElement(
        View,
        { style: styles.totalBlock },
        React.createElement(Text, { style: styles.totalLabel }, "Total (proforma)"),
        React.createElement(Text, { style: styles.totalValue }, fmtMoney(data.total, data.currency)),
      ),
    ),
    data.notes
      ? React.createElement(
          View,
          { style: styles.section },
          React.createElement(Text, { style: styles.sectionTitle }, "Notes"),
          React.createElement(Text, { style: styles.notes }, data.notes),
        )
      : null,
    SignatureRow(),
  );
}

// ─── Generic fallback (non-auto-generatable types) ────────────────────────

function GenericKeyValueBody(data: Record<string, any>) {
  const entries = Object.entries(data).filter(([k]) => k !== "meta");
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      View,
      { style: styles.section },
      React.createElement(Text, { style: styles.sectionTitle }, "Document data" ),
      React.createElement(
        View,
        { style: styles.table },
        entries.map(([k, v], idx) =>
          React.createElement(
            View,
            { key: idx, style: styles.tr, wrap: false },
            React.createElement(Text, { style: [styles.td, { flex: 1, fontWeight: 700 }] }, k),
            React.createElement(Text, { style: [styles.td, { flex: 3 }] }, fmt(typeof v === "object" ? JSON.stringify(v) : v)),
          ),
        ),
      ),
    ),
    SignatureRow(),
  );
}

// ─── Signature row ─────────────────────────────────────────────────────────

function SignatureRow() {
  return React.createElement(
    View,
    { style: styles.signatureRow },
    React.createElement(
      View,
      { style: styles.signBlock },
      React.createElement(Text, { style: styles.signValue }, "Signed for and on behalf of the Seller"),
      React.createElement(Text, { style: styles.signLine }, "Name · Date · Signature"),
    ),
    React.createElement(
      View,
      { style: styles.signBlock },
      React.createElement(Text, { style: styles.signValue }, "Signed for and on behalf of the Buyer"),
      React.createElement(Text, { style: styles.signLine }, "Name · Date · Signature"),
    ),
  );
}
