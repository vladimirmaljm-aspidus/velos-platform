/**
 * Content config utilities for document templates.
 * 
 * These functions are shared between the client-side content editor
 * (src/components/common/template-content-editor.tsx) and the server-side
 * PDF generator (src/lib/pdf/templates.tsx).
 * 
 * They MUST NOT have "use client" — they're imported by server code.
 */

export interface SegmentBorder {
  color: string;
  width: number; // pt
  style?: "solid" | "dashed";
}

/**
 * Word-grade segment (audit22 "Template Studio").
 *
 * The original audit20 segment carried 6 properties (fontSize/bold/italic/
 * color/alignment/text). This extension adds the full paragraph-typography
 * surface Word users expect — per-paragraph spacing, line & letter spacing,
 * highlight backgrounds, borders/dividers, text transforms, opacity, padding.
 *
 * ALL new properties are optional with sane defaults so existing stored JSON
 * (production templates from audit20/21) parses unchanged — normalizeSegment()
 * fills defaults and clamps every value. The SAME normalization runs in the
 * browser (live preview) and the PDF renderer, so preview == output.
 */
export interface ContentSegment {
  id: string;
  text: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  color: string;
  alignment: "left" | "center" | "right";
  // ── audit22 additions (all optional) ──────────────────────────────
  /** Base react-pdf family. Default: inherit template body font. */
  fontFamily?: string;
  underline?: boolean;
  strike?: boolean;
  /** Highlight background (hex). Empty/undefined = transparent. */
  bgColor?: string;
  /** Letter spacing in pt (Word: "Expanded/Condensed"). */
  letterSpacing?: number;
  /** Line-height multiplier for this paragraph. */
  lineHeight?: number;
  /** Space ABOVE the paragraph in mm (Word: "Spacing Before"). */
  spacingBefore?: number;
  /** Space BELOW the paragraph in mm (Word: "Spacing After"). */
  spacingAfter?: number;
  textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
  /** 0..1 — soft watermark-style text. */
  opacity?: number;
  /** Paragraph inner padding in mm. */
  paddingY?: number;
  paddingX?: number;
  /** Full box border around the paragraph. false/undefined = none. */
  border?: SegmentBorder | false;
  /** Bottom rule / divider line only (classic letterhead look). */
  borderBottom?: SegmentBorder | false;
  /** Corner radius in pt (needs bgColor or border to be visible). */
  borderRadius?: number;
}

export interface ContentConfig {
  segments: ContentSegment[];
}

export interface PlaceholderData {
  company_name?: string | null;
  company_legal_name?: string | null;
  company_address?: string | null;
  company_city?: string | null;
  company_country?: string | null;
  company_postal_code?: string | null;
  company_reg?: string | null;
  company_vat?: string | null;
  company_tax_id?: string | null;
  company_phone?: string | null;
  company_email?: string | null;
  company_website?: string | null;
  bank_name?: string | null;
  bank_iban?: string | null;
  bank_swift?: string | null;
  doc_number?: string | null;
  doc_date?: string | null;
  valid_until?: string | null;
  due_date?: string | null;
  partner_name?: string | null;
  partner_address?: string | null;
  partner_city?: string | null;
  partner_country?: string | null;
  total?: string | null;
  currency?: string | null;
  page_number?: number;
  total_pages?: number;
}

/**
 * Parse a content config JSON string into a ContentConfig object.
 * Handles:
 * - null/empty → empty config
 * - JSON with segments array → parsed config
 * - Plain text string → wrapped as a single segment (backwards compat)
 */
export function parseContentConfig(content: string | null | undefined): ContentConfig {
  if (!content) return { segments: [] };
  
  try {
    const parsed = JSON.parse(content);
    if (parsed && Array.isArray(parsed.segments)) {
      return parsed as ContentConfig;
    }
  } catch {
    // Not valid JSON — treat as plain text
  }
  
  // Legacy plain text — wrap as a single segment
  return {
    segments: [{
      id: "legacy-1",
      text: content,
      fontSize: 9,
      bold: false,
      italic: false,
      color: "#666666",
      alignment: "left" as const,
    }],
  };
}

