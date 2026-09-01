/**
 * Template style config (audit22 "Template Studio").
 *
 * Extended document styling that does NOT fit the per-segment model:
 * body typography, line-items table styling (column widths, cell padding,
 * header treatment), party boxes, totals block, notice box and the document
 * title treatment. Stored in the document_templates.style_json jsonb column
 * (migration 082) as ONE object — same pattern as header/footer segments
 * living in header_content/footer_content.
 *
 * Shared between the browser (Template Studio panels + live preview) and the
 * server PDF renderer. parseStyleConfig() normalizes/clamps everything so
 * junk degrades to defaults instead of breaking the render. NO "use client"
 * — imported by server code.
 */

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function hex(v: unknown, fallback: string): string {
  if (typeof v === "string" && HEX_RE.test(v.trim())) return v.trim().toLowerCase();
  return fallback;
}

function num(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

// ─── Config interfaces (normalized forms) ────────────────────────────────────

export interface TableStyle {
  /** Header row background. */
  headerBg: string;
  /** Header row text colour. */
  headerColor: string;
  /** Header row font size (pt). */
  headerFontSize: number;
  /** Header row bold. */
  headerBold: boolean;
  /** Header row text transform. */
  headerTransform: "none" | "uppercase";
  /** Header row vertical padding (mm). */
  headerPaddingY: number;
  /** Body cell font size (pt). */
  cellFontSize: number;
  /** Body cell vertical padding (mm). */
  cellPaddingY: number;
  /** Grid/outer border colour. */
  borderColor: string;
  /** Border line width (pt). */
  borderWidth: number;
  /** Zebra striping on/off. */
  stripe: boolean;
  /** Zebra stripe row background. */
  stripeColor: string;
  /** Alignment of numeric columns (qty/price/total). */
  numericAlign: "left" | "center" | "right";
  /** Column widths in percent — must sum ~100 (renormalized on parse).
   *  Keys: sku, name, qty, unit, price, total. */
  columnWidths: Record<string, number>;
}

export interface PartyBoxStyle {
  borderColor: string;
  bgColor: string;
  labelColor: string;
  valueColor: string;
  borderWidth: number;
  borderRadius: number;
  /** Gap between the From and To boxes (mm). */
  gap: number;
}

export interface TotalsStyle {
  labelColor: string;
  valueColor: string;
  grandBgColor: string;
  grandColor: string;
  grandBold: boolean;
  borderWidth: number;
  borderColor: string;
}

export interface TitleStyle {
  fontSize: number;
  color: string;
  letterSpacing: number;
  transform: "none" | "uppercase";
  underline: boolean;
  /** Space below the document title (mm). */
  spacingAfter: number;
  /** Rule line under the title. */
  showRule: boolean;
  ruleColor: string;
}

export interface BodyStyle {
  textColor: string;
  labelColor: string;
  valueColor: string;
  /** Default space between body sections (mm). */
  sectionSpacing: number;
}

export interface NoticeStyle {
  bgColor: string;
  borderColor: string;
  textColor: string;
  fontSize: number;
}

export interface TemplateStyleConfig {
  body: BodyStyle;
  title: TitleStyle;
  table: TableStyle;
  party: PartyBoxStyle;
  totals: TotalsStyle;
  notice: NoticeStyle;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

/** Column keys match the real line-items table (7 columns). Values are
 *  percent widths; parseStyleConfig renormalizes to ~100. */
export const DEFAULT_TABLE_COLUMN_WIDTHS: Record<string, number> = {
  rowNum: 3.5, description: 35, hsCode: 13, origin: 10.5,
  quantity: 13, unitPrice: 12, total: 13,
};

/** The subset of columns the Template Studio table editor exposes in order. */
export const TABLE_COLUMN_KEYS = [
  "rowNum", "description", "hsCode", "origin", "quantity", "unitPrice", "total",
] as const;

export const DEFAULT_STYLE_CONFIG: TemplateStyleConfig = {
  body: {
    textColor: "#1a1a1a",
    labelColor: "#6b7280",
    valueColor: "#111827",
    sectionSpacing: 4,
  },
  title: {
    fontSize: 16,
    color: "#0d9488",
    letterSpacing: 1.5,
    transform: "uppercase",
    underline: false,
    spacingAfter: 3,
    showRule: true,
    ruleColor: "#e5e7eb",
  },
  table: {
    headerBg: "#f3f4f6",
    headerColor: "#111827",
    headerFontSize: 8,
    headerBold: true,
    headerTransform: "uppercase",
    headerPaddingY: 1.4,
    cellFontSize: 8,
    cellPaddingY: 1.4,
    borderColor: "#e5e7eb",
    borderWidth: 0.5,
    stripe: true,
    stripeColor: "#f9fafb",
    numericAlign: "right",
    columnWidths: { ...DEFAULT_TABLE_COLUMN_WIDTHS },
  },
  party: {
    borderColor: "#e5e7eb",
    bgColor: "#ffffff",
    labelColor: "#6b7280",
    valueColor: "#111827",
    borderWidth: 0.75,
    borderRadius: 3,
    gap: 5,
  },
  totals: {
    labelColor: "#374151",
    valueColor: "#111827",
    grandBgColor: "#ecfdf5",
    grandColor: "#065f46",
    grandBold: true,
    borderWidth: 0.5,
    borderColor: "#e5e7eb",
  },
  notice: {
    bgColor: "#fffbeb",
    borderColor: "#fcd34d",
    textColor: "#92400e",
    fontSize: 7.5,
  },
};

// ─── Parser / normalizer ─────────────────────────────────────────────────────

function parseColumnWidths(v: unknown): Record<string, number> {
  const out = { ...DEFAULT_TABLE_COLUMN_WIDTHS };
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const src = v as Record<string, unknown>;
    for (const key of Object.keys(out)) {
      const n = num(src[key], 3, 60, out[key]);
      out[key] = n;
    }
  }
  // Renormalize to ~100 total so a fat-fingered set still lays out.
  const total = Object.values(out).reduce((a, b) => a + b, 0);
  if (total > 0 && Math.abs(total - 100) > 0.5) {
    const k = 100 / total;
    for (const key of Object.keys(out)) out[key] = Math.round(out[key] * k * 10) / 10;
  }
  return out;
}

/**
 * Parse the style_json column into a fully-normalized TemplateStyleConfig.
 * Accepts null/undefined/junk → all defaults (previous templates keep their
 * exact current look — the PDF renderer treats missing keys as "inherit the
 * legacy built-in value").
 */
export function parseStyleConfig(json: unknown): TemplateStyleConfig {
  const raw = (json && typeof json === "object" && !Array.isArray(json) ? json : {}) as Record<string, any>;
  const body = raw.body || {};
  const title = raw.title || {};
  const table = raw.table || {};
  const party = raw.party || {};
  const totals = raw.totals || {};
  const notice = raw.notice || {};

  return {
    body: {
      textColor: hex(body.textColor, DEFAULT_STYLE_CONFIG.body.textColor),
      labelColor: hex(body.labelColor, DEFAULT_STYLE_CONFIG.body.labelColor),
      valueColor: hex(body.valueColor, DEFAULT_STYLE_CONFIG.body.valueColor),
      sectionSpacing: num(body.sectionSpacing, 0, 25, DEFAULT_STYLE_CONFIG.body.sectionSpacing),
    },
    title: {
      fontSize: num(title.fontSize, 10, 30, DEFAULT_STYLE_CONFIG.title.fontSize),
      color: hex(title.color, DEFAULT_STYLE_CONFIG.title.color),
      letterSpacing: num(title.letterSpacing, 0, 6, DEFAULT_STYLE_CONFIG.title.letterSpacing),
      transform: title.transform === "none" ? "none" : "uppercase",
      underline: bool(title.underline, DEFAULT_STYLE_CONFIG.title.underline),
      spacingAfter: num(title.spacingAfter, 0, 20, DEFAULT_STYLE_CONFIG.title.spacingAfter),
      showRule: bool(title.showRule, DEFAULT_STYLE_CONFIG.title.showRule),
      ruleColor: hex(title.ruleColor, DEFAULT_STYLE_CONFIG.title.ruleColor),
    },
    table: {
      headerBg: hex(table.headerBg, DEFAULT_STYLE_CONFIG.table.headerBg),
      headerColor: hex(table.headerColor, DEFAULT_STYLE_CONFIG.table.headerColor),
      headerFontSize: num(table.headerFontSize, 6, 14, DEFAULT_STYLE_CONFIG.table.headerFontSize),
      headerBold: bool(table.headerBold, DEFAULT_STYLE_CONFIG.table.headerBold),
      headerTransform: table.headerTransform === "none" ? "none" : "uppercase",
      headerPaddingY: num(table.headerPaddingY, 0.5, 6, DEFAULT_STYLE_CONFIG.table.headerPaddingY),
      cellFontSize: num(table.cellFontSize, 5, 13, DEFAULT_STYLE_CONFIG.table.cellFontSize),
      cellPaddingY: num(table.cellPaddingY, 0.5, 6, DEFAULT_STYLE_CONFIG.table.cellPaddingY),
      borderColor: hex(table.borderColor, DEFAULT_STYLE_CONFIG.table.borderColor),
      borderWidth: num(table.borderWidth, 0, 3, DEFAULT_STYLE_CONFIG.table.borderWidth),
      stripe: bool(table.stripe, DEFAULT_STYLE_CONFIG.table.stripe),
      stripeColor: hex(table.stripeColor, DEFAULT_STYLE_CONFIG.table.stripeColor),
      numericAlign:
        table.numericAlign === "left" || table.numericAlign === "center" ? table.numericAlign : "right",
      columnWidths: parseColumnWidths(table.columnWidths),
    },
    party: {
      borderColor: hex(party.borderColor, DEFAULT_STYLE_CONFIG.party.borderColor),
      bgColor: hex(party.bgColor, DEFAULT_STYLE_CONFIG.party.bgColor),
      labelColor: hex(party.labelColor, DEFAULT_STYLE_CONFIG.party.labelColor),
      valueColor: hex(party.valueColor, DEFAULT_STYLE_CONFIG.party.valueColor),
      borderWidth: num(party.borderWidth, 0, 3, DEFAULT_STYLE_CONFIG.party.borderWidth),
      borderRadius: num(party.borderRadius, 0, 10, DEFAULT_STYLE_CONFIG.party.borderRadius),
      gap: num(party.gap, 2, 15, DEFAULT_STYLE_CONFIG.party.gap),
    },
    totals: {
      labelColor: hex(totals.labelColor, DEFAULT_STYLE_CONFIG.totals.labelColor),
      valueColor: hex(totals.valueColor, DEFAULT_STYLE_CONFIG.totals.valueColor),
      grandBgColor: hex(totals.grandBgColor, DEFAULT_STYLE_CONFIG.totals.grandBgColor),
      grandColor: hex(totals.grandColor, DEFAULT_STYLE_CONFIG.totals.grandColor),
      grandBold: bool(totals.grandBold, DEFAULT_STYLE_CONFIG.totals.grandBold),
      borderWidth: num(totals.borderWidth, 0, 3, DEFAULT_STYLE_CONFIG.totals.borderWidth),
      borderColor: hex(totals.borderColor, DEFAULT_STYLE_CONFIG.totals.borderColor),
    },
    notice: {
      bgColor: hex(notice.bgColor, DEFAULT_STYLE_CONFIG.notice.bgColor),
      borderColor: hex(notice.borderColor, DEFAULT_STYLE_CONFIG.notice.borderColor),
      textColor: hex(notice.textColor, DEFAULT_STYLE_CONFIG.notice.textColor),
      fontSize: num(notice.fontSize, 5, 12, DEFAULT_STYLE_CONFIG.notice.fontSize),
    },
  };
}
