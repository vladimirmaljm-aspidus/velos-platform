// ─────────────────────────────────────────────────────────────────────────────
// PDF shared helpers + components (audit12 / uniformity).
//
// Single source of truth for everything the three PDF template families use
// in common:
//   • src/lib/pdf/templates.tsx        (offer / invoice / proforma / LOI)
//   • src/lib/pdf/packing-list.ts      (logistics packing list)
//   • src/lib/marketplace/document-pdf.ts (marketplace trade documents)
//
// Before this module existed, fmtMoney was copy-pasted in 2 files, `fmt` in
// 2, the COPPER brand palette in 2, amountInWords / countryName / mmToPoints
// inlined in templates.tsx, and each template hand-rolled its own watermark
// and page-number footer with subtle visual deviations (opacity 0.10 vs
// 0.12, rotated vs straight, hardcoded `left: 540` page-number positioning).
// Every helper here is the ONE canonical implementation — templates import
// from this file and are visually uniform by construction.
// ─────────────────────────────────────────────────────────────────────────────

import React from "react";
import { Text, View, StyleSheet, Font } from "@react-pdf/renderer";

// ─── Unicode fonts (audit20) ────────────────────────────────────────────────
//
// The react-pdf built-in "standard 14" fonts (Helvetica / Times / Courier)
// encode text with WinAnsi — Cyrillic, Greek and Serbian-Latin Đ/Č/Ć glyphs
// render as mojibake or are silently dropped. With sr/ru in the i18n set,
// partner and tenant names were corrupted in every generated PDF.
//
// We register Noto Sans (SIL OFL 1.1) subsets covering Latin, Latin-Ext,
// Cyrillic, Greek, punctuation, currency and math symbols. Registered under
// four families so the existing code style (explicit "<family>-Bold" names,
// boldVariant()) keeps working unchanged:
//   NotoSans / NotoSans-Bold / NotoSans-Oblique / NotoSans-BoldOblique
// The "NotoSans" family is ALSO registered with style descriptors
// (fontWeight/fontStyle) so `fontStyle: "italic"` resolves correctly.
//
// pdfkit subsets fonts on embed — only used glyphs land in the PDF, so the
// ~120 KB-per-variant source costs a few KB per document.
import NOTO_SANS_REGULAR from "./fonts/noto-sans-regular";
import NOTO_SANS_BOLD from "./fonts/noto-sans-bold";
import NOTO_SANS_ITALIC from "./fonts/noto-sans-italic";
import NOTO_SANS_BOLD_ITALIC from "./fonts/noto-sans-bold-italic";

const NOTO_FAMILIES: Array<[string, string]> = [
  ["NotoSans", NOTO_SANS_REGULAR],
  ["NotoSans-Bold", NOTO_SANS_BOLD],
  ["NotoSans-Oblique", NOTO_SANS_ITALIC],
  ["NotoSans-BoldOblique", NOTO_SANS_BOLD_ITALIC],
];

let notoRegistered = false;
export function ensureUnicodeFontsRegistered(): void {
  if (notoRegistered) return;
  for (const [family, src] of NOTO_FAMILIES) {
    Font.register({ family, src });
  }
  // Style-descriptor form for the base family so fontStyle/fontWeight
  // resolution (e.g. `fontStyle: "italic"`) also finds a variant.
  Font.register({
    family: "NotoSans",
    fonts: [
      { src: NOTO_SANS_REGULAR },
      { src: NOTO_SANS_ITALIC, fontStyle: "italic" },
      { src: NOTO_SANS_BOLD, fontWeight: 700 },
      { src: NOTO_SANS_BOLD_ITALIC, fontWeight: 700, fontStyle: "italic" },
    ],
  });
  notoRegistered = true;
}
ensureUnicodeFontsRegistered();

// ─── Geometry ───────────────────────────────────────────────────────────────

/** Convert millimetres to PDF points (1 mm = 2.83465 pt). */
export const mmToPoints = (mm: number) => mm * 2.83465;

// ─── Brand palette ──────────────────────────────────────────────────────────

// VELOS brand palette — copper (#B45309) + softer copper for section titles.
// Used by the packing-list and marketplace templates; the memorandum template
// (templates.tsx) is tenant-configurable via memorandum_settings and defaults
// to teal (#0d9488) — that's per-tenant branding, NOT a platform deviation.
export const COPPER = "#B45309";
export const COPPER_SOFT = "#92400E";

