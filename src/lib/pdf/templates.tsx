import React from "react";
import { Document, Page, Text, View, StyleSheet, Image, Font } from "@react-pdf/renderer";
import type { Offer, Invoice, Proforma, LetterOfIntent, OfferLineItem, Partner, Tenant, MemorandumSettings, TenantSeal } from "@/lib/supabase/types";

// ── Country name resolver ──────────────────────────────────────────────────
// Partners + tenants store country as ISO alpha-2 (e.g. "AE", "ET"). The
// PDF must show the full name ("United Arab Emirates", "Ethiopia") — not
// the cryptic 2-letter code. We import the countries list once and build
// a lookup map.
import { COUNTRIES } from "@/lib/data/geo/countries";
const COUNTRY_BY_CODE: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const c of COUNTRIES) m[c.code.toUpperCase()] = c.name;
  return m;
})();
function countryName(code?: string | null): string {
  if (!code) return "—";
  const upper = String(code).toUpperCase().trim();
  return COUNTRY_BY_CODE[upper] || upper;
}

// Allow very long "words" (SKUs, HS codes like 1006.30.10.00, IBANs) to break
// across lines. Short words are kept intact so normal prose still looks clean.
Font.registerHyphenationCallback((word) => {
  if (word.length > 18) {
    const parts = word.match(/.{1,18}/g);
    return parts && parts.length > 1 ? parts : [word];
  }
  return [word];
});

interface PdfDocData {
  doc: Offer | Invoice | Proforma | LetterOfIntent;
  docType: "offer" | "invoice" | "proforma" | "loi";
  partner: Partner | null;
  tenant: Tenant | null;
  /** Per-tenant header/footer/body configuration. Replaces the legacy
   *  DocumentTemplate. When null the renderer falls back to built-in defaults
   *  so PDFs still render in mock/dev mode or when the row hasn't been
   *  migrated yet. */
  memorandumSettings: MemorandumSettings | null;
  verificationCode?: string;
  qrCodeDataUrl?: string;
  logoUrl?: string | null;
  /** Resolved seal image URL (data: URL or fetched+re-encoded). Null when no
   *  seal is configured or the seal image couldn't be loaded — the renderer
   *  must skip the seal element entirely in that case. */
  sealImageUrl?: string | null;
  /** Optional TenantSeal row (used for placement / opacity / rotation).
   *  Null when the tenant has no seal configured. */
  seal?: TenantSeal | null;
  /** Optional metadata for PDF properties (Author, Title, Subject, etc.) */
  pdfMeta?: {
    author?: string;
    title?: string;
    subject?: string;
    creator?: string;
    keywords?: string;
  };
}

const mmToPoints = (mm: number) => mm * 2.83465;

/**
 * Map a CSS font stack (e.g. "Inter, system-ui, sans-serif") to a single
 * PDF-safe family. react-pdf only ships Helvetica, Times-Roman and Courier
 * built-in — any custom font would need Font.register() first.
 */
const FONT_MAP: Record<string, string> = {
  "helvetica": "Helvetica",
  "inter": "Helvetica",
  "system-ui": "Helvetica",
  "sans-serif": "Helvetica",
  "arial": "Helvetica",
  "times": "Times-Roman",
  "times-new-roman": "Times-Roman",
  "serif": "Times-Roman",
  "courier": "Courier",
  "monospace": "Courier",
};

