// Marketplace Phase 6 — logistics calculators.
//
// Four pure functions on hardcoded data tables:
//   • estimateFreight         — port-pair container freight cost estimator
//   • estimateCustoms         — HS-code customs duty + VAT calculator
//   • calculateContainerLoadability — how many packages fit in a container
//   • estimateCarbonFootprint — CO2 estimate for a sea shipment
//
// All four are deterministic, side-effect free, and work without a
// database connection — the API routes can serve them cheaply. The data
// tables are intentionally compact (a few dozen port pairs, a small set
// of HS chapters, the 8 standard ISO container specs); production would
// back them with a real-time freight-API feed + a country tariff table.

import type {
  CarbonEstimate,
  ContainerLoadability,
  ContainerSpec,
  ContainerType,
  CustomsEstimate,
  FreightQuote,
} from "@/lib/supabase/marketplace-logistics-types";
import { CONTAINER_TYPE_LABELS } from "@/lib/supabase/marketplace-logistics-types";

// ─── 1. Container specifications ───────────────────────────────────────────
//
// Source: ISO 668 / ISO 1496 dimensions. Values are typical for a "general
// purpose" dry container; specialised containers (reefer / open-top / flat
// rack) share the dry dimensions and adjust only the max_payload (more tare
// for the reefer, less for the open-top because of the tarpaulin frame).
//
// LCL / bulk / tank are non-containerised — we treat them as a single
// 25-tonne payload cap with no fixed volume (handled specially in the
// loadability function).

export const CONTAINER_SPECS: Record<ContainerType, ContainerSpec> = {
  "20gp": {
    type: "20gp",
    label: CONTAINER_TYPE_LABELS["20gp"],
    tare_kg: 2_300,
    max_payload_kg: 28_250,
    max_gross_kg: 30_480,
    internal_length_m: 5.898,
    internal_width_m: 2.352,
    internal_height_m: 2.393,
    max_volume_m3: 33.2,
  },
  "40gp": {
    type: "40gp",
    label: CONTAINER_TYPE_LABELS["40gp"],
    tare_kg: 3_700,
    max_payload_kg: 26_740,
    max_gross_kg: 30_480,
    internal_length_m: 12.032,
    internal_width_m: 2.352,
    internal_height_m: 2.393,
    max_volume_m3: 67.7,
  },
  "40hc": {
    type: "40hc",
    label: CONTAINER_TYPE_LABELS["40hc"],
    tare_kg: 3_900,
    max_payload_kg: 26_580,
    max_gross_kg: 30_480,
    internal_length_m: 12.032,
    internal_width_m: 2.352,
    internal_height_m: 2.698,
    max_volume_m3: 76.3,
  },
  "40ot": {
    type: "40ot",
    label: CONTAINER_TYPE_LABELS["40ot"],
    tare_kg: 3_900,
    max_payload_kg: 26_580,
    max_gross_kg: 30_480,
    internal_length_m: 12.028,
    internal_width_m: 2.348,
    internal_height_m: 2.595,
    max_volume_m3: 66.0,
  },
  "40fr": {
    type: "40fr",
    label: CONTAINER_TYPE_LABELS["40fr"],
    tare_kg: 5_400,
    max_payload_kg: 25_080,
    max_gross_kg: 30_480,
    internal_length_m: 12.080,
    internal_width_m: 2.438,
    internal_height_m: 2.127,
    max_volume_m3: 62.2,
  },
  lcl: {
    type: "lcl",
    label: CONTAINER_TYPE_LABELS["lcl"],
    tare_kg: 0,
    max_payload_kg: 20_000, // per-shipment LCL cap
    max_gross_kg: 20_000,
    internal_length_m: 0,
    internal_width_m: 0,
    internal_height_m: 0,
    max_volume_m3: 30.0,
  },
  bulk: {
    type: "bulk",
    label: CONTAINER_TYPE_LABELS["bulk"],
    tare_kg: 0,
    max_payload_kg: 50_000, // bulk carrier hold
    max_gross_kg: 50_000,
    internal_length_m: 0,
    internal_width_m: 0,
    internal_height_m: 0,
    max_volume_m3: 60.0,
  },
  tank: {
    type: "tank",
    label: CONTAINER_TYPE_LABELS["tank"],
    tare_kg: 4_000,
    max_payload_kg: 24_000,
    max_gross_kg: 30_480,
    internal_length_m: 6.0,
    internal_width_m: 2.4,
    internal_height_m: 2.4,
    max_volume_m3: 26.0,
  },
};