// ─── Country resolver ───────────────────────────────────────────────────────

// Partners + tenants store country as ISO alpha-2 (e.g. "AE", "ET"). PDFs
// must show the full name ("United Arab Emirates") — not the cryptic 2-letter
// code. The lookup map is built once at module load.
import { COUNTRIES } from "@/lib/data/geo/countries";

const COUNTRY_BY_CODE: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const c of COUNTRIES) m[c.code.toUpperCase()] = c.name;
  return m;
})();

/**
 * ISO alpha-2 code → full country name. Unknown/missing → em-dash.
 * audit13 fix: a FULL NAME input ("Argentina", "United Kingdom" — how some
 * partner rows store it) used to come back SHOUTED ("ARGENTINA") because the
 * lookup uppercased everything; now full names pass through as written and
 * only bare ISO codes are uppercased by convention.
 */
export function countryName(code?: string | null): string {
  if (!code) return "—";
  const raw = String(code).trim();
  const upper = raw.toUpperCase();
  const resolved = COUNTRY_BY_CODE[upper];
  if (resolved) return resolved;
  return upper.length <= 3 ? upper : raw;
}

// ─── Address dedup (audit13) ───────────────────────────────────────────────

/**
 * Common country abbreviations people bake into free-text address lines
 * ("JLT Cluster C, Dubai, UAE") that differ from every ISO form.
 */
const COUNTRY_ABBREVIATIONS: Record<string, string[]> = {
  AE: ["UAE"],
  US: ["USA", "U.S.A.", "US"],
  GB: ["UK", "U.K.", "BRITAIN", "GREAT BRITAIN"],
  SA: ["KSA"],
  RU: ["RF", "RUS"],
  KR: ["KOR", "S KOREA"],
  CN: ["PRC", "CHINA PRC"],
  NL: ["HOLLAND"],
  CH: ["SUI", "SWISS"],
  DE: ["FRG"],
  TZ: ["TANZANIA"],
  CD: ["DRC", "DR CONGO"],
  CI: ["COTE D IVOIRE", "IVORY COAST"],
  TW: ["ROC", "TAIWAN"],
  MK: ["FYROM"],
};

/**
 * Word-boundary, case-insensitive "contains" check for address dedup.
 * Tolerates punctuation ("Dubai," matches "Dubai") and dotted forms
 * ("U.A.E." matches "UAE").
 */
function containsWord(haystack: string, needle: string): boolean {
  const n = String(needle || "").trim();
  if (!n) return false;
  const h = String(haystack || "");
  if (!h) return false;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const norm = (s: string) =>
    s.toLowerCase().replace(/[\s]*\.[\s]*/g, ".").replace(/,/g, " ");
  const hNorm = norm(h);
  const nNorm = norm(n);
  // Direct word match ("dubai" in "…cluster c, dubai, uae")
  if (new RegExp(`(^|[\\s])${esc(nNorm)}($|[\\s])`).test(hNorm)) return true;
  // Dotted-alias match: strip dots from both ("u.a.e" → "uae")
  const hDots = hNorm.replace(/\./g, "");
  const nDots = nNorm.replace(/\./g, "");
  if (nDots && new RegExp(`(^|[\\s])${esc(nDots)}($|[\\s])`).test(hDots)) return true;
  // Leading-dot tolerance: "u.s.a" already handled above; also allow the
  // needle to match with its trailing period stripped in the haystack.
  if (new RegExp(`(^|[\\s])${esc(nNorm.replace(/\.$/, ""))}($|[\\s]|\.)`).test(hNorm)) return true;
  return false;
}

/**
 * All the textual tokens that identify a country in free text: full name,
 * official name, ISO alpha-2, ISO alpha-3, common abbreviations. Accepts
 * either an ISO code ("AE") or a full name ("United Arab Emirates",
 * "Argentina") — whatever the calling table stores.
 */