/**
 * Substitute placeholders in a text string with actual data.
 * Placeholders are in the format {placeholder_name}.
 * 
 * {page_number} and {total_pages} are left unchanged if not provided
 * (they're filled at PDF render time by react-pdf's <Text render> callback).
 */
// ── audit22: shared segment normalization ────────────────────────────────────
//
// The single source of truth for "what is a valid segment value". The Template
// Studio live preview (browser) AND the react-pdf renderer (server) both pass
// segments through normalizeSegment(), which clamps every numeric, validates
// every colour and fills every default. If it renders in the preview it
// renders in the PDF — no drift between the two code paths.

/** Font families the Template Studio exposes (all Unicode-safe or built-in). */
export const SEGMENT_FONTS = [
  { value: "NotoSans", label: "Sans (Noto)" },
  { value: "Times-Roman", label: "Serif (Times)" },
  { value: "Courier", label: "Mono (Courier)" },
] as const;

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function normColor(v: unknown, fallback: string): string {
  if (typeof v === "string" && HEX_RE.test(v.trim())) return v.trim().toLowerCase();
  return fallback;
}

function normNum(v: unknown, min: number, max: number, fallback: number, round = false): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.min(max, Math.max(min, n));
  return round ? Math.round(clamped) : clamped;
}

function normBool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function normAlign(v: unknown, fallback: ContentSegment["alignment"]): ContentSegment["alignment"] {
  return v === "left" || v === "center" || v === "right" ? v : fallback;
}

function normTransform(v: unknown): NonNullable<ContentSegment["textTransform"]> {
  return v === "uppercase" || v === "lowercase" || v === "capitalize" ? v : "none";
}

function normBorder(v: unknown): SegmentBorder | false {
  if (!v || typeof v !== "object") return false;
  const b = v as Partial<SegmentBorder>;
  return {
    color: normColor(b.color, "#d1d5db"),
    width: normNum(b.width, 0.25, 6, 0.5),
    style: b.style === "dashed" ? "dashed" : "solid",
  };
}

export function newSegmentId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Fully-normalized segment — every clamp applied, every default filled. */
export interface NormalizedSegment {
  id: string;
  text: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  color: string;
  alignment: "left" | "center" | "right";
  fontFamily: string;
  underline: boolean;
  strike: boolean;
  bgColor: string; // "" = transparent
  letterSpacing: number; // pt
  lineHeight: number;
  spacingBefore: number; // mm
  spacingAfter: number; // mm
  textTransform: "none" | "uppercase" | "lowercase" | "capitalize";
  opacity: number;
  paddingY: number; // mm
  paddingX: number; // mm
  border: SegmentBorder | false;
  borderBottom: SegmentBorder | false;
  borderRadius: number; // pt
}

/**
 * Clamp/sanitize one segment. Junk values degrade to defaults instead of
 * poisoning the render — same philosophy as the document-templates route.
 * Empty text still normalizes (invisible paragraph used as a spacer).
 */
export function normalizeSegment(seg: Partial<ContentSegment> & { id?: string }): NormalizedSegment {
  return {
    id: typeof seg.id === "string" && seg.id ? seg.id : newSegmentId(),
    text: typeof seg.text === "string" ? seg.text : "",
    fontSize: normNum(seg.fontSize, 4, 42, 9),
    bold: normBool(seg.bold),
    italic: normBool(seg.italic),
    color: normColor(seg.color, "#666666"),
    alignment: normAlign(seg.alignment, "left"),
    fontFamily:
      seg.fontFamily === "Times-Roman" || seg.fontFamily === "Courier" || seg.fontFamily === "NotoSans"
        ? seg.fontFamily
        : "NotoSans",
    underline: normBool(seg.underline),
    strike: normBool(seg.strike),
    bgColor: typeof seg.bgColor === "string" && HEX_RE.test(seg.bgColor.trim()) ? seg.bgColor.trim().toLowerCase() : "",
    letterSpacing: normNum(seg.letterSpacing, -1.5, 5, 0),
    lineHeight: normNum(seg.lineHeight, 0.8, 3, 1.35),
    spacingBefore: normNum(seg.spacingBefore, 0, 30, 0),
    spacingAfter: normNum(seg.spacingAfter, 0, 30, 0),
    textTransform: normTransform(seg.textTransform),
    opacity: normNum(seg.opacity, 0.1, 1, 1),
    paddingY: normNum(seg.paddingY, 0, 10, 0),
    paddingX: normNum(seg.paddingX, 0, 10, 0),
    border: normBorder(seg.border),
    borderBottom: normBorder(seg.borderBottom),
    borderRadius: normNum(seg.borderRadius, 0, 12, 0),
  };
}

