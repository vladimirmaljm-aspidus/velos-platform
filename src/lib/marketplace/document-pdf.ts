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
import { renderToBuffer, Document, Page, Text, View, Image, StyleSheet } from "@react-pdf/renderer";
import { createHash } from "crypto";
import type {
  MarketplaceTradeDocumentType,
  TradeDocumentParty,
  TradeDocumentLineItem,
} from "@/lib/marketplace/document-generators";
// audit12: shared helpers + components (fmtValue, fmtMoney, fmtWeight,
// Watermark, marketplaceWatermarkText, base styles) live in
// @/lib/pdf/shared.ts — single source of truth shared with templates.tsx
// and packing-list.ts. The COPPER palette and the 40-line base StyleSheet
// previously copy-pasted here were removed.
import {
  fmtValue as fmt,
  fmtQty,
  fmtMoney,
  fmtWeight,
  Watermark,
  marketplaceWatermarkText,
  remainingAddressParts,
  createBaseStyles,
} from "@/lib/pdf/shared";

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

// audit12: base styles (page / headerBar / sections / tables / totals /
// notes) come from @/lib/pdf/shared.ts. Only marketplace-specific styles
// (signature rows, reverse-charge legend, column widths, fixed footer)
// remain local.
const base = createBaseStyles();

const styles = StyleSheet.create({
  ...base,
  colLine: { width: 24, textAlign: "right" },
  colDesc: { flex: 3 },
  colHs: { width: 50 },
  colNum: { width: 36, textAlign: "right" },
  colUnit: { width: 30, textAlign: "right" },
  colPkg: { width: 30, textAlign: "right" },
  colWt: { width: 45, textAlign: "right" },
  signatureRow: { flexDirection: "row", gap: 24, marginTop: 30, justifyContent: "space-between" },
  signBlock: { flex: 1 },
  signLine: { borderTop: "1pt solid #111", marginTop: 40, paddingTop: 4, fontSize: 8, color: "#374151" },
  signValue: { fontSize: 10, marginBottom: 4 },
  // 2h-F6 fix (round 4): a `fixed` View variant of the footer so it repeats
  // on every page. The lead-in + render-prop page-number Text children are
  // inlined by TradeDocumentRoot. audit12: packing-list.ts now uses the
  // same footerFixed structure — the two templates are pixel-identical.
  footerFixed: {
    position: "absolute",
    bottom: 20,
    left: 30,
    right: 30,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    fontSize: 8,
    color: "#9ca3af",
    borderTop: "1pt solid #e5e7eb",
    paddingTop: 8,
    gap: 4,
  },
  // 2h-F2 fix (round 4): reverse-charge legend for marketplace commercial
  // invoices with tax_rate=0 (B2B cross-border). The legend lives in a
  // totals-row so it visually substitutes for the missing Tax line.
  // audit12: full-width reverse-charge legend row (rendered right after the
  // totals section, right-aligned — no longer a squeezed flex child).
  reverseChargeRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingTop: 2,
    paddingBottom: 2,
  },
  reverseChargeText: {
    fontSize: 8,
    color: "#6b7280",
    fontStyle: "italic",
  },
  // audit20 / 20-d2 — issuer logo in the header bar. When a logo is present
  // the headerBar becomes a row: [title/meta column flex:1] + [logo on the
  // right]; without one the header renders exactly as before (single
  // column, no empty gap where the logo would sit).
  headerBarRow: { flexDirection: "row", alignItems: "center" },
  headerBarTitle: { flex: 1, flexDirection: "column" },
  headerLogoWrap: { flexDirection: "column", justifyContent: "center", alignItems: "flex-end", marginLeft: 12 },
  // objectFit "contain" is the key — it preserves aspect ratio inside the
  // 110×36pt bounding box (react-pdf needs an explicit height).
  headerLogo: { width: 110, height: 36, objectFit: "contain" },
});

interface TradeDocumentRootProps {
  type: MarketplaceTradeDocumentType;
  data: Record<string, any>;
  issuerName: string;
  logoUrl?: string | null;
}