function countryTokens(country: string): string[] {
  const raw = String(country || "").trim();
  if (!raw) return [];
  const upper = raw.toUpperCase();
  const tokens = new Set<string>([raw]);
  const c = COUNTRIES.find((x) => x.code.toUpperCase() === upper);
  if (c) {
    tokens.add(c.name);
    if (c.officialName) tokens.add(c.officialName);
    tokens.add(c.code.toUpperCase());
    if (c.code3) tokens.add(c.code3.toUpperCase());
    for (const abbr of COUNTRY_ABBREVIATIONS[c.code.toUpperCase()] || []) tokens.add(abbr);
  } else {
    // Full name given — reverse-lookup the ISO record for codes + aliases
    const byName = COUNTRIES.find(
      (x) => x.name.toLowerCase() === raw.toLowerCase() || x.officialName?.toLowerCase() === raw.toLowerCase(),
    );
    if (byName) {
      tokens.add(byName.code.toUpperCase());
      if (byName.code3) tokens.add(byName.code3.toUpperCase());
      for (const abbr of COUNTRY_ABBREVIATIONS[byName.code.toUpperCase()] || []) tokens.add(abbr);
    }
    if (upper.length === 2 || upper.length === 3) tokens.add(upper);
  }
  return [...tokens].filter(Boolean);
}

/**
 * Split the city/postal/country extras into the parts NOT already present
 * in the free-text address line (word-boundary, alias-aware).
 *
 * audit13 root cause: tenants/partners store e.g.
 *   address_line = "GoldCrest Executive Tower, 1002-A, JLT Cluster C, Dubai, UAE"
 *   city = "Dubai", country = "AE"
 * and every template naively appended city + country → "…, Dubai, UAE, Dubai,
 * United Arab Emirates" in the FROM/TO boxes AND the memorandum footer.
 */
function dedupeAddressParts(
  addressLine: string | null | undefined,
  extra?: { postal?: string | null; city?: string | null; country?: string | null },
): string[] {
  const line = String(addressLine || "").trim();
  const appends: string[] = [];
  const postal = String(extra?.postal || "").trim();
  const city = String(extra?.city || "").trim();
  const country = String(extra?.country || "").trim();
  if (postal && !containsWord(line, postal)) appends.push(postal);
  if (city && !containsWord(line, city)) appends.push(city);
  if (country) {
    const full = countryName(country);
    const alreadyMentioned = countryTokens(country).some((t) => containsWord(line, t));
    if (!alreadyMentioned && !appends.includes(full)) appends.push(full);
  }
  return appends;
}

/**
 * Full one-line address: the free-text line + only the city/postal/country
 * parts it doesn't already contain. "…, Dubai, UAE" + city "Dubai" +
 * country "AE" → "…, Dubai, UAE" (nothing appended — no duplication).
 */
export function joinAddressParts(
  addressLine: string | null | undefined,
  extra?: { postal?: string | null; city?: string | null; country?: string | null },
): string {
  const line = String(addressLine || "").trim();
  const parts = [line, ...dedupeAddressParts(addressLine, extra)].filter(Boolean);
  return parts.join(", ");
}

/**
 * ONLY the remaining parts (postal/city/country) that the free-text address
 * line doesn't already mention — for two-line party boxes where line 1 is
 * the address and line 2 the city/country row. Returns "" when everything
 * is already covered (render nothing instead of a duplicate line).
 */
export function remainingAddressParts(
  addressLine: string | null | undefined,
  extra?: { postal?: string | null; city?: string | null; country?: string | null },
): string {
  return dedupeAddressParts(addressLine, extra).join(", ");
}

// ─── Formatters ─────────────────────────────────────────────────────────────

/**
 * Format a money value with exactly 2 decimal places.
 * Falls back to 0.00 when the value is null/undefined/NaN.
 * Uses the document's currency symbol when available.
 */
export function fmtMoney(n: number | null | undefined, currency = "USD"): string {
  const v = typeof n === "number" && isFinite(n) ? n : 0;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(v);
  } catch {
    // Fallback if currency code is invalid
    return `${v.toFixed(2)} ${currency}`;
  }
}

/** Null/undefined/empty-string → em-dash; everything else → String(v). */
export function fmtValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