// ─── 2. Port pairs ─────────────────────────────────────────────────────────
//
// Compact freight matrix: 30+ major sea ports, distance in nautical miles,
// and a USD cost range for a 40' GP container. Other container types are
// scaled multiplicatively (20' = 0.85x, 40' HC = 1.10x, etc.). Distances
// are open-sea routes from the SeaRates / Searoute.net datasets (rounded).
//
// The matrix is keyed `${from}|${to}` in lower case with port UN/LOCODEs.

interface PortPair {
  distance_nm: number;
  min_usd: number;
  max_usd: number;
  transit_min_days: number;
  transit_max_days: number;
}

const PORT_PAIRS: Record<string, PortPair> = {
  // Asia ↔ Europe (Far East - North Europe)
  "cnsah|nlrtm":  { distance_nm: 11_300, min_usd: 1_500, max_usd: 3_500, transit_min_days: 28, transit_max_days: 35 },
  "cnnbo|nlrtm":  { distance_nm: 11_500, min_usd: 1_550, max_usd: 3_600, transit_min_days: 28, transit_max_days: 36 },
  "cnsha|deham":  { distance_nm: 10_900, min_usd: 1_450, max_usd: 3_400, transit_min_days: 27, transit_max_days: 34 },
  "cnszx|nlrtm":  { distance_nm: 11_400, min_usd: 1_500, max_usd: 3_500, transit_min_days: 28, transit_max_days: 35 },
  "hkHKG|nlrtm":  { distance_nm: 11_200, min_usd: 1_500, max_usd: 3_500, transit_min_days: 28, transit_max_days: 35 },
  "sgsin|nlrtm":  { distance_nm: 8_400,  min_usd: 1_200, max_usd: 2_800, transit_min_days: 22, transit_max_days: 28 },
  "sgsin|deham":  { distance_nm: 8_300,  min_usd: 1_200, max_usd: 2_800, transit_min_days: 22, transit_max_days: 28 },
  // Asia ↔ Mediterranean
  "cnsah|esbcn":  { distance_nm: 9_800,  min_usd: 1_350, max_usd: 3_100, transit_min_days: 24, transit_max_days: 31 },
  "cnsah|itliv":  { distance_nm: 10_200, min_usd: 1_400, max_usd: 3_200, transit_min_days: 25, transit_max_days: 32 },
  "sgsin|esbcn":  { distance_nm: 7_000,  min_usd: 1_050, max_usd: 2_450, transit_min_days: 18, transit_max_days: 24 },
  // Asia ↔ Middle East
  "cnsah|aejeb":  { distance_nm: 6_300,  min_usd: 900,   max_usd: 2_100, transit_min_days: 16, transit_max_days: 21 },
  "sgsin|aejeb":  { distance_nm: 4_900,  min_usd: 750,   max_usd: 1_750, transit_min_days: 13, transit_max_days: 17 },
  // Asia ↔ North America (US West Coast)
  "cnsah|uslax":  { distance_nm: 6_200,  min_usd: 950,   max_usd: 2_200, transit_min_days: 14, transit_max_days: 21 },
  "cnnbo|uslax":  { distance_nm: 5_800,  min_usd: 900,   max_usd: 2_100, transit_min_days: 13, transit_max_days: 20 },
  "cnsha|uslax":  { distance_nm: 5_700,  min_usd: 900,   max_usd: 2_050, transit_min_days: 13, transit_max_days: 19 },
  // Asia ↔ North America (US East Coast via Panama)
  "cnsah|usnyc":  { distance_nm: 11_300, min_usd: 1_500, max_usd: 3_500, transit_min_days: 26, transit_max_days: 35 },
  "sgsin|usnyc":  { distance_nm: 9_800,  min_usd: 1_300, max_usd: 3_050, transit_min_days: 23, transit_max_days: 30 },
  // Europe ↔ North America
  "nlrtm|usnyc":  { distance_nm: 3_300,  min_usd: 600,   max_usd: 1_400, transit_min_days: 9,  transit_max_days: 13 },
  "deham|usnyc":  { distance_nm: 3_400,  min_usd: 600,   max_usd: 1_400, transit_min_days: 9,  transit_max_days: 13 },
  "nlrtm|uslax":  { distance_nm: 8_700,  min_usd: 1_150, max_usd: 2_700, transit_min_days: 19, transit_max_days: 25 },
  // Intra-Asia
  "cnsah|sgsin":  { distance_nm: 2_800,  min_usd: 450,   max_usd: 1_050, transit_min_days: 6,  transit_max_days: 10 },
  "cnsha|sgsin":  { distance_nm: 2_600,  min_usd: 400,   max_usd: 950,   transit_min_days: 6,  transit_max_days: 9 },
  "sgsin|hkhkg":  { distance_nm: 1_500,  min_usd: 280,   max_usd: 700,   transit_min_days: 4,  transit_max_days: 7 },
  // Intra-Europe
  "nlrtm|deham":  { distance_nm: 270,    min_usd: 150,   max_usd: 350,   transit_min_days: 1,  transit_max_days: 3 },
  "deham|esbcn":  { distance_nm: 1_900,  min_usd: 400,   max_usd: 950,   transit_min_days: 4,  transit_max_days: 7 },
  "esbcn|itliv":  { distance_nm: 600,    min_usd: 220,   max_usd: 510,   transit_min_days: 2,  transit_max_days: 4 },
  // Intra-Americas
  "uslax|usnyc":  { distance_nm: 5_400,  min_usd: 850,   max_usd: 2_000, transit_min_days: 8,  transit_max_days: 12 },
  // Middle East ↔ Europe
  "aejeb|nlrtm":  { distance_nm: 6_500,  min_usd: 950,   max_usd: 2_250, transit_min_days: 14, transit_max_days: 19 },
  "aejeb|esbcn":  { distance_nm: 5_700,  min_usd: 850,   max_usd: 2_000, transit_min_days: 12, transit_max_days: 17 },
  // South America ↔ Europe
  "brssz|nlrtm":  { distance_nm: 5_400,  min_usd: 850,   max_usd: 2_000, transit_min_days: 12, transit_max_days: 17 },
  // Africa ↔ Europe
  "zadur|nlrtm":  { distance_nm: 6_700,  min_usd: 950,   max_usd: 2_200, transit_min_days: 13, transit_max_days: 19 },
  "egpsd|esbcn":  { distance_nm: 1_900,  min_usd: 400,   max_usd: 950,   transit_min_days: 4,  transit_max_days: 8 },
  // Australia ↔ Asia
  "ausyd|cnsah":  { distance_nm: 4_900,  min_usd: 750,   max_usd: 1_750, transit_min_days: 13, transit_max_days: 18 },
  "ausyd|sgsin":  { distance_nm: 4_000,  min_usd: 650,   max_usd: 1_500, transit_min_days: 10, transit_max_days: 15 },
};

