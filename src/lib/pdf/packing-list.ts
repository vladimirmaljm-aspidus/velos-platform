import React from "react";
import { renderToBuffer, Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
// audit12: shared helpers + components (fmtValue, sumRows, Watermark,
// logisticsWatermarkText, base styles) — single source of truth shared with
// templates.tsx and marketplace/document-pdf.ts.
import {
  fmtValue as fmt,
  fmtQty,
  sumRows,
  Watermark,
  logisticsWatermarkText,
  createBaseStyles,
} from "@/lib/pdf/shared";

export interface PackingLine {
  description?: string;
  hs_code?: string;
  packages?: number | string;
  package_type?: string;
  unit_weight_kg?: number | string;
  length_cm?: number | string;
  width_cm?: number | string;
  height_cm?: number | string;
  quantity?: number | string;
  unit?: string;
}

export interface PackingListInput {
  tenantName: string;
  requestNumber: string;
  mode: string;
  containerType?: string | null;
  incoterm?: string | null;
  createdAt?: string | null;
  targetPickupDate?: string | null;
  targetDeliveryDate?: string | null;
  // F-FINAL: optional letterhead / seal image URLs for future per-tenant
  // branding parity with the offer/invoice/proforma PDF template (which
  // already supports `logoUrl` and `sealImageUrl`). Currently unused by
  // callers — renderPackingListPdf accepts them so future code can pass
  // them through without another interface break.
  letterheadUrl?: string | null;
  sealUrl?: string | null;
  origin: {
    company?: string | null;
    address_line?: string | null;
    city?: string | null;
    postal_code?: string | null;
    country?: string | null;
    port?: string | null;
    contact_name?: string | null;
    contact_phone?: string | null;
  };
  destination: {
    company?: string | null;
    address_line?: string | null;
    city?: string | null;
    postal_code?: string | null;
    country?: string | null;
    port?: string | null;
    contact_name?: string | null;
    contact_phone?: string | null;
  };
  cargo: {
    description?: string | null;
    hs_codes?: string | null;
    is_hazardous?: boolean;
    is_temperature_controlled?: boolean;
    temperature_range?: string | null;
    insurance_required?: boolean;
    cargo_value?: number | string | null;
    cargo_currency?: string | null;
    total_weight_kg?: number | string | null;
    total_volume_cbm?: number | string | null;
    total_packages?: number | string | null;
  };
  packingList: PackingLine[];
  specialInstructions?: string | null;
}

// audit12: base styles (page / headerBar / sections / tables / totals /
// notes) live in @/lib/pdf/shared.ts — previously a near-identical 40-line
// StyleSheet was copy-pasted here and in marketplace/document-pdf.ts with
// tiny drift. Only the packing-list-specific column widths and badges remain
// local.
const base = createBaseStyles();

const styles = StyleSheet.create({
  ...base,
  colDesc: { flex: 3 },
  colHs: { width: 45 },
  colPkg: { width: 30, textAlign: "right" },
  colType: { width: 45 },
  colKg: { width: 40, textAlign: "right" },
  colDims: { width: 60, textAlign: "right" },
  colQty: { width: 40, textAlign: "right" },
  // audit12: footerFixed matches the marketplace template's footerFixed
  // (fixed View + two Text children: lead-in + render-prop page number).
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
  badges: { flexDirection: "row", gap: 4, marginTop: 4 },
  badge: { fontSize: 8, backgroundColor: "#fee2e2", color: "#991b1b", padding: 3, borderRadius: 2 },
  badgeNeutral: { fontSize: 8, backgroundColor: "#e0e7ff", color: "#3730a3", padding: 3, borderRadius: 2 },
  instructions: { border: "1pt solid #d1d5db", borderRadius: 3, padding: 8, backgroundColor: "#f9fafb", marginTop: 4 },
});

function addr(a: PackingListInput["origin"]): string {
  const parts = [a.address_line, [a.postal_code, a.city].filter(Boolean).join(" "), a.country].filter(Boolean);
  return parts.join(", ") || "—";
}

// ─── Logistics request row → PackingListInput (audit12 dedup) ───────────────
//
// The admin route (/api/logistics-requests/[id]/packing-list.pdf) and the
// portal route (/api/portal/logistics/[id]/packing-list.pdf) previously each
// hand-mapped the same ~25 LR columns into PackingListInput. Extracted here
// so the mapping is identical for both callers by construction.
export function buildPackingListInput(lr: any, tenantName: string): PackingListInput {
  return {
    tenantName,
    requestNumber: lr.number,
    mode: lr.mode,
    containerType: lr.container_type,
    incoterm: lr.incoterm,
    createdAt: lr.created_at,
    targetPickupDate: lr.target_pickup_date,
    targetDeliveryDate: lr.target_delivery_date,
    origin: {
      company: lr.origin_company, address_line: lr.origin_address_line,
      city: lr.origin_city, postal_code: lr.origin_postal_code, country: lr.origin_country,
      port: lr.origin_port, contact_name: lr.origin_contact_name, contact_phone: lr.origin_contact_phone,
    },
    destination: {
      company: lr.destination_company, address_line: lr.destination_address_line,
      city: lr.destination_city, postal_code: lr.destination_postal_code, country: lr.destination_country,
      port: lr.destination_port, contact_name: lr.destination_contact_name, contact_phone: lr.destination_contact_phone,
    },
    cargo: {
      description: lr.cargo_description, hs_codes: lr.hs_codes,
      is_hazardous: lr.is_hazardous, is_temperature_controlled: lr.is_temperature_controlled,
      temperature_range: lr.temperature_range, insurance_required: lr.insurance_required,
      cargo_value: lr.cargo_value, cargo_currency: lr.cargo_currency,
      total_weight_kg: lr.total_weight_kg, total_volume_cbm: lr.total_volume_cbm, total_packages: lr.total_packages,
    },
    packingList: Array.isArray(lr.packing_list) ? lr.packing_list : [],
    specialInstructions: lr.special_instructions,
  };
}

export async function renderPackingListPdf(input: PackingListInput): Promise<Buffer> {
  const totalWeight = input.cargo.total_weight_kg ?? sumRows(input.packingList, (l) => Number(l.unit_weight_kg || 0) * Number(l.packages || 0));
  const totalVolume = input.cargo.total_volume_cbm ?? sumRows(input.packingList, (l) => (Number(l.length_cm || 0) * Number(l.width_cm || 0) * Number(l.height_cm || 0) * Number(l.packages || 0)) / 1_000_000);
  const totalPackages = input.cargo.total_packages ?? sumRows(input.packingList, (l) => Number(l.packages || 0));

  // 9a-N6: synthesize a logistics status watermark for parity with the
  // offer/invoice/proforma/LOI/marketplace templates. packing-list.ts was
  // the only template the c90c218 commit message claimed to cover but
  // actually MISSED. audit12: the status derivation now lives in
  // shared.ts (logisticsWatermarkText) and the rendering uses the shared
  // <Watermark /> component — pixel-identical to every other template
  // (previously this one rotated −30° while the others were straight).
  const _status = logisticsWatermarkText(input.targetPickupDate, input.targetDeliveryDate);

  const doc = React.createElement(
    Document,
    null,
    React.createElement(
      Page,
      { size: "A4", style: styles.page },
      // Status watermark — shared component, fixed View, low opacity.
      React.createElement(Watermark, { text: _status }),
      // Header
      React.createElement(
        View,
        { style: styles.headerBar },
        React.createElement(Text, { style: styles.h1 }, `Packing List · ${input.requestNumber}`),
        React.createElement(
          Text,
          { style: styles.small },
          `${input.mode.toUpperCase()}${input.containerType ? " · " + input.containerType : ""}${input.incoterm ? " · " + input.incoterm : ""}`
            + (input.createdAt ? ` · Issued ${new Date(input.createdAt).toLocaleDateString("en-GB")}` : ""),
        ),
        React.createElement(Text, { style: styles.small }, `Issuer: ${input.tenantName}`),
      ),
      // Route (origin / destination)
      React.createElement(
        View,
        { style: styles.section },
        React.createElement(Text, { style: styles.sectionTitle }, "Route"),
        React.createElement(
          View,
          { style: styles.twoCol },
          React.createElement(
            View,
            { style: styles.col },
            React.createElement(Text, { style: styles.label }, "SHIPPER / ORIGIN"),
            React.createElement(Text, { style: styles.value }, fmt(input.origin.company)),
            React.createElement(Text, { style: styles.label }, addr(input.origin)),
            input.origin.port ? React.createElement(Text, { style: styles.label }, `Port: ${input.origin.port}`) : null,
            input.origin.contact_name ? React.createElement(Text, { style: styles.label }, `${input.origin.contact_name}${input.origin.contact_phone ? " · " + input.origin.contact_phone : ""}`) : null,
          ),
          React.createElement(
            View,
            { style: styles.col },
            React.createElement(Text, { style: styles.label }, "CONSIGNEE / DESTINATION"),
            React.createElement(Text, { style: styles.value }, fmt(input.destination.company)),
            React.createElement(Text, { style: styles.label }, addr(input.destination)),
            input.destination.port ? React.createElement(Text, { style: styles.label }, `Port: ${input.destination.port}`) : null,
            input.destination.contact_name ? React.createElement(Text, { style: styles.label }, `${input.destination.contact_name}${input.destination.contact_phone ? " · " + input.destination.contact_phone : ""}`) : null,
          ),
        ),
      ),
      // Cargo overview
      React.createElement(
        View,
        { style: styles.section },
        React.createElement(Text, { style: styles.sectionTitle }, "Cargo"),
        React.createElement(
          View,
          { style: [styles.col, { padding: 8 }] },
          React.createElement(Text, { style: styles.value }, fmt(input.cargo.description)),
          input.cargo.hs_codes ? React.createElement(Text, { style: styles.label }, `HS: ${input.cargo.hs_codes}`) : null,
          input.cargo.cargo_value ? React.createElement(Text, { style: styles.label }, `Declared value: ${input.cargo.cargo_value} ${input.cargo.cargo_currency || ""}`) : null,
          React.createElement(
            View,
            { style: styles.badges },
            input.cargo.is_hazardous ? React.createElement(Text, { style: styles.badge }, "HAZARDOUS") : null,
            input.cargo.is_temperature_controlled ? React.createElement(Text, { style: styles.badgeNeutral }, `TEMP ${input.cargo.temperature_range || "controlled"}`) : null,
            input.cargo.insurance_required ? React.createElement(Text, { style: styles.badgeNeutral }, "INSURANCE") : null,
          ),
        ),
      ),
      // Packing list table
      React.createElement(
        View,
        { style: styles.section },
        React.createElement(Text, { style: styles.sectionTitle }, `Packing lines (${input.packingList.length})`),
        React.createElement(
          View,
          { style: styles.table },
          React.createElement(
            View,
            { style: styles.trHead },
            React.createElement(Text, { style: [styles.th, styles.colDesc] }, "Description"),
            React.createElement(Text, { style: [styles.th, styles.colHs] }, "HS"),
            React.createElement(Text, { style: [styles.th, styles.colPkg] }, "Pkgs"),
            React.createElement(Text, { style: [styles.th, styles.colType] }, "Type"),
            React.createElement(Text, { style: [styles.th, styles.colKg] }, "Unit kg"),
            React.createElement(Text, { style: [styles.th, styles.colDims] }, "Dims cm"),
            React.createElement(Text, { style: [styles.th, styles.colQty] }, "Total kg"),
          ),
          ...(input.packingList.length
            ? input.packingList.map((l, i) =>
                React.createElement(
                  View,
                  { key: `line-${i}`, style: styles.tr },
                  React.createElement(Text, { style: [styles.td, styles.colDesc] }, fmt(l.description)),
                  React.createElement(Text, { style: [styles.td, styles.colHs] }, fmt(l.hs_code)),
                  React.createElement(Text, { style: [styles.td, styles.colPkg] }, fmtQty(l.packages)),
                  React.createElement(Text, { style: [styles.td, styles.colType] }, fmt(l.package_type)),
                  React.createElement(Text, { style: [styles.td, styles.colKg] }, fmt(l.unit_weight_kg)),
                  React.createElement(Text, { style: [styles.td, styles.colDims] }, [l.length_cm, l.width_cm, l.height_cm].filter(Boolean).join("×") || "—"),
                  React.createElement(Text, { style: [styles.td, styles.colQty] }, fmt(Number(l.unit_weight_kg || 0) * Number(l.packages || 0) || undefined)),
                ),
              )
            : [React.createElement(View, { key: "empty", style: styles.tr },
                React.createElement(Text, { style: [styles.td, { flex: 1 }] }, "No packing lines — cargo shipped in bulk."))]),
        ),
        // Totals
        React.createElement(
          View,
          { style: styles.totals },
          React.createElement(
            View,
            { style: styles.totalBlock },
            React.createElement(Text, { style: styles.totalLabel }, "PACKAGES"),
            React.createElement(Text, { style: styles.totalValue }, String(totalPackages ?? "—")),
          ),
          React.createElement(
            View,
            { style: styles.totalBlock },
            React.createElement(Text, { style: styles.totalLabel }, "WEIGHT (kg)"),
            React.createElement(Text, { style: styles.totalValue }, String(totalWeight ?? "—")),
          ),
          React.createElement(
            View,
            { style: styles.totalBlock },
            React.createElement(Text, { style: styles.totalLabel }, "VOLUME (m³)"),
            React.createElement(Text, { style: styles.totalValue }, typeof totalVolume === "number" ? totalVolume.toFixed(3) : String(totalVolume ?? "—")),
          ),
        ),
      ),
      // Optional: special instructions
      input.specialInstructions
        ? React.createElement(
            View,
            { style: styles.section },
            React.createElement(Text, { style: styles.sectionTitle }, "Special Instructions"),
            React.createElement(
              View,
              { style: styles.instructions },
              React.createElement(Text, null, input.specialInstructions),
            ),
          )
        : null,
      // ── Footer (audit12 uniformity fix) ─────────────────────────────────
      // 2g-F4 fix (round 4): real "Page X of Y" via the react-pdf render prop.
      // Previously the lead-in ("… · Page ") was one fixed <Text> and the
      // "X of Y" part was a SECOND absolutely-positioned View hardcoded to
      // `left: 540` — fragile (breaks if the A4 padding changes) and visually
      // misaligned. Now both parts live in ONE fixed View, matching the
      // marketplace template's footer structure.
      // 2g-F5 fix (round 4): the issue date is input.createdAt (original issue),
      // not new Date() (regen date).
      React.createElement(
        View,
        { style: styles.footerFixed, fixed: true },
        React.createElement(
          Text,
          { style: { fontSize: 8, color: "#9ca3af" } },
          `${input.tenantName} · Packing List ${input.requestNumber}`
            + (input.createdAt ? ` · Issued ${new Date(input.createdAt).toLocaleDateString("en-GB")}` : "")
            + ` · Page `,
        ),
        React.createElement(
          Text,
          {
            style: { fontSize: 8, color: "#9ca3af" },
            render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) => `${pageNumber} of ${totalPages}`,
          },
        ),
      ),
    ),
  );
  return await renderToBuffer(doc as any);
}