/**
 * audit20 / 20-d2 — build the issuer logo element for the header bar.
 *
 * opts.logoUrl was accepted since Phase 8 but never destructured/rendered —
 * marketplace PDFs could never show a logo. Only data: URLs are rendered:
 * @react-pdf/renderer has no error boundary around <Image>, so a remote URL
 * that 404s / returns a non-image would throw and take the ENTIRE document
 * render down. The PDF route resolves the tenant logo to a data: URL before
 * calling renderTradeDocumentPDF (the same contract as generator.ts's
 * resolveLogoUrl for offer/invoice/proforma/LOI PDFs). Anything else
 * arriving here is skipped with a log — the document renders with the
 * no-logo layout instead of failing.
 */
function headerLogo(logoUrl: string | null | undefined): React.ReactElement | null {
  if (!logoUrl) return null;
  if (!logoUrl.startsWith("data:")) {
    console.warn(
      "[document-pdf] logoUrl is not a data: URL — skipping logo (resolve remote URLs to data: URLs in the route before rendering)",
    );
    return null;
  }
  return React.createElement(
    View,
    { style: styles.headerLogoWrap },
    React.createElement(Image, { style: styles.headerLogo, src: logoUrl }),
  );
}

/**
 * audit20 / 20-d2 — the letterhead header bar. With a resolvable logo the
 * bar is a row: [title/meta column flex:1] + [logo on the right]. Without
 * one it renders exactly as before — the three texts as direct children of
 * the copper headerBar (no layout change, no empty gap where the logo
 * would sit), so default output stays identical.
 */
function letterheadHeader(
  type: MarketplaceTradeDocumentType,
  refNo: string,
  issuerName: string,
  generatedAt: string,
  logoUrl: string | null | undefined,
): React.ReactElement {
  const headerTexts = [
    React.createElement(Text, { style: styles.h1 }, DOC_TYPE_TITLE[type] ?? type),
    React.createElement(Text, { style: styles.small }, `Reference: ${refNo}`),
    React.createElement(
      Text,
      { style: styles.small },
      `Issued: ${new Date(generatedAt).toLocaleDateString("en-GB")} · Issuer: ${issuerName}`,
    ),
  ];
  const logoElement = headerLogo(logoUrl);
  return React.createElement(
    View,
    { style: logoElement ? [styles.headerBar, styles.headerBarRow] : styles.headerBar },
    ...(logoElement
      ? [React.createElement(View, { style: styles.headerBarTitle }, ...headerTexts), logoElement]
      : headerTexts),
  );
}