/**
 * Container-type cost multiplier relative to a 40' GP. Used to scale the
 * matrix base rate to the requested container type. LCL / bulk / tank use
 * their own load-aware pricing (approximated here).
 */
const CONTAINER_COST_MULTIPLIER: Record<ContainerType, number> = {
  "20gp": 0.85,
  "40gp": 1.00,
  "40hc": 1.10,
  "40ot": 1.20,
  "40fr": 1.25,
  lcl: 0.40,
  bulk: 1.30,
  tank: 1.35,
};

/**
 * Common port catalog — UN/LOCODE → display name. Used to populate the
 * origin/destination dropdowns in the freight + carbon calculator UIs.
 */
export const PORT_CATALOG: { code: string; name: string; country: string }[] = [
  { code: "cnsah", name: "Shanghai", country: "CN" },
  { code: "cnnbo", name: "Ningbo-Zhoushan", country: "CN" },
  { code: "cnsha", name: "Shenzhen", country: "CN" },
  { code: "cnszx", name: "Shenzhen (Yantian)", country: "CN" },
  { code: "hkHKG", name: "Hong Kong", country: "HK" },
  { code: "sgsin", name: "Singapore", country: "SG" },
  { code: "aejeb", name: "Jebel Ali (Dubai)", country: "AE" },
  { code: "inmum", name: "Mumbai (Nhava Sheva)", country: "IN" },
  { code: "nlrtm", name: "Rotterdam", country: "NL" },
  { code: "deham", name: "Hamburg", country: "DE" },
  { code: "beanz", name: "Antwerp", country: "BE" },
  { code: "esbcn", name: "Barcelona", country: "ES" },
  { code: "esvlc", name: "Valencia", country: "ES" },
  { code: "itliv", name: "Genoa", country: "IT" },
  { code: "trist", name: "Istanbul (Ambarli)", country: "TR" },
  { code: "uslax", name: "Los Angeles", country: "US" },
  { code: "usnyc", name: "New York / NJ", country: "US" },
  { code: "usmia", name: "Miami", country: "US" },
  { code: "mxmzo", name: "Manzanillo", country: "MX" },
  { code: "brssz", name: "Santos", country: "BR" },
  { code: "arbue", name: "Buenos Aires", country: "AR" },
  { code: "zadur", name: "Durban", country: "ZA" },
  { code: "egpsd", name: "Port Said", country: "EG" },
  { code: "ausyd", name: "Sydney", country: "AU" },
  { code: "rumzk", name: "Novorossiysk", country: "RU" },
  { code: "rsbeg", name: "Belgrade (river)", country: "RS" },
];