function mapFont(fontStack: string | null | undefined, fallback = "Helvetica"): string {
  if (!fontStack) return fallback;
  const first = fontStack.split(",")[0].trim().replace(/['"]/g, "").toLowerCase();
  return FONT_MAP[first] || fallback;
}

/** Derive the heading variant of a font family (e.g. "Helvetica" → "Helvetica-Bold"). */
function boldVariant(family: string): string {
  return family.endsWith("Bold") || family.endsWith("Italic") ? family : `${family}-Bold`;
}

/**
 * Lighten a hex color by blending it towards white.
 * amount=0 returns the original color, amount=1 returns pure white.
 * Used to derive stripe-row backgrounds from the table header color so
 * zebra striping matches the document's branding instead of a flat grey.
 */
function lightenHex(hex: string, amount: number): string {
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
 * Format a money value with exactly 2 decimal places.
 * Falls back to 0.00 when the value is null/undefined/NaN.
 * Uses the document's currency symbol when available.
 */
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
    // Fallback if currency code is invalid
    return `${v.toFixed(2)} ${currency}`;
  }
}

/**
 * Convert a numeric amount into English words (e.g. 171000 → "ONE HUNDRED
 * SEVENTY-ONE THOUSAND"). Used by the "Amount in Words" line that
 * international trade documents (invoices, proformas, offers) legally
 * require. Handles up to billions, negative values, and cents.
 */
function amountInWords(amount: number, currency = "USD"): string {
  const currName =
    currency === "USD" ? "US DOLLARS"
    : currency === "EUR" ? "EUROS"
    : currency === "GBP" ? "POUNDS STERLING"
    : currency === "CHF" ? "SWISS FRANCS"
    : currency === "AED" ? "UAE DIRHAMS"
    : currency === "CNY" ? "CHINESE YUAN"
    : currency === "INR" ? "INDIAN RUPEES"
    : currency === "RUB" ? "RUSSIAN RUBLES"
    : currency === "JPY" ? "JAPANESE YEN"
    : currency === "SAR" ? "SAUDI RIYALS"
    : currency === "BRL" ? "BRAZILIAN REAL"
    : currency === "ZAR" ? "SOUTH AFRICAN RAND"
    : currency === "TRY" ? "TURKISH LIRA"
    : currency === "SGD" ? "SINGAPORE DOLLARS"
    : currency === "HKD" ? "HONG KONG DOLLARS"
    : currency;

  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
  const teens = ["Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  function threeDigitsToWords(n: number): string {
    if (n === 0) return "";
    let str = "";
    const hundred = Math.floor(n / 100);
    const remainder = n % 100;
    if (hundred > 0) {
      str += ones[hundred] + " Hundred";
    }
    if (remainder > 0) {
      if (str) str += " ";
      if (remainder < 10) {
        str += ones[remainder];
      } else if (remainder < 20) {
        str += teens[remainder - 10];
      } else {
        const t = Math.floor(remainder / 10);
        const o = remainder % 10;
        str += tens[t];
        if (o > 0) str += "-" + ones[o];
      }
    }
    return str;
  }

  if (!isFinite(amount)) {
    return `SAY: ZERO ${currName} ONLY`;
  }

  const negative = amount < 0;
  const absAmount = Math.abs(amount);
  const whole = Math.floor(absAmount);
  const cents = Math.round((absAmount - whole) * 100);

  let words: string;
  if (whole === 0) {
    words = "Zero";
  } else {
    const billions = Math.floor(whole / 1000000000);
    const millions = Math.floor((whole % 1000000000) / 1000000);
    const thousands = Math.floor((whole % 1000000) / 1000);
    const remainder = whole % 1000;

    const parts: string[] = [];
    if (billions > 0) parts.push(threeDigitsToWords(billions) + " Billion");
    if (millions > 0) parts.push(threeDigitsToWords(millions) + " Million");
    if (thousands > 0) parts.push(threeDigitsToWords(thousands) + " Thousand");
    if (remainder > 0) parts.push(threeDigitsToWords(remainder));
    words = parts.join(" ");
  }

  let result = `SAY: ${negative ? "NEGATIVE " : ""}${words} ${currName}`;
  if (cents > 0) {
    result += ` AND ${cents}/100`;
  }
  result += " ONLY";
  return result;
}

export function buildPdfDocument({
  doc,
  docType,
  partner,
  tenant,
  memorandumSettings,
  verificationCode,
  qrCodeDataUrl,
  logoUrl,
  sealImageUrl,
  seal,
  pdfMeta,
}: PdfDocData) {
  // ── Memorandum settings (with built-in defaults) ───────────────────
  // Every field has a sensible fallback so the PDF still renders when the
  // tenant has no memorandum_settings row (mock/dev mode, fresh tenant,
  // migration pending, etc.). Fields NOT in the migration (page_size,
  // page margins, accent_color, table styling, selected_bank_accounts,
  // seal_enabled/seal_id) use built-in defaults — they're intentionally
  // out of memorandum_settings' scope so the schema stays simple.
  const m = memorandumSettings;
  const primaryColor = m?.primary_color || "#0d9488";
  const accentColor = "#666666"; // secondary accent (footer divider)
  const bodyTextColor = m?.body_text_color || "#1a1a1a";

  // ── Typography ──────────────────────────────────────────────────────
  const fontFamily = mapFont(m?.body_font_family, "Helvetica");
  const headingFontFamily = boldVariant(fontFamily);
  // Header company-name font (header_left_*). Defaults to the body font.
  const headerFontBase = mapFont(m?.header_left_font_family, fontFamily);
  const companyNameFontFamily = m?.header_left_font_bold === false
    ? headerFontBase
    : boldVariant(headerFontBase);
  const companyNameColor = m?.header_left_font_color || primaryColor;
  const companyNameSize = m?.header_left_font_size ?? 14;

  // Footer column fonts (footer_center_* / footer_right_*).
  const footerCenterFontFamily = mapFont(m?.footer_center_font_family, fontFamily);
  const footerCenterFontSize = m?.footer_center_font_size ?? 8;
  const footerCenterFontColor = m?.footer_center_font_color || "#666666";
  const footerRightFontFamily = mapFont(m?.footer_right_font_family, fontFamily);
  const footerRightFontSize = m?.footer_right_font_size ?? 8;
  const footerRightFontColor = m?.footer_right_font_color || "#666666";

  const fontSize = m?.body_font_size ?? 9;
  const lineHeight = m?.body_line_height ?? 1.4;

  // ── Page size ──────────────────────────────────────────────────────
  // Page size + margins aren't part of memorandum_settings — they're
  // hardcoded sensible defaults so the schema stays simple.
  const pageSize = "A4";

  // ── Page margins (mm → points) ──────────────────────────────────────
  const marginTop = mmToPoints(20);
  const marginBottom = mmToPoints(20);
  const marginLeft = mmToPoints(15);
  const marginRight = mmToPoints(15);

  // ── Header (memorandum — repeats on every page) ────────────────────
  // 2 columns: company name (left) + logo (right). Disabled when explicitly
  // turned off OR when the tenant has neither a name nor a logo to show.
  const headerEnabled = m?.header_enabled !== false;
  const headerHeightPts = headerEnabled ? mmToPoints(m?.header_height_mm ?? 22) : 0;

  // ── Logo (header right column) ──────────────────────────────────────
  // Logo is NEVER distorted — objectFit: "contain" preserves aspect ratio.
  // Dimensions come from settings (mm → pts); position offsets are also mm.
  const logoEnabled = m?.logo_enabled !== false;
  const logoWidthPts = mmToPoints(m?.logo_max_width_mm ?? 30);
  const logoHeightPts = mmToPoints(m?.logo_max_height_mm ?? 20);
  const logoOffsetXPts = mmToPoints(m?.logo_position_x_mm ?? 0);
  const logoOffsetYPts = mmToPoints(m?.logo_position_y_mm ?? 0);
  const showLogo = logoEnabled && !!logoUrl;

  // ── Footer (memorandum — repeats on every page) ────────────────────
  // 3 columns: QR (left) + tenant address/website/email (center) + page#
  // (right). Column widths are percentages of the footer content width and
  // are normalised so they always sum to 1 (a misconfigured tenant still
  // renders cleanly).
  const footerEnabled = m?.footer_enabled !== false;
  const footerHeightPts = footerEnabled ? mmToPoints(m?.footer_height_mm ?? 18) : 0;

  const rawL = m?.footer_left_width_pct ?? 25;
  const rawC = m?.footer_center_width_pct ?? 50;
  const rawR = m?.footer_right_width_pct ?? 25;
  const sumPct = Math.max(1, rawL + rawC + rawR);
  const footerLeftPct = rawL / sumPct;
  const footerCenterPct = rawC / sumPct;
  const footerRightPct = rawR / sumPct;

  // ── QR code (footer left column) ───────────────────────────────────
  const qrEnabled = m?.qr_enabled !== false;
  const qrSizePts = mmToPoints(m?.qr_size_mm ?? 15);
  const showQr = qrEnabled && !!qrCodeDataUrl;

  // ── Table styling (built-in defaults — not in memorandum_settings) ──
  const tableHeaderBg = primaryColor;
  const tableHeaderColor = "#ffffff";
  const tableBorderColor = "#e5e7eb";
  const tableStripe = true;
  // Stripe row background: a very light tint of the header color so it
  // matches the document's branding instead of being a flat grey.
  const stripeBg = lightenHex(tableHeaderBg, 0.92);

  // ── Derived layout — content area must clear the absolutely ─────────
  //    positioned header/footer.
  const headerGap = 6;  // breathing room between header bottom and body
  const footerGap = 6;  // breathing room between body and footer top
  const paddingTop = headerEnabled
    ? Math.max(marginTop, headerHeightPts + headerGap)
    : marginTop;
  const paddingBottom = footerEnabled
    ? Math.max(marginBottom, footerHeightPts + footerGap)
    : marginBottom;

  const styles = StyleSheet.create({
    page: {
      fontSize,
      lineHeight,
      paddingTop,
      paddingBottom,
      paddingLeft: marginLeft,
      paddingRight: marginRight,
      fontFamily,
      color: bodyTextColor,
    },

    // ── HEADER (memorandum — repeats on every page) ────────────────────
    // [Company Name]                [LOGO]
    // Bottom border in primary_color separates the memorandum from the body.
    header: {
      position: "absolute",
      top: 0,
      left: marginLeft,
      right: marginRight,
      height: headerHeightPts,
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingTop: 4,
      paddingBottom: 8,
      borderBottomWidth: 2,
      borderBottomColor: primaryColor,
    },
    headerLeft: {
      flex: 1,
      flexDirection: "column",
      justifyContent: "center",
      paddingRight: 12,
    },
    companyName: {
      fontSize: companyNameSize,
      fontFamily: companyNameFontFamily,
      color: companyNameColor,
      marginBottom: 2,
    },
    // Right column wraps the logo. Width is fixed to the configured logo
    // width so the logo sits at the right edge of the header without
    // pushing the company name off to the left.
    headerLogoWrap: {
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "flex-end",
      width: logoWidthPts,
      // Offset the logo within the header (position_x_mm / position_y_mm).
      // translate is supported by react-pdf via the `transform` style.
      marginLeft: logoOffsetXPts,
      marginTop: logoOffsetYPts,
    },
    // objectFit: "contain" is THE key — it preserves aspect ratio and
    // never distorts the logo even when width/height don't match the
    // image's intrinsic dimensions.
    headerLogo: {
      width: logoWidthPts,
      height: logoHeightPts,
      objectFit: "contain",
    },

    // ── FOOTER (memorandum — fixed, repeats on every page) ────────────
    // 3 columns: [QR]  [Address / Website / Email]  [Page X of Y]
    // NOTE: this View has the `fixed` prop set at render time (line ~754)
    // so it's absolutely positioned + repeats on every page. We don't use
    // marginTop: "auto" here because that only works in normal flow, not
    // in fixed/absolute positioning — and it can prevent the page-number
    // Text (which uses the `render` prop) from rendering correctly.
    footer: {
      width: "100%",
      height: footerHeightPts,
      paddingTop: 6,
      borderTopWidth: 1,
      borderTopColor: accentColor,
      flexDirection: "row",
      alignItems: "flex-start",
    },
    footerColLeft: {
      flexDirection: "column",
      alignItems: "flex-start",
      justifyContent: "center",
      flexBasis: `${footerLeftPct * 100}%`,
      flexGrow: 0,
      flexShrink: 0,
    },
    footerColCenter: {
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      flexBasis: `${footerCenterPct * 100}%`,
      flexGrow: 1,
      flexShrink: 1,
      paddingHorizontal: 4,
    },
    footerColRight: {
      flexDirection: "column",
      alignItems: "flex-end",
      justifyContent: "center",
      flexBasis: `${footerRightPct * 100}%`,
      flexGrow: 0,
      flexShrink: 0,
    },
    footerQrWrap: {
      flexDirection: "column",
      alignItems: "center",
      gap: 2,
    },
    footerQrLabel: { fontSize: 5.5, color: "#aaa", textAlign: "center" },
    footerAddrLine: {
      fontSize: footerCenterFontSize,
      color: footerCenterFontColor,
      fontFamily: footerCenterFontFamily,
      textAlign: "center",
      marginBottom: 1,
    },
    footerPage: {
      fontSize: footerRightFontSize,
      color: footerRightFontColor,
      fontFamily: footerRightFontFamily,
      textAlign: "right",
    },
    footerSys: {
      fontSize: Math.max(5, footerRightFontSize - 1.5),
      color: "#aaa",
      fontStyle: "italic",
      marginTop: 2,
      textAlign: "right",
    },

    // ── Document title block ──────────────────────────────────────────
    docTitleRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "flex-end",
      marginBottom: 14,
      marginTop: 0,
    },
    docTitleBlock: { flexDirection: "column" },
    docTitle: { fontSize: 18, fontFamily: headingFontFamily, color: "#1a1a1a", textTransform: "uppercase", letterSpacing: 1 },
    docSubtitle: { fontSize: 8.5, color: "#888", marginTop: 3 },
    docMetaBlock: { flexDirection: "column", alignItems: "flex-end" },
    docMetaRow: { flexDirection: "row", marginBottom: 2 },
    docMetaLabel: { fontSize: 8, color: "#888", marginRight: 4 },
    docMetaValue: { fontSize: 8.5, fontFamily: headingFontFamily, color: "#333" },

    // ── Proforma banner ("PROFORMA — NOT A TAX INVOICE") ──────────────
    proformaBanner: {
      borderWidth: 1,
      borderColor: "#cc0000",
      backgroundColor: "#fff5f5",
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 3,
      marginBottom: 10,
    },
    proformaBannerText: { fontSize: 8, fontFamily: headingFontFamily, color: "#cc0000", textTransform: "uppercase", textAlign: "center", letterSpacing: 0.5 },

    // ── Section header (FROM/TO/TRADE TERMS/LINE ITEMS/SPECIFICATIONS/...)
    sectionHeader: {
      fontSize: 9,
      fontFamily: headingFontFamily,
      color: accentColor,
      textTransform: "uppercase",
      paddingBottom: 4,
      borderBottomWidth: 1,
      borderBottomColor: tableBorderColor,
      marginBottom: 8,
      letterSpacing: 0.5,
    },

    // ── FROM / TO party boxes ─────────────────────────────────────────
    partiesSection: { flexDirection: "row", gap: 10, marginBottom: 14 },
    partyBox: { flex: 1, borderWidth: 1, borderColor: tableBorderColor, borderRadius: 3, overflow: "hidden" },
    partyHeader: { backgroundColor: "#f5f5f5", paddingVertical: 4, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: tableBorderColor },
    partyHeaderText: { fontSize: 8, fontFamily: headingFontFamily, color: "#555", textTransform: "uppercase", letterSpacing: 0.5 },
    partyBody: { padding: 8 },
    partyName: { fontSize: 9.5, fontFamily: headingFontFamily, color: "#1a1a1a", marginBottom: 3 },
    partyAddr: { fontSize: 8, color: "#555", lineHeight: 1.4, marginBottom: 1 },

    // ── Trade Terms box (3-column grid) ───────────────────────────────
    tradeTerms: { marginBottom: 14, borderWidth: 1, borderColor: tableBorderColor, borderRadius: 3, overflow: "hidden" },
    tradeTermsRow: { flexDirection: "row", borderBottomWidth: 0.25, borderBottomColor: tableBorderColor },
    tradeTermsCell: { flex: 1, flexDirection: "row", paddingHorizontal: 8, paddingVertical: 5, borderRightWidth: 0.25, borderRightColor: tableBorderColor },
    tradeTermsCellLast: { flex: 1, flexDirection: "row", paddingHorizontal: 8, paddingVertical: 5 },
    tradeTermsLabel: { fontSize: 7, color: "#999", textTransform: "uppercase", marginRight: 4, fontFamily: headingFontFamily },
    tradeTermsValue: { fontSize: 8.5, fontFamily: headingFontFamily, color: "#333", flex: 1 },

    // ── Line items table ──────────────────────────────────────────────
    table: { marginBottom: 10, borderWidth: 1, borderColor: tableBorderColor, borderRadius: 3, overflow: "hidden" },
    tableHeader: {
      flexDirection: "row",
      backgroundColor: tableHeaderBg,
      paddingVertical: 7,
    },
    th: { fontSize: 8.5, fontFamily: headingFontFamily, color: tableHeaderColor, paddingHorizontal: 4 },
    tableRow: {
      flexDirection: "row",
      paddingVertical: 6,
      borderBottomWidth: 0.5,
      borderBottomColor: tableBorderColor,
      alignItems: "stretch",
    },
    // Zebra-stripe background — applied to every other data row when
    // table_stripe is true. Uses a very light tint of the header
    // background so it blends with the document's branding.
    tableRowEven: {
      backgroundColor: stripeBg,
    },
    td: { fontSize: 8.5, paddingHorizontal: 4, color: "#333" },

    // ── Specifications (per product key/value table + free text) ──────
    specSection: { marginTop: 12, marginBottom: 10 },
    specItem: { marginTop: 6, marginBottom: 4 },
    specItemTitle: { fontSize: 8.5, fontFamily: headingFontFamily, color: primaryColor, marginBottom: 3 },
    specTable: { borderWidth: 0.5, borderColor: tableBorderColor, borderRadius: 3, overflow: "hidden" },
    specRow: { flexDirection: "row", borderBottomWidth: 0.25, borderBottomColor: tableBorderColor },
    specName: { flex: 1, fontSize: 8, paddingVertical: 3, paddingHorizontal: 6, color: "#666", fontFamily: headingFontFamily },
    specValue: { flex: 1, fontSize: 8, paddingVertical: 3, paddingHorizontal: 6, color: "#333" },
    specDetail: { fontSize: 7.5, color: "#555", lineHeight: 1.4, marginTop: 3, paddingHorizontal: 6 },

    // ── Totals ────────────────────────────────────────────────────────
    totals: { marginTop: 12, alignSelf: "flex-end", width: 250 },
    totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
    totalLabel: { fontSize: 8.5, color: "#666" },
    totalValue: { fontSize: 8.5, fontFamily: headingFontFamily, color: "#333" },
    grandTotal: {
      flexDirection: "row",
      justifyContent: "space-between",
      paddingVertical: 8,
      marginTop: 4,
      borderTopWidth: 2,
      borderTopColor: primaryColor,
    },
    grandTotalLabel: { fontSize: 10, fontFamily: headingFontFamily, color: primaryColor },
    grandTotalValue: { fontSize: 13, fontFamily: headingFontFamily, color: primaryColor },
    amountInWords: {
      marginTop: 6,
      paddingVertical: 6,
      paddingHorizontal: 8,
      backgroundColor: "#fafafa",
      borderRadius: 3,
      borderWidth: 0.5,
      borderColor: tableBorderColor,
    },
    amountInWordsLabel: { fontSize: 7, color: "#999", textTransform: "uppercase", marginBottom: 2, fontFamily: headingFontFamily },
    amountInWordsValue: { fontSize: 8.5, fontFamily: headingFontFamily, color: "#333", textTransform: "uppercase" },

    // ── Offer Text / Terms / Bank Details ─────────────────────────────
    termsBox: { marginTop: 14, marginBottom: 8 },
    termsText: { fontSize: 8.5, color: "#444", lineHeight: 1.5, marginBottom: 4 },

    // ── Bank Details — rendered as a clean vertical list (not a cramped grid) ──
    // One row per account: bank name + currency on line 1, account + SWIFT on line 2.
    bankList: {
      flexDirection: "column",
      gap: 6,
      marginTop: 4,
    },
    bankAccountRow: {
      flexDirection: "column",
      paddingBottom: 4,
      borderBottomWidth: 0.5,
      borderBottomColor: tableBorderColor,
      marginBottom: 2,
    },
    bankAccountName: {
      fontSize: 8.5,
      fontFamily: headingFontFamily,
      color: "#333",
      marginBottom: 1,
    },
    bankAccountDetails: {
      fontSize: 8,
      color: "#555",
      lineHeight: 1.4,
    },

    // ── Authorized Signatures ─────────────────────────────────────────
    signatureWrap: { position: "relative" },
    signatureBlock: { marginTop: 20, flexDirection: "row", justifyContent: "space-between", gap: 24 },
    signatureCol: { flex: 1, flexDirection: "column" },
    signatureParty: { fontSize: 8, color: "#555", marginBottom: 2, fontFamily: headingFontFamily },
    signatureLine: { marginTop: 26, borderBottomWidth: 1, borderBottomColor: "#333" },
    signatureLabel: { fontSize: 8, color: "#666", marginTop: 3, textAlign: "center", fontFamily: headingFontFamily },

    // ── Company Seal (Zigled) ─────────────────────────────────────────
    // Absolutely positioned over the signature area. Placement comes from the
    // TenantSeal.position field; offsets are in millimetres converted to points.
    // @react-pdf/renderer supports `transform` for rotation but does NOT support
    // per-axis translate — we use left/right/top/bottom + margins instead.
    sealOverlay: {
      position: "absolute",
      // Sensible defaults; overridden inline per-placement below.
      bottom: 0,
      right: 0,
      width: 90,
      height: 90,
      opacity: 0.85,
    },
    sealImage: {
      width: "100%",
      height: "100%",
      objectFit: "contain",
    },

    // ── Document Notice (legally required disclaimer per doc type) ────
    noticeBox: {
      marginTop: 14,
      paddingVertical: 6,
      paddingHorizontal: 10,
      backgroundColor: "#fafafa",
      borderLeftWidth: 3,
      borderLeftColor: primaryColor,
      borderRadius: 2,
    },
    noticeText: { fontSize: 7.5, color: "#555", fontStyle: "italic", lineHeight: 1.4 },
  });

  const docTitleMap = {
    offer: "Offer",
    invoice: "Commercial Invoice",
    proforma: "Proforma Invoice",
    loi: "LETTER OF INTENT",
  } as const;
  // LOI has no `items` array (it carries a single product inline on the
  // doc row), so we normalise to an empty array for the line-items-driven
  // branch below. The cast through `any` keeps TS happy across the union.
  const items = ((doc as any).items || []) as OfferLineItem[];
  const currency = doc.currency || "USD";

  // ── Pull trade / shipping fields off the doc ───────────────────────
  // Offer carries these typed; invoice/proforma may carry them via the
  // extended DB row (we read defensively via `any`).
  const tradeFields = doc as any;
  // F-FINAL / P1: default incoterm + payment_terms to "—" (em-dash) instead
  // of the previous fake defaults "EXW" and "T/T in Advance". A default of
  // "EXW" made it look like the seller had committed to an ExWorks shipment
  // when in fact the field was simply empty — that's a legally meaningful
  // incoterm that imposes specific obligations on the buyer (loading, export
  // clearance, etc.). Same for "T/T in Advance" — a specific payment
  // instrument + timing the seller may not have agreed to. The em-dash
  // makes the missing-field state visually obvious on the rendered PDF.
  //
  // 2g-F18 fix (round 4): the Trade Terms grid used to render POL TWICE —
  // once appended to the Incoterm cell ("FOB · Rotterdam") and once in its
  // own POL cell. Now the Incoterm cell shows ONLY the incoterm code so
  // the grid is non-redundant.
  //
  // 2g-F19 fix (round 4): the Trade Terms grid used to fall back to
  // items[0]?.packaging / items[0]?.origin_country etc., which silently
  // misrepresented multi-line offers with different packaging per line.
  // Now the helpers detect multi-line divergence and show "Multiple" when
  // the values differ across line items — the reader knows they need to
  // look at the per-line table for the specifics.
  const incoterm: string = tradeFields.incoterm || (items[0] as any)?.incoterm || "—";
  const pol: string = tradeFields.pol || "—";
  const pod: string = tradeFields.pod || "—";
  const vessel: string = tradeFields.vessel || "—";
  const containerNo: string = tradeFields.container_no || "—";
  const leadTime: string = tradeFields.lead_time || "—";
  /** Pull a field from every line item and either return the common value
   *  or "Multiple" when the values diverge (so the Trade Terms grid never
   *  silently shows just the first item's value for a multi-line offer). */
  const commonLineValue = (extractor: (it: OfferLineItem) => string | null | undefined): string => {
    if (!items || items.length === 0) return "—";
    const vals = items.map(extractor).filter((v): v is string => Boolean(v));
    if (vals.length === 0) return "—";
    const first = vals[0];
    const allSame = vals.every((v) => v === first);
    return allSame ? first : `Multiple (${vals.length})`;
  };
  const packaging: string = tradeFields.packaging || commonLineValue((it: any) => it.packaging);
  const paymentTerms: string = tradeFields.payment_terms || tradeFields.terms || "—";
  // 2g-F19 fix: Trade Terms "Origin" cell now shows the COMMON origin
  // (or "Multiple") instead of just the first item's origin. The per-line
  // Origin column in the line-items table already shows the per-item value,
  // so when origins differ the reader looks at the table for the specifics.
  const originCountry: string = commonLineValue((it: any) => (it as any).origin_country);
  const bankDetails: string = tradeFields.bank_details || "";

  // ── Bank accounts (modern JSON array on tenant) ─────────────────────
  // The DB column is typed as `string | null` (jsonb), but in practice it
  // holds a JSON array of { bankName, currency, swiftCode, accountNumber }.
  // Normalise to a plain array so the JSX below can `.map()` cleanly.
  const parsedBankAccounts: any[] = (() => {
    const raw = tenant?.bank_accounts as unknown;
    if (Array.isArray(raw)) return raw as any[];
    if (typeof raw === "string" && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  })();

  // ── Bank accounts list ────────────────────────────────────────────
  // If the document has a specific bank_details override (user selected
  // a specific bank account in the offer/invoice form), show ONLY that.
  // Otherwise show all tenant bank accounts.
  const bankAccountsList: any[] = bankDetails ? [] : parsedBankAccounts;

  // ── Party box helper (used for FROM / TO) ──────────────────────────
  const PartyBox = ({
    title,
    name,
    addressLine,
    city,
    postal,
    country,
    taxId,
    vat,
    reg,
    email,
    phone,
    website,
  }: {
    title: string;
    name: string;
    addressLine?: string | null;
    city?: string | null;
    postal?: string | null;
    country?: string | null;
    taxId?: string | null;
    vat?: string | null;
    reg?: string | null;
    email?: string | null;
    phone?: string | null;
    website?: string | null;
  }) => (
    <View style={styles.partyBox}>
      <View style={styles.partyHeader}>
        <Text style={styles.partyHeaderText}>{title}</Text>
      </View>
      <View style={styles.partyBody}>
        <Text style={styles.partyName}>{name}</Text>
        {addressLine && <Text style={styles.partyAddr}>{addressLine}</Text>}
        {(postal || city || country) && (
          <Text style={styles.partyAddr}>
            {[postal, city, country ? countryName(country) : null].filter(Boolean).join(", ")}
          </Text>
        )}
        {reg && <Text style={styles.partyAddr}>Reg#: {reg}</Text>}
        {taxId && <Text style={styles.partyAddr}>Tax ID: {taxId}</Text>}
        {vat && <Text style={styles.partyAddr}>VAT#: {vat}</Text>}
        {(phone || email || website) && (
          <Text style={styles.partyAddr}>
            {[phone, email, website].filter(Boolean).join("  ·  ")}
          </Text>
        )}
      </View>
    </View>
  );

  // ── Document notice (legally required disclaimer) per doc type ─────
  const docNotice =
    docType === "invoice"
      ? "This is a computer-generated commercial invoice and is valid without signature."
      : docType === "proforma"
      ? "This proforma invoice is issued for customs/bank purposes only and is not a tax invoice."
      : docType === "loi"
      ? "This Letter of Intent is a non-binding expression of intent to purchase. It does not constitute a legally binding contract until a definitive purchase agreement is executed by both parties."
      : "This offer is valid until the date specified above. Prices are subject to confirmation at time of order.";

  // Format an ISO date as "06 Aug 2026"
  const fmtDate = (iso?: string | null) =>
    iso
      ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
      : "—";

  // Verification code lives ONLY in the PDF metadata (subject/keywords) — never visible.
  const verificationMeta = verificationCode ? ` Verification: ${verificationCode}.` : "";

  return (
    <Document
      title={pdfMeta?.title || `${docTitleMap[docType]} ${doc.number}`}
      author={pdfMeta?.author || tenant?.legal_name || tenant?.name || "VELOS CRM"}
      subject={pdfMeta?.subject || `${docTitleMap[docType]} ${doc.number} — ${partner?.name || "client"}.${verificationMeta}`}
      creator={pdfMeta?.creator || "VELOS CRM System"}
      keywords={pdfMeta?.keywords || `${docType}, ${doc.number}, ${partner?.name || ""}, ${currency}${verificationCode ? `, verification: ${verificationCode}` : ""}`}
      producer="VELOS CRM"
    >
      <Page size={pageSize} style={styles.page}>
        {/* 2g-F2: status watermark — stamps DRAFT/PAID/VOID/CANCELLED/OVERDUE
            across every page so the document's legal standing is unmissable.
            IMPORTANT: always render the <View fixed> (never conditionally) so
            react-pdf keeps the fixed signal on pages 2+. The Text inside is
            empty when the status doesn't warrant a watermark. */}
        <View
          fixed
          style={{
            position: "absolute",
            top: "40%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            opacity: 0.12,
            zIndex: 0,
          }}
        >
          <Text
            style={{
              fontSize: 80,
              fontFamily: "Helvetica-Bold",
              color: "#999999",
              textAlign: "center",
            }}
          >
            {(() => {
              const st = String((doc as any).status || "").toUpperCase();
              // 2g-F26: marketplace auto-generated docs whose unit_price was
              // derived from post.target_price (buyer's ceiling) carry a
              // priceUnconfirmed flag in their document_data. Surface it as
              // a "PRICE NOT CONFIRMED" warning so the reader knows the price
              // is a ceiling, not the agreed sale price.
              const priceUnconfirmed = (doc as any).document_data?.priceUnconfirmed === true;
              if (priceUnconfirmed) return "PRICE NOT CONFIRMED";
              return ["DRAFT", "PAID", "VOID", "CANCELLED", "OVERDUE"].includes(st)
                ? st
                : "";
            })()}
          </Text>
        </View>
        {/* ── HEADER (memorandum — fixed, repeats on every page) ────────
            IMPORTANT: header + footer MUST be inlined directly as
            <View fixed> children of <Page>. @react-pdf/renderer only
            recognizes the `fixed` prop on direct View children of Page.
            Do NOT wrap them in a function component and do NOT conditionally
            render them with {condition && (<View fixed>)} — the conditional
            can cause the renderer to lose the fixed signal on pages 2+. */}
        <View style={styles.header} fixed>
          <View style={styles.headerLeft}>
            <Text style={styles.companyName}>{tenant?.legal_name || tenant?.name || "Company"}</Text>
          </View>
          {showLogo && logoUrl ? (
            <View style={styles.headerLogoWrap}>
              {/* eslint-disable-next-line jsx-a11y/alt-text */}
              <Image style={styles.headerLogo} src={logoUrl} />
            </View>
          ) : null}
        </View>

        {/* Document title + meta block */}
        <View style={styles.docTitleRow}>
          <View style={styles.docTitleBlock}>
            <Text style={styles.docTitle}>{docTitleMap[docType]}</Text>
            {doc.subject && <Text style={styles.docSubtitle}>{doc.subject}</Text>}
          </View>
          <View style={styles.docMetaBlock}>
            <View style={styles.docMetaRow}>
              <Text style={styles.docMetaLabel}>Document No.:</Text>
              <Text style={styles.docMetaValue}>{doc.number}</Text>
            </View>
            <View style={styles.docMetaRow}>
              <Text style={styles.docMetaLabel}>Date of Issue:</Text>
              <Text style={styles.docMetaValue}>
                {fmtDate((doc as any).issue_date || doc.created_at)}
              </Text>
            </View>
            {docType === "offer" && (doc as Offer).valid_until && (
              <View style={styles.docMetaRow}>
                <Text style={styles.docMetaLabel}>Valid Until:</Text>
                <Text style={styles.docMetaValue}>
                  {fmtDate((doc as Offer).valid_until as string)}
                </Text>
              </View>
            )}
            {docType === "loi" && (doc as LetterOfIntent).validity_until && (
              <View style={styles.docMetaRow}>
                <Text style={styles.docMetaLabel}>Valid Until:</Text>
                <Text style={styles.docMetaValue}>
                  {fmtDate((doc as LetterOfIntent).validity_until as string)}
                </Text>
              </View>
            )}
            {(docType === "invoice" || docType === "proforma") && (doc as any).due_date && (
              <View style={styles.docMetaRow}>
                <Text style={styles.docMetaLabel}>Due Date:</Text>
                <Text style={styles.docMetaValue}>
                  {fmtDate((doc as any).due_date)}
                </Text>
              </View>
            )}
            <View style={styles.docMetaRow}>
              <Text style={styles.docMetaLabel}>Currency:</Text>
              <Text style={styles.docMetaValue}>{currency}</Text>
            </View>
          </View>
        </View>

        {/* Proforma banner — clearly marked "PROFORMA — NOT A TAX INVOICE" */}
        {docType === "proforma" && (
          <View style={styles.proformaBanner}>
            <Text style={styles.proformaBannerText}>PROFORMA — NOT A TAX INVOICE</Text>
          </View>
        )}

        {/* FROM / TO party boxes — for offers/invoices/proformas the
            tenant (issuer) is the SELLER and the partner is the BUYER.
            For LOIs the roles are reversed: the tenant (issuer) is the
            BUYER and the partner is the SELLER. The box titles branch
            on docType so the labels stay correct in both cases. */}
        <View style={styles.partiesSection}>
          <PartyBox
            title={docType === "loi" ? "FROM (BUYER)" : "FROM (SELLER)"}
            name={tenant?.legal_name || tenant?.name || "Company"}
            addressLine={tenant?.address_line}
            city={tenant?.city}
            postal={tenant?.postal_code}
            country={tenant?.country}
            reg={tenant?.registration_number}
            vat={tenant?.vat_number}
            taxId={tenant?.tax_id}
            phone={tenant?.phone}
            email={tenant?.email}
            website={tenant?.website}
          />
          <PartyBox
            title={docType === "loi" ? "TO (SELLER)" : "TO (BUYER)"}
            name={partner?.name || "—"}
            addressLine={partner?.address_line}
            city={partner?.city}
            postal={partner?.postal_code}
            country={partner?.country}
            reg={partner?.registration_number}
            vat={partner?.vat_number}
            taxId={partner?.tax_id}
            phone={partner?.phone}
            email={partner?.email}
            website={partner?.website}
          />
        </View>

        {/* ── OFFER / INVOICE / PROFORMA BODY ──────────────────────────
            LOI uses a separate body branch (intro text + product specs
            + delivery terms + validity + notes) and skips this whole
            trade terms / line items / totals block — see the LOI branch
            further below. */}
        {docType !== "loi" && (<>

        {/* TRADE TERMS (Incoterm, Origin, POL, POD, Payment, Lead time, Packaging, Vessel, Container) */}
        <Text style={styles.sectionHeader}>Trade Terms</Text>
        <View style={styles.tradeTerms} wrap={false}>
          <View style={styles.tradeTermsRow}>
            <View style={styles.tradeTermsCell}>
              <Text style={styles.tradeTermsLabel}>Incoterm</Text>
              {/* 2g-F18 fix (round 4): only the incoterm code here — POL has its own cell below. */}
              <Text style={styles.tradeTermsValue}>{incoterm}</Text>
            </View>
            <View style={styles.tradeTermsCell}>
              <Text style={styles.tradeTermsLabel}>Origin</Text>
              {/* 2g-F19 fix (round 4): common origin (or "Multiple") instead of first-item-only. */}
              <Text style={styles.tradeTermsValue}>{originCountry === "—" ? "—" : (originCountry.startsWith("Multiple") ? originCountry : countryName(originCountry))}</Text>
            </View>
            <View style={styles.tradeTermsCellLast}>
              <Text style={styles.tradeTermsLabel}>Payment</Text>
              <Text style={styles.tradeTermsValue}>{paymentTerms}</Text>
            </View>
          </View>
          <View style={styles.tradeTermsRow}>
            <View style={styles.tradeTermsCell}>
              <Text style={styles.tradeTermsLabel}>POL</Text>
              <Text style={styles.tradeTermsValue}>{pol}</Text>
            </View>
            <View style={styles.tradeTermsCell}>
              <Text style={styles.tradeTermsLabel}>POD</Text>
              <Text style={styles.tradeTermsValue}>{pod}</Text>
            </View>
            <View style={styles.tradeTermsCellLast}>
              <Text style={styles.tradeTermsLabel}>Lead Time</Text>
              <Text style={styles.tradeTermsValue}>{leadTime}</Text>
            </View>
          </View>
          <View style={styles.tradeTermsRow}>
            <View style={styles.tradeTermsCell}>
              <Text style={styles.tradeTermsLabel}>Packaging</Text>
              <Text style={styles.tradeTermsValue}>{packaging}</Text>
            </View>
            <View style={styles.tradeTermsCell}>
              <Text style={styles.tradeTermsLabel}>Vessel</Text>
              <Text style={styles.tradeTermsValue}>{vessel}</Text>
            </View>
            <View style={styles.tradeTermsCellLast}>
              <Text style={styles.tradeTermsLabel}>Container</Text>
              <Text style={styles.tradeTermsValue}>{containerNo}</Text>
            </View>
          </View>
        </View>

        {/* LINE ITEMS — header is `fixed` so it repeats on every page */}
        <Text style={styles.sectionHeader}>Line Items</Text>
        <View style={styles.table}>
          <View style={styles.tableHeader} fixed>
            <Text style={[styles.th, { flex: 0.3 }]}>#</Text>
            <Text style={[styles.th, { flex: 3 }]}>Description</Text>
            <Text style={[styles.th, { flex: 1.1 }]}>HS Code</Text>
            <Text style={[styles.th, { flex: 0.9 }]}>Origin</Text>
            <Text style={[styles.th, { flex: 1.1 }]}>Quantity</Text>
            <Text style={[styles.th, { flex: 1, textAlign: "right" }]}>Unit Price</Text>
            <Text style={[styles.th, { flex: 1.1, textAlign: "right" }]}>Total</Text>
          </View>
          {items.map((item, i) => {
            // 2g-F7 fix (round 4): the "Total" column previously rendered
            // `item.total` verbatim — but for offers/invoices/proformas the
            // backend stores the line total as the TAX-INCLUSIVE amount
            // (lineTotal = net + tax in invoices-view.ts), while the
            // Subtotal row sums TAX-EXCLUSIVE line totals. The column
            // therefore didn't foot to the Subtotal. Now we render the
            // per-line tax-EXCLUSIVE amount (qty × unit_price) so the
            // column visually sums to the Subtotal row — matching the
            // tax breakdown below (Tax / VAT line then adds to Grand Total).
            const lineNet = (typeof item.unit_price === "number" && typeof item.quantity === "number")
              ? item.unit_price * item.quantity
              : (typeof item.total === "number" ? item.total : 0);
            return (
              <View
                key={i}
                style={[styles.tableRow, ...(tableStripe && i % 2 === 1 ? [styles.tableRowEven] : [])]}
              >
                <Text style={[styles.td, { flex: 0.3 }]}>{i + 1}</Text>
                <Text style={[styles.td, { flex: 3 }]}>
                  {item.product_name}
                  {item.sku ? `\nSKU: ${item.sku}` : ""}
                  {item.brand ? `\nBrand: ${item.brand}` : ""}
                </Text>
                <Text style={[styles.td, { flex: 1.1 }]}>{(item as any).hs_code || "—"}</Text>
                <Text style={[styles.td, { flex: 0.9 }]}>{countryName((item as any).origin_country)}</Text>
                <Text style={[styles.td, { flex: 1.1 }]}>
                  {item.quantity} {item.unit || "kg"}
                </Text>
                <Text style={[styles.td, { flex: 1, textAlign: "right" }]}>
                  {fmtMoney(item.unit_price, currency)}
                </Text>
                <Text style={[styles.td, { flex: 1.1, textAlign: "right", fontFamily: headingFontFamily }]}>
                  {fmtMoney(lineNet, currency)}
                </Text>
              </View>
            );
          })}
        </View>

        {/* SPECIFICATIONS — coa_params (key/value table) + detailed_spec */}
        {items.some((it: any) => {
          const specs = it.specifications;
          const hasSpecs = Array.isArray(specs)
            ? specs.length > 0
            : (specs && typeof specs === "object" && Object.keys(specs).length > 0);
          return hasSpecs || it.detailed_spec;
        }) && (
          <View style={styles.specSection}>
            <Text style={styles.sectionHeader}>Specifications</Text>
            {items.map((item: any, i: number) => {
              const specs = item.specifications;
              const specArray: Array<{ name: string; value: string }> = Array.isArray(specs)
                ? specs
                : (specs && typeof specs === "object"
                    ? Object.entries(specs).map(([k, v]) => ({ name: k, value: String(v) }))
                    : []);
              return (specArray.length > 0 || item.detailed_spec) ? (
                <View key={`spec-${i}`} style={styles.specItem}>
                  <View wrap={false}>
                    <Text style={styles.specItemTitle}>{item.product_name}</Text>
                    {specArray.length > 0 && (
                      <View style={styles.specTable}>
                        {specArray.map((spec, j) => (
                          <View key={j} style={styles.specRow}>
                            <Text style={styles.specName}>{spec.name}</Text>
                            <Text style={styles.specValue}>{spec.value}</Text>
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
                  {item.detailed_spec && (
                    <Text style={styles.specDetail}>{item.detailed_spec}</Text>
                  )}
                </View>
              ) : null;
            })}
          </View>
        )}

        {/* TOTALS + Amount in Words (kept together, never split across pages) */}
        <View style={styles.totals} wrap={false}>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Subtotal:</Text>
            <Text style={styles.totalValue}>{fmtMoney((doc as any).subtotal, currency)}</Text>
          </View>
          {(doc as any).discount_total > 0 && (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Discount:</Text>
              <Text style={styles.totalValue}>-{fmtMoney((doc as any).discount_total, currency)}</Text>
            </View>
          )}
          {(doc as any).tax_total > 0 ? (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>{docType === "offer" ? "Tax / VAT:" : "VAT:"}</Text>
              <Text style={styles.totalValue}>{fmtMoney((doc as any).tax_total, currency)}</Text>
            </View>
          ) : (
            /* 2g-F11: when tax_total = 0 on a commercial invoice/proforma/offer,
               this is a reverse-charge (B2B cross-border) scenario. Tax
               authorities require the "Reverse charge" legend — omitting it
               makes the document look like a tax-exempt consumer sale. */
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>VAT:</Text>
              <Text style={styles.totalValue}>Reverse charge — VAT settled by recipient</Text>
            </View>
          )}
          <View style={styles.grandTotal}>
            <Text style={styles.grandTotalLabel}>GRAND TOTAL:</Text>
            <Text style={styles.grandTotalValue}>{fmtMoney((doc as any).total, currency)}</Text>
          </View>
          <View style={styles.amountInWords}>
            <Text style={styles.amountInWordsLabel}>Amount in Words</Text>
            <Text style={styles.amountInWordsValue}>{amountInWords((doc as any).total, currency)}</Text>
          </View>
        </View>

        {/* OFFER TEXT / TERMS & CONDITIONS */}
        {((doc as any).terms || doc.notes) && (
          <View style={styles.termsBox}>
            <Text style={styles.sectionHeader} wrap={false}>
              {docType === "offer" ? "Offer Text / Terms" : "Terms & Conditions"}
            </Text>
            {(doc as any).terms && <Text style={styles.termsText}>{(doc as any).terms}</Text>}
            {doc.notes && (doc as any).terms !== doc.notes && (
              <Text style={styles.termsText}>{doc.notes}</Text>
            )}
          </View>
        )}

        {/* BANK DETAILS — show as a clean vertical list, not a cramped grid.
            Modern: tenant.bank_accounts JSON array → one row per account
              (optionally filtered by memorandum_settings.selected_bank_accounts).
            Legacy: if no bank_accounts array, fall back to tenant's
              single-bank fields.
            Per-doc bank_details override always appended at the bottom. */}
        {(bankAccountsList.length > 0 || bankDetails ||
          (!bankDetails && (tenant?.bank_name || tenant?.bank_iban || tenant?.bank_swift))) && (
          <View style={styles.termsBox}>
            <Text style={styles.sectionHeader} wrap={false}>Bank Details</Text>

            {/* If document has a specific bank_details override (user selected
                one account in the form), show ONLY that — not all accounts. */}
            {bankDetails ? (
              <View style={styles.bankList}>
                <View style={styles.bankAccountRow} wrap={false}>
                  <Text style={styles.bankAccountDetails}>{bankDetails}</Text>
                </View>
              </View>
            ) : bankAccountsList.length > 0 ? (
              /* Modern: render every tenant account as its own row. */
              <View style={styles.bankList}>
                {bankAccountsList.map((acct: any, i: number) => (
                  <View key={i} style={styles.bankAccountRow} wrap={false}>
                    <Text style={styles.bankAccountName}>
                      {acct.bankName || acct.bank_name || "Bank"}
                      {acct.currency ? ` (${acct.currency})` : ""}
                    </Text>
                    <Text style={styles.bankAccountDetails}>
                      Account: {acct.accountNumber || acct.account_number || "—"}
                      {"   "}
                      SWIFT: {acct.swiftCode || acct.swift_code || "—"}
                    </Text>
                  </View>
                ))}
              </View>
            ) : (
              /* Legacy: tenant has only single-bank fields. */
              <View style={styles.bankList}>
                {tenant?.bank_name && (
                  <View style={styles.bankAccountRow} wrap={false}>
                    <Text style={styles.bankAccountName}>{tenant.bank_name}</Text>
                  </View>
                )}
                {tenant?.bank_iban && (
                  <View style={styles.bankAccountRow} wrap={false}>
                    <Text style={styles.bankAccountDetails}>IBAN: {tenant.bank_iban}</Text>
                  </View>
                )}
                {tenant?.bank_swift && (
                  <View style={styles.bankAccountRow} wrap={false}>
                    <Text style={styles.bankAccountDetails}>SWIFT/BIC: {tenant.bank_swift}</Text>
                  </View>
                )}
              </View>
            )}
          </View>
        )}

        </>)}

        {/* ── LOI BODY ─────────────────────────────────────────────────────
            LOI is a single-product intent document. The body is:
             1. Introductory paragraph (default or the LOI's terms_text
                when the issuer has provided a custom one)
             2. Product Specifications table (single product, key/value rows)
             3. Delivery & Payment Terms table (incoterm + delivery date +
                payment terms + valid until)
             4. Optional Notes
            LOI does NOT render the line items table, the subtotal/discount/
            tax/total breakdown, or the bank details block — it carries a
            single product + total_value and the legal body is the intro /
            terms_text. */}
        {docType === "loi" && (
          <View>
            {/* LOI-specific variables computed inline */}
            {(() => {
              const loi = doc as LetterOfIntent;
              const buyerName = loi.buyer_name || tenant?.legal_name || tenant?.name || "the Buyer";
              const sellerName = partner?.name || "the Seller";
              const validUntilStr = fmtDate(loi.validity_until);
              const defaultIntro =
                `Dear ${sellerName},\n\n` +
                `We, ${buyerName}, hereby express our firm intention to purchase the following goods under the terms and conditions stated in this Letter of Intent. This LOI is non-binding and serves as a formal expression of our intent to proceed with the purchase, subject to the execution of a definitive purchase agreement.\n\n` +
                `We look forward to your response by ${validUntilStr}.`;
              // Compute COA entries
              const coaEntries: [string, string][] = loi.coa_params && typeof loi.coa_params === "object"
                ? Object.entries(loi.coa_params as Record<string, unknown>)
                    .filter(([, v]) => v != null && v !== "")
                    .map(([k, v]) => [k, String(v)] as [string, string])
                : [];
              // Compute spec entries
              const specSource = loi.specifications as any;
              let specEntries: [string, string][] = [];
              if (Array.isArray(specSource)) {
                specEntries = specSource
                  .filter((s: any) => s && s.name && s.value != null)
                  .map((s: any) => [String(s.name), String(s.value)] as [string, string]);
              } else if (specSource && typeof specSource === "object") {
                specEntries = Object.entries(specSource)
                  .filter(([, v]) => v != null && v !== "")
                  .map(([k, v]) => [k, String(v)] as [string, string]);
              }
              return (
                <View>
                  {/* Introductory paragraph / full LOI body */}
                  <View style={styles.termsBox}>
                    <Text style={styles.sectionHeader} wrap={false}>Letter of Intent</Text>
                    <Text style={styles.termsText}>{loi.terms_text || defaultIntro}</Text>
                  </View>

                  {/* Product Specifications — single product, key/value rows */}
                  <Text style={styles.sectionHeader}>Product Specifications</Text>
                  <View style={styles.specTable} wrap={false}>
                    <View style={styles.specRow}>
                      <Text style={styles.specName}>Product Name</Text>
                      <Text style={styles.specValue}>{loi.product_name}</Text>
                    </View>
                    {loi.product_description ? (
                      <View style={styles.specRow}>
                        <Text style={styles.specName}>Description</Text>
                        <Text style={styles.specValue}>{loi.product_description}</Text>
                      </View>
                    ) : null}
                    {loi.hs_code ? (
                      <View style={styles.specRow}>
                        <Text style={styles.specName}>HS Code</Text>
                        <Text style={styles.specValue}>{loi.hs_code}</Text>
                      </View>
                    ) : null}
                    {loi.origin_country ? (
                      <View style={styles.specRow}>
                        <Text style={styles.specName}>Origin Country</Text>
                        <Text style={styles.specValue}>{countryName(loi.origin_country)}</Text>
                      </View>
                    ) : null}
                    <View style={styles.specRow}>
                      <Text style={styles.specName}>Quantity</Text>
                      <Text style={styles.specValue}>{loi.quantity} {loi.unit}</Text>
                    </View>
                    <View style={styles.specRow}>
                      <Text style={styles.specName}>Unit Price</Text>
                      <Text style={styles.specValue}>{fmtMoney(loi.unit_price, currency)}</Text>
                    </View>
                    <View style={styles.specRow}>
                      <Text style={styles.specName}>Total Value</Text>
                      <Text style={[styles.specValue, { fontFamily: headingFontFamily }]}>
                        {fmtMoney(loi.total_value, currency)}
                      </Text>
                    </View>
                  </View>

                  {/* COA (Certificate of Analysis) — rendered only when data exists */}
                  {coaEntries.length > 0 ? (
                    <View>
                      <Text style={styles.sectionHeader}>Certificate of Analysis (COA)</Text>
                      <View style={styles.specTable} wrap={false}>
                        {coaEntries.map(([key, val], idx) => (
                          <View key={`coa-${idx}`} style={styles.specRow}>
                            <Text style={styles.specName}>{key}</Text>
                            <Text style={styles.specValue}>{val}</Text>
                          </View>
                        ))}
                      </View>
                    </View>
                  ) : null}

                  {/* Technical Specifications — rendered only when data exists */}
                  {specEntries.length > 0 ? (
                    <View>
                      <Text style={styles.sectionHeader}>Technical Specifications</Text>
                      <View style={styles.specTable} wrap={false}>
                        {specEntries.map(([key, val], idx) => (
                          <View key={`spec-${idx}`} style={styles.specRow}>
                            <Text style={styles.specName}>{key}</Text>
                            <Text style={styles.specValue}>{val}</Text>
                          </View>
                        ))}
                      </View>
                    </View>
                  ) : null}

                  {/* Delivery & Payment Terms */}
                  <Text style={styles.sectionHeader}>Delivery &amp; Payment Terms</Text>
                  <View style={styles.specTable} wrap={false}>
                    <View style={styles.specRow}>
                      <Text style={styles.specName}>Delivery Terms</Text>
                      <Text style={styles.specValue}>{loi.delivery_terms || "—"}</Text>
                    </View>
                    <View style={styles.specRow}>
                      <Text style={styles.specName}>Delivery Date</Text>
                      <Text style={styles.specValue}>{fmtDate(loi.delivery_date)}</Text>
                    </View>
                    <View style={styles.specRow}>
                      <Text style={styles.specName}>Payment Terms</Text>
                      <Text style={styles.specValue}>{loi.payment_terms || "—"}</Text>
                    </View>
                    <View style={styles.specRow}>
                      <Text style={styles.specName}>Valid Until</Text>
                      <Text style={styles.specValue}>{validUntilStr}</Text>
                    </View>
                  </View>

                  {/* Optional Notes */}
                  {loi.notes ? (
                    <View style={styles.termsBox}>
                      <Text style={styles.sectionHeader} wrap={false}>Notes</Text>
                      <Text style={styles.termsText}>{loi.notes}</Text>
                    </View>
                  ) : null}
                </View>
              );
            })()}
          </View>
        )}

        {/* AUTHORIZED SIGNATURES — seller + buyer/acceptholder */}
        {/* Wrapped in a relative-positioned container so the company seal
            (when configured) can be absolutely positioned over the signature
            area, as is customary for stamped business documents. */}
        {/* 2g-F24 fix (round 4): in LOI the partner is the SELLER (the
            tenant issues the LOI as the BUYER). The prior fallback said
            "Buyer" for the partner column in LOIs — wrong role. Now the
            fallback labels match the docType's party roles. */}
        <View style={styles.signatureWrap} wrap={false}>
          <View style={styles.signatureBlock}>
            <View style={styles.signatureCol}>
              <Text style={styles.signatureParty}>For {tenant?.legal_name || tenant?.name || "Company"}:</Text>
              <View style={styles.signatureLine} />
              <Text style={styles.signatureLabel}>{docType === "loi" ? "Buyer Signature" : "Authorized Signature"}</Text>
            </View>
            <View style={styles.signatureCol}>
              <Text style={styles.signatureParty}>For {partner?.name || (docType === "loi" ? "Seller" : "Buyer")}:</Text>
              <View style={styles.signatureLine} />
              <Text style={styles.signatureLabel}>{docType === "loi" ? "Seller Acceptance" : "Accepted & Signed"}</Text>
            </View>
          </View>

          {/* Company seal (zigled) — only rendered when a seal image is
              available. Placement / opacity / rotation come from the
              TenantSeal relation (passed in via the `seal` prop), with
              sensible defaults. memorandum_settings doesn't carry a
              seal_enabled flag — the seal is rendered whenever the tenant
              has a default seal configured (resolved by the generator). */}
          {sealImageUrl && seal && (() => {
            const position = seal.position || "bottom-right";
            const opacity = typeof seal.opacity === "number" ? seal.opacity : 1;
            const rotation = typeof seal.rotation_deg === "number" ? seal.rotation_deg : 0;
            // Seal dimensions in mm → points; fall back to a 30mm square.
            const wPts = mmToPoints(seal.image_width_mm || 30);
            const hPts = mmToPoints(seal.image_height_mm || 30);
            const offXPts = mmToPoints(seal.offset_x_mm || 0);
            const offYPts = mmToPoints(seal.offset_y_mm || 0);

            // Translate position + offset into left/top/right/bottom anchors.
            const placement: Record<string, any> = {
              "bottom-right": { right: 10 + offXPts, bottom: 0 + offYPts },
              "bottom-left":  { left:  10 + offXPts, bottom: 0 + offYPts },
              "bottom-center": { left: "50%", marginLeft: -wPts / 2 + offXPts, bottom: 0 + offYPts },
              "top-right":    { right: 10 + offXPts, top:    0 + offYPts },
              "top-left":     { left:  10 + offXPts, top:    0 + offYPts },
              "top-center":   { left: "50%", marginLeft: -wPts / 2 + offXPts, top: 0 + offYPts },
            };
            const posStyle = placement[position] || placement["bottom-right"];

            // @react-pdf/renderer accepts a `transform` string array; older
            // builds only honour a single string. We use a single string for
            // broad compatibility — a 0deg rotation produces an identity
            // transform, so omitting it is also fine.
            const transform = rotation ? `rotate(${rotation}deg)` : undefined;

            return (
              <View
                style={[
                  styles.sealOverlay,
                  posStyle,
                  { width: wPts, height: hPts, opacity },
                  transform ? ({ transform } as any) : {},
                ]}
                wrap={false}
              >
                {/* eslint-disable-next-line jsx-a11y/alt-text */}
                <Image style={styles.sealImage} src={sealImageUrl} />
              </View>
            );
          })()}
        </View>

        {/* DOCUMENT NOTICE — legally required disclaimer per doc type */}
        <View style={styles.noticeBox} wrap={false}>
          <Text style={styles.noticeText}>{docNotice}</Text>
        </View>

        {/* ── FOOTER (memorandum — fixed, repeats on every page) ─────────
            Inlined directly as <View fixed> (NOT wrapped in a component,
            NOT conditionally rendered) so @react-pdf/renderer recognizes
            the fixed prop on ALL pages. The page-number Text render prop
            only works inside a fixed View that's a direct child of Page. */}
        <View style={styles.footer} fixed>
            {/* Left column — QR code */}
            <View style={styles.footerColLeft}>
              {showQr && qrCodeDataUrl ? (
                <View style={styles.footerQrWrap}>
                  {/* eslint-disable-next-line jsx-a11y/alt-text */}
                  <Image
                    style={{
                      width: qrSizePts,
                      height: qrSizePts,
                      objectFit: "contain",
                    }}
                    src={qrCodeDataUrl}
                  />
                  <Text style={styles.footerQrLabel}>Scan to verify</Text>
                </View>
              ) : null}
            </View>

            {/* Center column — tenant address + website/email only.
                Company name is NOT repeated here — it's already in the
                header (memorandum). */}
            <View style={styles.footerColCenter}>
              {(() => {
                const addrParts: string[] = [];
                if (tenant?.address_line) addrParts.push(tenant.address_line);
                const cityBits = [tenant?.postal_code, tenant?.city].filter(Boolean).join(" ");
                if (cityBits) addrParts.push(cityBits);
                if (tenant?.country) addrParts.push(countryName(tenant.country));
                const addrLine = addrParts.join(", ");
                const contactParts = [
                  tenant?.website,
                  tenant?.email,
                  tenant?.phone,
                ].filter(Boolean);
                return (
                  <View>
                    {addrLine ? (
                      <Text style={styles.footerAddrLine}>{addrLine}</Text>
                    ) : null}
                    {contactParts.length > 0 ? (
                      <Text style={styles.footerAddrLine}>{contactParts.join("  ·  ")}</Text>
                    ) : null}
                  </View>
                );
              })()}
            </View>

            {/* Right column — page number + issued-date line.
                2g-F4 fix (round 4): react-pdf v4 supports the `render` prop on <Text>
                elements inside a `fixed` View — use it for "Page X of Y"
                (was hardcoded "Page 1" on every page). Also mirrored to
                `packing-list.ts` and `marketplace/document-pdf.ts` so all
                three PDF templates render correct page numbers.
                2g-F5 fix (round 4): stamp the document's issue_date (original issue),
                not new Date() (regen time). Falls back to created_at, then now.
                2g-F22 fix (round 4): drop the redundant "Issued by VELOS CRM"
                sub-line — the company is already in the header (memorandum) +
                the doc title block says "Commercial Invoice X · <tenant name>".
                Replaced with the document number so the footer is self-identifying
                when the page is torn off + photocopied (legal-trade-document
                convention). */}
            <View style={styles.footerColRight}>
              <Text
                style={styles.footerPage}
                render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
              />
              <Text style={styles.footerSys}>
                {docTitleMap[docType]} {doc.number} · {fmtDate((doc as any).issue_date || doc.created_at)}
              </Text>
            </View>
        </View>
      </Page>
    </Document>
  );
}