function TradeDocumentRoot({ type, data, issuerName, logoUrl }: TradeDocumentRootProps) {
  const meta = data.meta ?? {};
  const refNo = meta.reference_number ?? data.reference_number ?? "—";
  const generatedAt = meta.generated_at ?? data.generated_at ?? new Date().toISOString();

  // 2g-F2 fix (round 4): status watermark. Marketplace trade documents have
  // a `status` field on the parent row (draft/generated/sent/signed/rejected).
  // Stamp DRAFT / REJECTED / SENT / SIGNED on every page so the document's
  // standing is unmissable (a draft commercial invoice should NOT be
  // presented to a bank for L/C issuance — without the watermark a draft
  // looks identical to a signed original). audit12: the status resolution
  // moved to shared.ts (marketplaceWatermarkText) so all templates share it.
  const watermarkText = marketplaceWatermarkText(data.status || data.meta?.status);

  // 2g-F23 fix (round 4): compute the document fingerprint (SHA-256 over
  // the JSONB) and surface it in the footer so a counterparty can verify
  // the document hasn't been altered in transit. We compute the fingerprint
  // over the sorted-key canonical JSON of the data — `computeDocumentFingerprint`
  // requires a signer_partner_id (it's used for the SIGNED path); the
  // unsigned footer fingerprint just uses the data alone so the value
  // stays stable across renders that produce identical data.
  const canonical = JSON.stringify(sortKeys(data));
  const fingerprint = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;

  return React.createElement(
    Document,
    { title: `${type} ${refNo}` },
    React.createElement(
      Page,
      { size: "A4", style: styles.page },
      // 2g-F2 fix (round 4): status watermark — always rendered (empty string
      // when no status) so the `fixed` prop is preserved across all pages.
      // audit12: uses the shared <Watermark /> component — pixel-identical to
      // the memorandum and packing-list templates (previously this one used
      // opacity 0.10 while the others used 0.12).
      React.createElement(Watermark, { text: watermarkText }),
      // Letterhead
      // audit20 / 20-d2 — issuer logo support: with a logo the header bar
      // is a row (title/meta column + logo); without one it renders
      // exactly as before. See letterheadHeader / headerLogo above.
      letterheadHeader(type, refNo, issuerName, generatedAt, logoUrl),
      // Document-type body
      renderDocumentBody(type, data),
      // 2h-F6 fix (round 4): footer wrapped in a `fixed` View so it repeats
      // on every page (was a single <Text> without `fixed`, which appears
      // only on page 1 of multi-page marketplace PDFs).
      // 2g-F4 fix (round 4): real "Page X of Y" via react-pdf render prop.
      // 2g-F23 fix (round 4): show the document fingerprint (SHA-256) so
      // the counterparty can compare against the value supplied out-of-band.
      React.createElement(
        View,
        { style: styles.footerFixed, fixed: true },
        React.createElement(Text, { style: { fontSize: 8, color: "#9ca3af" } }, `Reference ${refNo} · Issued by ${issuerName} · ${fingerprint.slice(0, 24)}… · Page `),
        React.createElement(Text, { style: { fontSize: 8, color: "#9ca3af" }, render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) => `${pageNumber} of ${totalPages}` }),
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
  // audit13: dedup — only show the postal/city/country parts the free-text
  // address line doesn't already mention (aliases like "UAE" count).
  const rest = remainingAddressParts(party?.address_line, {
    postal: party?.postal_code,
    city: party?.city,
    country: party?.country,
  });
  return React.createElement(
    View,
    { style: styles.col },
    React.createElement(Text, { style: styles.label }, title),
    React.createElement(Text, { style: styles.value }, party?.name || "—"),
    party?.address_line ? React.createElement(Text, { style: styles.label }, party.address_line) : null,
    rest ? React.createElement(Text, { style: styles.label }, rest) : null,
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
            React.createElement(Text, { style: [styles.td, styles.colNum] }, fmtQty(it.quantity)),
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
    // 2h-F2 fix (round 4): when tax_rate=0 on a commercial invoice, this is
    // the B2B cross-border reverse-charge scenario. Tax authorities require
    // the legend — omitting it makes the document look like a tax-exempt
    // consumer sale. Mirrors the 2g-F11 fix from templates.tsx.
    // audit12: rendered as a full-width line BELOW the totals row — the old
    // in-row variant squeezed the long legend into a narrow flex column and
    // hyphenated it ("Re-verse charge") which looked broken on the PDF.
    typeof data.tax_rate === "number" && data.tax_rate > 0
      ? null
      : React.createElement(
          View,
          { style: styles.reverseChargeRow },
          React.createElement(Text, { style: styles.reverseChargeText }, "VAT: Reverse charge — VAT settled by the recipient"),
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
            React.createElement(Text, { style: [styles.td, styles.colNum] }, fmtQty(p.quantity)),
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
            React.createElement(Text, { style: [styles.td, styles.colNum] }, fmtQty(it.quantity)),
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
      // 2g-F6 fix (round 4): the prior template rendered BOTH "Subtotal" and
      // "Total (proforma)" with identical values when tax=0 + shipping=0
      // (the marketplace proforma generator at document-generators.ts:524
      // sets `total: subtotal` because proformas traditionally don't carry
      // tax). The duplicate "Subtotal=X / Total (proforma)=X" line confused
      // readers — they thought they were missing the tax breakdown. Now we
      // only render Subtotal, then the optional tax/shipping breakdown (when
      // the issuer overrides them via the API PUT), then a single "Grand
      // Total" line that always carries the final number. The label changed
      // from "Total (proforma)" to "Grand Total" so the row is non-redundant
      // with the Subtotal row.
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
      // Always render the Grand Total — when subtotal === total (the common
      // proforma case with no tax/shipping) we still show ONE final number,
      // not a duplicate of the Subtotal row above.
      React.createElement(
        View,
        { style: styles.totalBlock },
        React.createElement(Text, { style: styles.totalLabel }, "Grand Total"),
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