// ─── 3. HS code / tariff table ─────────────────────────────────────────────
//
// A compact subset of the WTO Harmonized System (HS) tariff schedule. We
// key by 4-digit HS chapter headings (the first 4 digits of the 6-digit
// code) since most countries' published MFN rates apply at that level. The
// `duty_rate_pct` is the destination country's MFN applied rate. The
// `vat_rate_pct` is the destination's standard VAT. Both are stored
// separately by destination country code.

interface HsTariff {
  description: string;
  default_duty_pct: number;
}

const HS_TARIFFS: Record<string, HsTariff> = {
  // 02 — Meat
  "0201": { description: "Meat of bovine animals, fresh/chilled", default_duty_pct: 12.8 },
  "0203": { description: "Meat of swine, fresh/chilled/frozen", default_duty_pct: 8.5 },
  // 07 — Vegetables
  "0703": { description: "Onions, shallots, garlic, leeks", default_duty_pct: 9.6 },
  // 10 — Cereals
  "1001": { description: "Wheat and meslin", default_duty_pct: 6.4 },
  "1005": { description: "Maize (corn)", default_duty_pct: 5.5 },
  "1006": { description: "Rice", default_duty_pct: 8.2 },
  // 12 — Oilseeds
  "1201": { description: "Soybeans", default_duty_pct: 3.0 },
  "1207": { description: "Other oil seeds (sunflower, rapeseed)", default_duty_pct: 6.4 },
  // 15 — Oils
  "1507": { description: "Soybean oil", default_duty_pct: 9.4 },
  "1511": { description: "Palm oil", default_duty_pct: 11.3 },
  "1512": { description: "Sunflower / safflower oil", default_duty_pct: 9.4 },
  // 17 — Sugar
  "1701": { description: "Cane / beet sugar, solid", default_duty_pct: 17.5 },
  // 26 — Ores
  "2601": { description: "Iron ores and concentrates", default_duty_pct: 0.0 },
  "2603": { description: "Copper ores and concentrates", default_duty_pct: 0.0 },
  "2606": { description: "Aluminium ores and concentrates (bauxite)", default_duty_pct: 0.0 },
  // 28 — Inorganic chemicals
  "2818": { description: "Aluminium oxide (alumina)", default_duty_pct: 5.0 },
  // 31 — Fertilisers
  "3102": { description: "Mineral / chemical fertilisers, nitrogenous", default_duty_pct: 5.5 },
  "3104": { description: "Potassic fertilisers", default_duty_pct: 5.5 },
  // 72 — Iron / steel
  "7204": { description: "Ferrous waste and scrap", default_duty_pct: 2.5 },
  "7208": { description: "Hot-rolled flat-rolled iron/non-alloy steel", default_duty_pct: 7.0 },
  // 74 — Copper
  "7404": { description: "Copper waste and scrap", default_duty_pct: 3.5 },
  "7408": { description: "Copper wire", default_duty_pct: 5.5 },
  // 76 — Aluminium
  "7602": { description: "Aluminium waste and scrap", default_duty_pct: 4.0 },
  "7606": { description: "Aluminium plates / sheets / strip", default_duty_pct: 6.0 },
  // 84 — Machinery
  "8413": { description: "Pumps for liquids", default_duty_pct: 5.0 },
  // 87 — Vehicles
  "8703": { description: "Motor cars / passenger vehicles", default_duty_pct: 10.0 },
  // 25 — Salt / earths / stone
  "2501": { description: "Salt (incl. table / denatured)", default_duty_pct: 4.5 },
  // 23 — Animal feed residues
  "2304": { description: "Oilcake / soybean meal", default_duty_pct: 5.4 },
};

/**
 * Destination-country VAT + applied MFN duty overrides. Where the country
 * is not in this map, we fall back to HS_TARIFFS[hs].default_duty_pct + a
 * 20% VAT (the EU standard).
 */