/**
 * Format a QUANTITY with thousands separators (e.g. 25000 → "25,000").
 * audit12 uniformity: money was always formatted with separators
 * ($38,750.00) while quantities rendered raw ("25000 kg") in the same
 * table — inconsistent within a single document. Every PDF template now
 * formats quantities through this helper so all numeric columns are
 * uniformly separated. Up to 2 decimals (fractional quantities like
 * 0.5 stay readable).
 */
export function fmtQty(n: number | string | null | undefined): string {
  const v = typeof n === "number" && isFinite(n) ? n : Number(n);
  if (!isFinite(v) || n === null || n === undefined || n === "") return "—";
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** Weight with thousands separators + unit suffix (e.g. "1,234.50 kg"). */
export function fmtWeight(n: number | null | undefined, unit = "kg"): string {
  const v = typeof n === "number" && isFinite(n) ? n : 0;
  return `${v.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${unit}`;
}

/** Format an ISO date as "06 Aug 2026" (en-GB, day-first — trade-document convention).
 *
 *  audit20 fix: date-only strings ("2026-08-29") parse as UTC midnight but were
 *  formatted in the SERVER's local timezone — a server west of UTC showed
 *  "28 Aug 2026". Formatting in UTC makes the output deterministic and matches
 *  what the user entered, regardless of where the function runs.
 */
export function fmtDateIso(iso?: string | null): string {
  return iso
    ? new Date(iso).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      })
    : "—";
}

/** Round-off a numeric sum to 2 decimals (avoids 0.30000000000000004 artefacts). */
export function sumRows<T>(rows: T[], f: (r: T) => number): number {
  return Math.round(rows.reduce((a, r) => a + f(r), 0) * 100) / 100;
}

// ─── Amount in words ────────────────────────────────────────────────────────

// AUDIT19 (dedup #5) — the canonical implementation now lives in
// src/lib/utils/amount-in-words.ts (dependency-free, shared by the server
// PDF bundle AND the client offer form so the legal "Amount in Words" line
// can never drift between preview and print). Re-exported here for every
// existing PDF template import.
export { amountInWords } from "@/lib/utils/amount-in-words";

// ─── Colour + font utilities (memorandum template) ─────────────────────────

/**
 * Lighten a hex colour by blending it towards white.
 * amount=0 returns the original colour, amount=1 returns pure white.
 */
