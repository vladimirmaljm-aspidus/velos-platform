import React from "react";
import { renderToBuffer, Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";

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

// F-FINAL: VELOS brand palette — copper (#B45309) + lighter copper tint
// for section titles. Replaces the previous hardcoded teal (#0f766e)
// that didn't match the rest of the brand.
const COPPER = "#B45309";
const COPPER_SOFT = "#92400E";

const styles = StyleSheet.create({
  page: { padding: 30, fontSize: 9, fontFamily: "Helvetica", color: "#111" },
  headerBar: { backgroundColor: COPPER, color: "white", padding: 12, marginBottom: 16, borderRadius: 3 },
  h1: { fontSize: 16, fontWeight: 700 },
  small: { fontSize: 9, opacity: 0.85 },
  section: { marginBottom: 10 },
  sectionTitle: { fontSize: 10, fontWeight: 700, marginBottom: 4, textTransform: "uppercase", color: COPPER_SOFT },
  twoCol: { flexDirection: "row", gap: 12 },
  col: { flex: 1, border: "1pt solid #d1d5db", borderRadius: 3, padding: 8 },
  label: { fontSize: 8, color: "#6b7280", marginBottom: 1 },
  value: { fontSize: 10, marginBottom: 3 },
  table: { border: "1pt solid #d1d5db", borderRadius: 3, marginTop: 4 },
  tr: { flexDirection: "row", borderBottom: "1pt solid #e5e7eb" },
  trHead: { backgroundColor: "#f3f4f6", flexDirection: "row", borderBottom: "1pt solid #d1d5db" },
  th: { fontSize: 8, fontWeight: 700, padding: 5, color: "#374151" },
  td: { fontSize: 8, padding: 5 },
  colDesc: { flex: 3 },
  colHs: { width: 45 },
  colPkg: { width: 30, textAlign: "right" },
  colType: { width: 45 },
  colKg: { width: 40, textAlign: "right" },
  colDims: { width: 60, textAlign: "right" },
  colQty: { width: 40, textAlign: "right" },
  totals: { flexDirection: "row", justifyContent: "flex-end", gap: 20, marginTop: 8, paddingTop: 8, borderTop: "1pt solid #d1d5db" },
  totalBlock: { alignItems: "flex-end" },
  totalLabel: { fontSize: 8, color: "#6b7280" },
  totalValue: { fontSize: 11, fontWeight: 700 },
  footer: { position: "absolute", bottom: 20, left: 30, right: 30, textAlign: "center", fontSize: 8, color: "#9ca3af", borderTop: "1pt solid #e5e7eb", paddingTop: 8 },
  badges: { flexDirection: "row", gap: 4, marginTop: 4 },
  badge: { fontSize: 8, backgroundColor: "#fee2e2", color: "#991b1b", padding: 3, borderRadius: 2 },
  badgeNeutral: { fontSize: 8, backgroundColor: "#e0e7ff", color: "#3730a3", padding: 3, borderRadius: 2 },
  instructions: { border: "1pt solid #d1d5db", borderRadius: 3, padding: 8, backgroundColor: "#f9fafb", marginTop: 4 },
});

function addr(a: PackingListInput["origin"]): string {
  const parts = [a.address_line, [a.postal_code, a.city].filter(Boolean).join(" "), a.country].filter(Boolean);
  return parts.join(", ") || "—";
}
function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

export async function renderPackingListPdf(input: PackingListInput): Promise<Buffer> {
  const totalWeight = input.cargo.total_weight_kg ?? sum(input.packingList, (l) => Number(l.unit_weight_kg || 0) * Number(l.packages || 0));
  const totalVolume = input.cargo.total_volume_cbm ?? sum(input.packingList, (l) => (Number(l.length_cm || 0) * Number(l.width_cm || 0) * Number(l.height_cm || 0) * Number(l.packages || 0)) / 1_000_000);
  const totalPackages = input.cargo.total_packages ?? sum(input.packingList, (l) => Number(l.packages || 0));

  const doc = React.createElement(
    Document,
    null,
    React.createElement(
      Page,
      { size: "A4", style: styles.page },
      // Header
      React.createElement(
        View,
        { style: styles.headerBar },
        React.createElement(Text, { style: styles.h1 }, `Packing List · ${input.requestNumber}`),
        React.createElement(
          Text,
          { style: styles.small },
          `${input.mode.toUpperCase()}${input.containerType ? " · " + input.containerType : ""}${input.incoterm ? " · " + input.incoterm : ""}`
            + (input.createdAt ? ` · Issued ${new Date(input.createdAt).toLocaleDateString()}` : ""),
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
                  React.createElement(Text, { style: [styles.td, styles.colPkg] }, fmt(l.packages)),
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
      React.createElement(
        Text,
        { style: styles.footer, fixed: true },
        // 2g-F5 fix (round 4): use the issue date (input.createdAt), not new Date() (regen date).
        // 2g-F4 fix (round 4): real "Page X of Y" via the react-pdf render prop — was hardcoded
        // "Page rendered <date>" on every page.
        `${input.tenantName} · Packing List ${input.requestNumber}` +
          (input.createdAt ? ` · Issued ${new Date(input.createdAt).toLocaleDateString("en-GB")}` : "") +
          ` · Page `,
      ),
      // 2g-F4 fix (round 4): the <Text render> prop must be a child of a <View fixed>
      // (a direct child of <Page>) so react-pdf recognises it on every page. The
      // footer text above is the lead-in; the page-number Text below is the
      // variable part.
      React.createElement(
        View,
        { style: { position: "absolute", bottom: 20, left: 540, right: 30, fontSize: 8, color: "#9ca3af" }, fixed: true },
        React.createElement(
          Text,
          { render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) => `${pageNumber} of ${totalPages}` },
        ),
      ),
    ),
  );
  return await renderToBuffer(doc as any);
}

function sum<T>(rows: T[], f: (r: T) => number): number {
  return Math.round(rows.reduce((a, r) => a + f(r), 0) * 100) / 100;
}