interface CountryTariffProfile {
  vat_pct: number;
  /** Optional HS-chapter-specific override for the destination country. */
  hs_overrides?: Record<string, number>;
  /** Default applied MFN duty (when the HS chapter is not in HS_TARIFFS
   *  and not in hs_overrides). */
  default_duty_pct: number;
  currency: string;
}

const COUNTRY_TARIFFS: Record<string, CountryTariffProfile> = {
  // EU member states share the EU CET (Common External Tariff)
  DE: { vat_pct: 19, default_duty_pct: 5.5, currency: "EUR" },
  NL: { vat_pct: 21, default_duty_pct: 5.5, currency: "EUR" },
  BE: { vat_pct: 21, default_duty_pct: 5.5, currency: "EUR" },
  ES: { vat_pct: 21, default_duty_pct: 5.5, currency: "EUR" },
  IT: { vat_pct: 22, default_duty_pct: 5.5, currency: "EUR" },
  FR: { vat_pct: 20, default_duty_pct: 5.5, currency: "EUR" },
  PL: { vat_pct: 23, default_duty_pct: 5.5, currency: "EUR" },
  // EFTA
  CH: { vat_pct: 8, default_duty_pct: 4.5, currency: "CHF" },
  TR: { vat_pct: 20, default_duty_pct: 8.0, currency: "USD", hs_overrides: { "7208": 10, "7606": 12 } },
  // North America
  US: { vat_pct: 0, default_duty_pct: 3.4, currency: "USD" },
  CA: { vat_pct: 5,  default_duty_pct: 4.0, currency: "CAD" },
  MX: { vat_pct: 16, default_duty_pct: 6.0, currency: "USD" },
  // South America
  BR: { vat_pct: 18, default_duty_pct: 11.5, currency: "USD" },
  AR: { vat_pct: 21, default_duty_pct: 10.5, currency: "USD" },
  // Middle East
  AE: { vat_pct: 5, default_duty_pct: 5.0, currency: "USD" },
  SA: { vat_pct: 15, default_duty_pct: 5.0, currency: "USD" },
  QA: { vat_pct: 0, default_duty_pct: 5.0, currency: "USD" },
  // Asia
  CN: { vat_pct: 13, default_duty_pct: 7.5, currency: "USD", hs_overrides: { "7204": 4, "7602": 6 } },
  HK: { vat_pct: 0,  default_duty_pct: 0.0, currency: "USD" },
  SG: { vat_pct: 9,  default_duty_pct: 0.0, currency: "USD" },
  IN: { vat_pct: 18, default_duty_pct: 15.0, currency: "USD" },
  JP: { vat_pct: 10, default_duty_pct: 3.5, currency: "USD" },
  KR: { vat_pct: 10, default_duty_pct: 5.5, currency: "USD" },
  // Oceania
  AU: { vat_pct: 10, default_duty_pct: 4.5, currency: "AUD" },
  // Africa
  ZA: { vat_pct: 15, default_duty_pct: 7.5, currency: "USD" },
  EG: { vat_pct: 14, default_duty_pct: 10.0, currency: "USD" },
  // Eurasia
  RU: { vat_pct: 20, default_duty_pct: 7.5, currency: "USD" },
  // Balkans
  RS: { vat_pct: 20, default_duty_pct: 6.5, currency: "EUR" },
};

// ─── 4. Freight cost estimator ──────────────────────────────────────────────

/**
 * Estimate the freight cost + transit time for a port pair + container type.
 *
 * Returns a cost range (min/max) in USD, a transit-day range, the open-sea
 * distance in nautical miles, and a short note explaining the basis. When
 * the exact port pair is not in the matrix, the function falls back to a
 * distance-based heuristic: cost = USD 0.15–0.30 per nautical mile, transit
 * = distance / 22 knots * 1.15 (port-time allowance). The fallback is
 * clearly flagged in `notes` so the caller's UI can warn the user.
 *
 * The container-type multiplier scales the 40' GP base rate; LCL/bulk/tank
 * use their own load-aware pricing (approximated here as 0.4x for LCL,
 * 1.3x for bulk, 1.35x for tank).
 */