/** Apply a text transform the way react-pdf/CSS would (shared by preview+PDF). */
export function applyTextTransform(text: string, transform: NormalizedSegment["textTransform"]): string {
  switch (transform) {
    case "uppercase": return text.toUpperCase();
    case "lowercase": return text.toLowerCase();
    case "capitalize":
      return text.replace(/(^|\s|[-(])(\p{L})/gu, (m) => m.toUpperCase());
    default: return text;
  }
}

/**
 * Substitute placeholders in a text string with actual data.
 * Placeholders are in the format {placeholder_name}.
 *
 * {page_number} and {total_pages} are left unchanged if not provided
 * (they're filled at PDF render time by react-pdf's <Text render> callback).
 */
export function substitutePlaceholders(text: string, data: PlaceholderData): string {
  let result = text;
  
  const replacements: Record<string, string> = {
    "{company_name}": data.company_name || "",
    "{company_legal_name}": data.company_legal_name || data.company_name || "",
    "{company_address}": data.company_address || "",
    "{company_city}": data.company_city || "",
    "{company_country}": data.company_country || "",
    "{company_postal_code}": data.company_postal_code || "",
    "{company_reg}": data.company_reg || "",
    "{company_registration_number}": data.company_reg || "",
    "{company_vat}": data.company_vat || "",
    "{company_vat_number}": data.company_vat || "",
    "{company_tax_id}": data.company_tax_id || "",
    "{company_phone}": data.company_phone || "",
    "{company_email}": data.company_email || "",
    "{company_website}": data.company_website || "",
    "{bank_name}": data.bank_name || "",
    "{bank_iban}": data.bank_iban || "",
    "{bank_swift}": data.bank_swift || "",
    "{doc_number}": data.doc_number || "",
    "{doc_date}": data.doc_date || "",
    "{valid_until}": data.valid_until || "",
    "{due_date}": data.due_date || "",
    "{partner_name}": data.partner_name || "",
    "{partner_address}": data.partner_address || "",
    "{partner_city}": data.partner_city || "",
    "{partner_country}": data.partner_country || "",
    "{total}": data.total || "",
    "{currency}": data.currency || "",
  };
  
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.split(placeholder).join(value);
  }
  
  // {page_number} and {total_pages} are left for react-pdf's render callback
  // Only replace if we have actual values (for live preview)
  if (data.page_number != null) {
    result = result.split("{page_number}").join(String(data.page_number));
  }
  if (data.total_pages != null) {
    result = result.split("{total_pages}").join(String(data.total_pages));
  }
  
  return result;
}

/**
 * Check if a text contains page-number placeholders that need
 * react-pdf's render callback (not static substitution).
 */
export function hasPagePlaceholders(text: string): boolean {
  return text.includes("{page_number}") || text.includes("{total_pages}");
}

// Default content JSON for new templates
export const DEFAULT_HEADER_CONTENT_JSON = JSON.stringify({
  segments: [
    {
      id: "h1",
      text: "{company_name}",
      fontSize: 14,
      bold: true,
      italic: false,
      color: "#0d9488",
      alignment: "left",
    },
    {
      id: "h2",
      text: "{company_address}, {company_city}, {company_country}",
      fontSize: 8,
      bold: false,
      italic: false,
      color: "#666666",
      alignment: "left",
    },
    {
      id: "h3",
      text: "Reg#: {company_reg} · VAT: {company_vat}",
      fontSize: 7.5,
      bold: false,
      italic: false,
      color: "#888888",
      alignment: "left",
    },
  ],
});

export const DEFAULT_FOOTER_CONTENT_JSON = JSON.stringify({
  segments: [
    {
      id: "f1",
      text: "{company_name} · Reg#: {company_reg} · Page {page_number} of {total_pages}",
      fontSize: 7.5,
      bold: false,
      italic: false,
      color: "#666666",
      alignment: "left",
    },
  ],
});