export function lightenHex(hex: string, amount: number): string {
  const h = (hex || "#ffffff").replace("#", "");
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return hex;
  const lr = Math.round(r + (255 - r) * amount);
  const lg = Math.round(g + (255 - g) * amount);
  const lb = Math.round(b + (255 - b) * amount);
  const toHex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${toHex(lr)}${toHex(lg)}${toHex(lb)}`;
}

/**
 * Map a CSS font stack OR a react-pdf font name (what the settings UIs store:
 * "Helvetica", "Times-Roman", "Courier") to a valid registered family.
 *
 * audit20: all SANS stacks now resolve to the registered Unicode "NotoSans"
 * family (see ensureUnicodeFontsRegistered) — Helvetica itself can only encode
 * WinAnsi, so Cyrillic/Greek/ĐČĆ text corrupted. Times and Courier stay on the
 * built-ins (serif/mono are rare explicit choices; a Cyrillic serif request is
 * far less common than the default sans path).
 *
 * audit13 fix (kept): the settings UI saves the EXACT react-pdf names
 * ("Times-Roman"), and spaces in family names are normalised to hyphens.
 */
const FONT_MAP: Record<string, string> = {
  // CSS stack names (web preview → PDF) — sans → Unicode Noto Sans
  "helvetica": "NotoSans",
  "inter": "NotoSans",
  "system-ui": "NotoSans",
  "sans-serif": "NotoSans",
  "arial": "NotoSans",
  "noto-sans": "NotoSans",
  "notosans": "NotoSans",
  "segoe-ui": "NotoSans",
  "roboto": "NotoSans",
  "open-sans": "NotoSans",
  "lucida-sans": "NotoSans",
  "verdana": "NotoSans",
  "tahoma": "NotoSans",
  // Serif / mono keep the built-ins
  "times": "Times-Roman",
  "times-new-roman": "Times-Roman",
  "serif": "Times-Roman",
  "georgia": "Times-Roman",
  "garamond": "Times-Roman",
  "courier": "Courier",
  "courier-new": "Courier",
  "monospace": "Courier",
  // Exact react-pdf names (settings UI values + style variants)
  "times-roman": "Times-Roman",
  "times-bold": "Times-Bold",
  "times-italic": "Times-Italic",
  "times-bold-italic": "Times-BoldItalic",
  "timesbolditalic": "Times-BoldItalic",
  "helvetica-bold": "NotoSans-Bold",
  "helvetica-oblique": "NotoSans-Oblique",
  "helvetica-boldoblique": "NotoSans-BoldOblique",
  "courier-bold": "Courier-Bold",
  "courier-oblique": "Courier-Oblique",
  "courier-boldoblique": "Courier-BoldOblique",
};

export function mapFont(fontStack: string | null | undefined, fallback = "NotoSans"): string {
  if (!fontStack) return fallback;
  const first = fontStack.split(",")[0].trim().replace(/['"]/g, "").toLowerCase();
  // audit13: normalise spaces to hyphens so "'Times New Roman', Times, serif"
  // (a CSS stack with spaces in the family name) resolves to Times-Roman —
  // it previously fell through to the fallback.
  const key = first.replace(/\s+/g, "-");
  return FONT_MAP[key] || FONT_MAP[first] || fallback;
}

/**
 * Derive the bold variant of a react-pdf base family.
 * audit13 fix: "Times-Roman" + "-Bold" = "Times-Roman-Bold" which is NOT a
 * valid built-in font (the real name is "Times-Bold") — an invalid family
 * makes @react-pdf/renderer throw or silently fall back. Explicit table for
 * every built-in base + style variant; unknown families keep the legacy
 * suffix behaviour.
 */
const BOLD_VARIANT: Record<string, string> = {
  "Times-Roman": "Times-Bold",
  "Times-Italic": "Times-BoldItalic",
  "Helvetica": "NotoSans-Bold",
  "NotoSans": "NotoSans-Bold",
  "NotoSans-Oblique": "NotoSans-BoldOblique",
  "Helvetica-Oblique": "NotoSans-BoldOblique",
  "Courier": "Courier-Bold",
  "Courier-Oblique": "Courier-BoldOblique",
};

export function boldVariant(family: string): string {
  if (!family) return "NotoSans-Bold";
  if (BOLD_VARIANT[family]) return BOLD_VARIANT[family];
  if (family.endsWith("Bold") || family.endsWith("BoldItalic")) return family;
  return `${family}-Bold`;
}

// ─── Shared react-pdf components ────────────────────────────────────────────

/**
 * Uniform status watermark — stamps DRAFT / PAID / VOID / … across EVERY page
 * of the document so its legal standing is unmissable.
 *
 * Canonical style (audit12): full-width band starting at 40% page height,
 * centred text, opacity 0.12, grey (#999999), Helvetica-Bold, NO rotation.
 * Before audit12 the three template families each hand-rolled a slightly
 * different watermark (packing-list rotated −30°, marketplace used opacity
 * 0.10) — they're now pixel-identical by construction.
 *
 * audit12 CRITICAL FIX: the old implementation used `left: "50%"` +
 * `transform: "translate(-50%, -50%)"` — but @react-pdf/renderer does NOT
 * apply percentage translate the way browsers do, so the watermark was NOT
 * centred: it started at the page's horizontal midpoint and every word
 * wider than half a page got CLIPPED at the right edge. Verified clipping
 * in production: "CANCELLED" rendered as "CANCELL", "DELIVERED" as
 * "DELIVERE", "PRICE NOT CONFIRMED" as "PRICE N CONFIRM". The fix spans
 * the View across the full page width (left: 0, right: 0) and centres the
 * Text with textAlign — no transform needed, clipping impossible.
 *
 * Adaptive font size: 80pt for short statuses (DRAFT/PAID/…), 50pt for
 * long ones (≥14 chars) so "PRICE NOT CONFIRMED" fits on a single line.
 *
 * IMPORTANT: always render the <View fixed> (never conditionally) so
 * react-pdf keeps the fixed signal on pages 2+. The Text inside is empty
 * when the status doesn't warrant a watermark.
 */
export function Watermark({ text }: { text: string }) {
  const fontSize = text.length >= 14 ? 50 : 80;
  return React.createElement(
    View,
    {
      fixed: true,
      style: {
        position: "absolute",
        top: "40%",
        left: 0,
        right: 0,
        opacity: 0.12,
        zIndex: 0,
      },
    },
    React.createElement(
      Text,
      {
        style: {
          fontSize,
          fontFamily: "NotoSans-Bold",
          color: "#999999",
          textAlign: "center",
        },
      },
      text,
    ),
  );
}

/**
 * Uniform page-number footer element. Uses react-pdf's `render` prop so every
 * page shows the correct "Page X of Y" (the pre-audit12 packing-list template
 * hardcoded `left: 540` to position its page number — fragile and visually
 * misaligned; this is the canonical replacement).
 *
 * Must be rendered INSIDE a <View fixed> that is a direct child of <Page> —
 * the factory callers below already do that. Returns a Text element whose
 * content is evaluated per-page by the renderer.
 */
export function PageNumberText({ prefix = "Page " }: { prefix?: string }) {
  return React.createElement(Text, {
    render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
      `${prefix}${pageNumber} of ${totalPages}`,
  });
}

/**
 * Which statuses earn a watermark, per document family.
 *   • Trade docs (offer/invoice/proforma/LOI): DRAFT/PAID/VOID/CANCELLED/OVERDUE
 *   • Marketplace trade documents: DRAFT/REJECTED/SENT/SIGNED
 * Anything else renders an empty (invisible) watermark to keep the `fixed`
 * View present on every page.
 */
const TRADE_WATERMARK_STATUSES = ["DRAFT", "PAID", "VOID", "CANCELLED", "OVERDUE"];
const MARKETPLACE_WATERMARK_STATUSES = ["DRAFT", "REJECTED", "SENT", "SIGNED"];

export function tradeWatermarkText(status: string | null | undefined, priceUnconfirmed = false): string {
  if (priceUnconfirmed) return "PRICE NOT CONFIRMED";
  const st = String(status || "").toUpperCase();
  return TRADE_WATERMARK_STATUSES.includes(st) ? st : "";
}

export function marketplaceWatermarkText(status: string | null | undefined): string {
  const st = String(status || "").toUpperCase();
  return MARKETPLACE_WATERMARK_STATUSES.includes(st) ? st : "";
}

/**
 * Logistics watermark — packing lists have no `status` column, so the status
 * is derived from the request's date fields:
 *   • targetDeliveryDate in the past → DELIVERED
 *   • targetPickupDate in the past (no delivery yet) → IN TRANSIT
 *   • any pickup/delivery scheduled (both future) → SCHEDULED
 *   • no dates at all → DRAFT
 */
export function logisticsWatermarkText(
  targetPickupDate?: string | null,
  targetDeliveryDate?: string | null,
  now = Date.now(),
): string {
  const pickupTs = targetPickupDate ? new Date(targetPickupDate).getTime() : NaN;
  const deliveryTs = targetDeliveryDate ? new Date(targetDeliveryDate).getTime() : NaN;
  if (Number.isFinite(deliveryTs) && now > deliveryTs) return "DELIVERED";
  if (Number.isFinite(pickupTs) && now > pickupTs) return "IN TRANSIT";
  if (Number.isFinite(pickupTs) || Number.isFinite(deliveryTs)) return "SCHEDULED";
  return "DRAFT";
}

// ─── Shared base styles (packing-list + marketplace families) ───────────────

/**
 * The packing-list and marketplace templates share an identical visual
 * language (copper header bar, bordered two-column blocks, grey-striped
 * tables). Before audit12 both files carried a near-identical 60-line
 * StyleSheet with tiny drift; this is the single canonical sheet. Templates
 * that need extra styles (marketplace adds signature rows etc.) spread this
 * base and add their own keys.
 */
export function createBaseStyles() {
  return StyleSheet.create({
    // audit20: NotoSans (registered Unicode subset) instead of the WinAnsi-only
    // built-in Helvetica — same clean sans look, plus Cyrillic/Greek/ĐČĆ support.
    page: { padding: 30, fontSize: 9, fontFamily: "NotoSans", color: "#111" },
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
    notes: {
      border: "1pt solid #d1d5db",
      borderRadius: 3,
      padding: 8,
      backgroundColor: "#f9fafb",
      marginTop: 4,
      fontSize: 9,
    },
  });
}