export function estimateFreight(
  from: string,
  to: string,
  containerType: string,
): FreightQuote {
  const fromNorm = String(from || "").trim().toLowerCase();
  const toNorm = String(to || "").trim().toLowerCase();
  if (!fromNorm || !toNorm) {
    return {
      from_port: from,
      to_port: to,
      container_type: (containerType as ContainerType) || "40gp",
      min: 0,
      max: 0,
      currency: "USD",
      transit_days: { min: 0, max: 0 },
      distance_nm: null,
      notes: "Origin or destination port is missing.",
    };
  }

  const key = `${fromNorm}|${toNorm}`;
  const pair = PORT_PAIRS[key];

  const ct = (containerType as ContainerType) || "40gp";
  const mult = CONTAINER_COST_MULTIPLIER[ct] ?? 1.0;

  if (pair) {
    return {
      from_port: from,
      to_port: to,
      container_type: ct,
      min: Math.round((pair.min_usd * mult) / 5) * 5,
      max: Math.round((pair.max_usd * mult) / 5) * 5,
      currency: "USD",
      transit_days: { min: pair.transit_min_days, max: pair.transit_max_days },
      distance_nm: pair.distance_nm,
      notes: `Estimate based on the published port-pair matrix for ${from.toUpperCase()} → ${to.toUpperCase()}. Carrier rates fluctuate ±15% weekly.`,
    };
  }

  // Fallback: distance-based heuristic. We approximate the distance by
  // looking up both ports in the catalog and reusing one of their pair
  // distances as a proxy (no great-circle computation available). If
  // neither port is in the catalog, fall back to 6_000 nm average.
  const fromCat = PORT_CATALOG.find((p) => p.code.toLowerCase() === fromNorm);
  const toCat = PORT_CATALOG.find((p) => p.code.toLowerCase() === toNorm);
  let distance: number;
  let notes: string;
  if (fromCat && toCat) {
    // Use a coarse distance: pick the longest PORT_PAIRS entry involving
    // either port, scaled by the great-circle rough ratio. Since we lack a
    // proper geo lookup, we use 6_000 nm as a neutral open-sea proxy.
    distance = 6_000;
    notes = `No direct matrix entry for ${fromCat.name} → ${toCat.name}. Estimate uses an open-sea distance proxy of ~6,000 nm and a USD 0.15–0.30 / nm heuristic.`;
  } else {
    distance = 6_000;
    notes = `Unknown port pair. Estimate uses an open-sea distance proxy of ~6,000 nm and a USD 0.15–0.30 / nm heuristic.`;
  }

  const min = Math.round((distance * 0.15 * mult) / 5) * 5;
  const max = Math.round((distance * 0.30 * mult) / 5) * 5;
  const transitMin = Math.max(7, Math.round(distance / 22 / 24 * 1.15));
  const transitMax = Math.round(transitMin * 1.25);

  return {
    from_port: from,
    to_port: to,
    container_type: ct,
    min,
    max,
    currency: "USD",
    transit_days: { min: transitMin, max: transitMax },
    distance_nm: distance,
    notes,
  };
}

// ─── 5. Customs duty + VAT calculator ───────────────────────────────────────

/**
 * Estimate the customs duty + VAT for a declared-value import.
 *
 * Looks up the destination country's tariff profile (MFN applied rate +
 * standard VAT) and the HS chapter's published rate. When the destination
 * country has an HS-specific override, it wins; otherwise the HS table's
 * default; otherwise the country's default_duty_pct. VAT is always applied
 * on (declared_value + duty_amount) — the standard WTO customs-VAT base.
 *
 * HS code may be 4 or 6 digits; we look up the 4-digit chapter head.
 */
export function estimateCustoms(
  hsCode: string,
  originCountry: string,
  destCountry: string,
  value: number,
): CustomsEstimate {
  const hs = String(hsCode || "").trim().replace(/\D/g, "").slice(0, 6);
  const chapter = hs.slice(0, 4);
  const origin = String(originCountry || "").trim().toUpperCase();
  const dest = String(destCountry || "").trim().toUpperCase();
  const declaredValue = Number.isFinite(value) && value > 0 ? value : 0;

  // Resolve the duty rate.
  const tariff = chapter ? HS_TARIFFS[chapter] : null;
  const countryProfile = COUNTRY_TARIFFS[dest] || null;
  let dutyRate = tariff?.default_duty_pct ?? countryProfile?.default_duty_pct ?? 5.5;
  if (countryProfile?.hs_overrides && chapter && chapter in countryProfile.hs_overrides) {
    dutyRate = countryProfile.hs_overrides[chapter];
  }

  // Resolve the VAT rate. Use the destination profile; fall back to EU 20%.
  const vatRate = countryProfile?.vat_pct ?? 20;

  const dutyAmount = Math.round((declaredValue * dutyRate) / 100 * 100) / 100;
  const vatBase = declaredValue + dutyAmount;
  const vatAmount = Math.round((vatBase * vatRate) / 100 * 100) / 100;
  const totalCharges = Math.round((dutyAmount + vatAmount) * 100) / 100;
  const currency = countryProfile?.currency || "USD";

  const desc = tariff?.description ? ` (${tariff.description})` : "";
  return {
    hs_code: hs || hsCode,
    origin_country: origin,
    destination_country: dest,
    declared_value: declaredValue,
    duty_rate: dutyRate,
    duty_amount: dutyAmount,
    vat_rate: vatRate,
    vat_amount: vatAmount,
    total_charges: totalCharges,
    currency,
    notes: `MFN applied rate for HS ${chapter || "??"}${desc} imported into ${dest || "??"}. VAT of ${vatRate}% applied on the customs base (declared value + duty). Excludes excise, anti-dumping, and free-trade-agreement preferences.`,
  };
}

// ─── 6. Container loadability calculator ───────────────────────────────────

/**
 * Compute how many packages of a fixed weight + volume fit inside a
 * container, given the container type.
 *
 * The binding constraint is the smaller of:
 *   max_packages_by_weight = floor(max_payload_kg / package_weight_kg)
 *   max_packages_by_volume = floor(max_volume_m3 / package_volume_m3)
 *
 * LCL / bulk / tank use the same logic but their max_payload is per-
 * shipment (no fixed container geometry). When package_weight or
 * package_volume is 0, the corresponding constraint is treated as
 * infinite (no binding).
 *
 * Utilization is reported separately for weight and volume so the caller
 * can warn the user when one is the bottleneck ("you're volumed out before
 * you hit the weight cap" — common for low-density cargo like cotton).
 */
export function calculateContainerLoadability(
  containerType: string,
  packageWeight: number,
  packageVolume: number,
): ContainerLoadability {
  const ct = (containerType as ContainerType) || "40gp";
  const spec = CONTAINER_SPECS[ct] ?? CONTAINER_SPECS["40gp"];

  const pkgWeight = Number.isFinite(packageWeight) && packageWeight > 0 ? packageWeight : 0;
  const pkgVolume = Number.isFinite(packageVolume) && packageVolume > 0 ? packageVolume : 0;

  const maxByWeight = pkgWeight > 0 ? Math.floor(spec.max_payload_kg / pkgWeight) : Number.MAX_SAFE_INTEGER;
  const maxByVolume = pkgVolume > 0 ? Math.floor(spec.max_volume_m3 / pkgVolume) : Number.MAX_SAFE_INTEGER;

  const maxPackages = Math.max(0, Math.min(maxByWeight, maxByVolume));

  const totalWeight = pkgWeight > 0 ? maxPackages * pkgWeight : 0;
  const totalVolume = pkgVolume > 0 ? maxPackages * pkgVolume : 0;

  const weightUtil = spec.max_payload_kg > 0 ? Math.min(100, (totalWeight / spec.max_payload_kg) * 100) : 0;
  const volumeUtil = spec.max_volume_m3 > 0 ? Math.min(100, (totalVolume / spec.max_volume_m3) * 100) : 0;

  // The overall utilization is the smaller of the two — that's the binding
  // constraint's "fill level" of the container.
  const utilization = Math.min(weightUtil, volumeUtil);

  const binding = weightUtil < volumeUtil ? "weight" : "volume";
  const notes =
    pkgWeight === 0 && pkgVolume === 0
      ? "Package weight and volume are both zero — cannot compute loadability."
      : `Container fills to ${utilization.toFixed(1)}% by ${binding}${pkgWeight === 0 ? " (weight not provided — only the volume constraint was applied)" : pkgVolume === 0 ? " (volume not provided — only the weight constraint was applied)" : ""}.`;

  return {
    container_type: ct,
    package_weight_kg: pkgWeight,
    package_volume_m3: pkgVolume,
    max_packages_by_weight: maxByWeight === Number.MAX_SAFE_INTEGER ? 0 : maxByWeight,
    max_packages_by_volume: maxByVolume === Number.MAX_SAFE_INTEGER ? 0 : maxByVolume,
    max_packages: maxPackages,
    total_weight_kg: Math.round(totalWeight * 100) / 100,
    total_volume_m3: Math.round(totalVolume * 100) / 100,
    weight_utilization_pct: Math.round(weightUtil * 10) / 10,
    volume_utilization_pct: Math.round(volumeUtil * 10) / 10,
    utilization_pct: Math.round(utilization * 10) / 10,
    notes,
  };
}

// ─── 7. Carbon footprint estimator ─────────────────────────────────────────

/**
 * Estimate the CO2-equivalent emissions of a sea freight shipment, in
 * tonnes.
 *
 * Methodology: IMO-style estimation using gCO2e per tonne-km. Sea freight
 * averages 8–16 gCO2e / tonne-km depending on vessel type, speed, and
 * utilisation; we use 12 gCO2e / t-km as the central estimate. The total
 * is multiplied by the cargo weight (tonnes) × distance (nautical miles
 * converted to km via 1.852).
 *
 * LCL shipments are charged by the proportion of container capacity used,
 * approximated as a 1/8 share (since LCL shipments typically consolidate
 * ~8 shippers per 40' container).
 *
 * The `equivalent` field is a plain-language comparison (passenger cars
 * driven for a year, flights, etc.) to make the number meaningful to the
 * user. The `suggestions` array lists mitigation options.
 */
export function estimateCarbonFootprint(
  from: string,
  to: string,
  containerType: string,
  weight: number,
): CarbonEstimate {
  const fromNorm = String(from || "").trim().toLowerCase();
  const toNorm = String(to || "").trim().toLowerCase();
  const ct = (containerType as ContainerType) || "40gp";
  const weightTons = Number.isFinite(weight) && weight > 0 ? weight : 0;

  // Distance lookup: prefer the matrix; fall back to 6_000 nm.
  const key = `${fromNorm}|${toNorm}`;
  const pair = PORT_PAIRS[key];
  const distanceNm = pair?.distance_nm ?? 6_000;

  // Distance in km. nm × 1.852.
  const distanceKm = distanceNm * 1.852;

  // Emission factor: 12 gCO2e per tonne-km (sea-freight average). For LCL
  // the share is 1/8 of a full container's emissions.
  let emissionFactorPerTKm = 12; // gCO2e / t-km
  let effectiveWeightTons = weightTons;
  if (ct === "lcl") {
    effectiveWeightTons = weightTons > 0 ? weightTons : 5; // assume 5t if missing
    emissionFactorPerTKm = 12 / 8;
  } else if (ct === "bulk" || ct === "tank") {
    emissionFactorPerTKm = 14; // bulk carriers are slightly more carbon-intense
  }

  // tonnes CO2 = (effectiveWeightTons × distanceKm × factor g) / 1_000_000
  const co2Tons = Math.round((effectiveWeightTons * distanceKm * emissionFactorPerTKm) / 1_000_000 * 100) / 100;

  // Equivalent: 1 tCO2 ≈ 1 passenger car driven for ~4,200 km (EU avg).
  const carKm = Math.round(co2Tons * 4_200);
  const equivalent =
    co2Tons <= 0
      ? "No carbon emissions estimated (missing weight)."
      : co2Tons < 1
        ? `Equivalent to a passenger car driven ${carKm.toLocaleString()} km.`
        : co2Tons < 10
          ? `Equivalent to ${Math.round(co2Tons)} passenger cars driven for a year.`
          : `Equivalent to ${Math.round(co2Tons / 4)} round-trip flights from London to New York.`;

  // Mitigation suggestions depend on the route + container type.
  const suggestions: string[] = [];
  if (ct === "40hc" || ct === "40gp") {
    suggestions.push("Maximise container loading — a 90% full container has ~30% lower emissions per tonne than a 60% full one.");
  }
  if (ct === "lcl") {
    suggestions.push("Consolidate LCL shipments to fewer, fuller containers — fewer partial loads = lower total emissions.");
  }
  if (distanceNm > 8_000) {
    suggestions.push("For long-haul routes, prefer slow-steaming carriers — 20% slower cuts emissions ~15%.");
  }
  if (weightTons > 0 && effectiveWeightTons < 8) {
    suggestions.push("Consider rail for the inland leg — rail freight is 5–10× less carbon-intense than road.");
  }
  suggestions.push("Purchase verified carbon-offset credits to make the shipment carbon-neutral.");
  if (suggestions.length === 0) {
    suggestions.push("Use a low-sulphur-fuel carrier to cut SOx and PM emissions alongside CO2.");
  }

  return {
    from_port: from,
    to_port: to,
    container_type: ct,
    weight_tons: effectiveWeightTons,
    co2_tons: co2Tons,
    equivalent,
    distance_nm: distanceNm,
    suggestions,
  };
}
