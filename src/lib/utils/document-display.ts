/**
 * Per-document display options (migration 105).
 *
 * Single owner of the shape + parse + sanitize for the `display_options`
 * JSONB column on offers / proformas / invoices. The PDF renderer
 * (src/lib/pdf/templates.tsx) parses defensively off the raw row; the API
 * routes sanitize inbound bodies through `sanitizeDisplayOptions` before
 * the upsert — both import from HERE so they can never drift.
 *
 * Why per-document when the Template Studio already has layout toggles:
 * the Template owns tenant-wide DEFAULTS (every document of that family);
 * these options are the issuer's choice for ONE document (this invoice
 * has no service period; this offer must not show the bank block; this
 * invoice is reverse-charge and must say so).
 *
 * Client-safe module: no dependencies, no server imports.
 */

/** How the VAT row under the totals table is presented. */
export type VatDisplayMode =
  | "auto"           // factual: amount when tax_total is a number (0 included), no row when null
  | "amount"         // always the amount (even 0.00)
  | "reverse_charge" // the "Reverse charge — VAT settled by recipient" legend (EXPLICIT opt-in)
  | "custom"         // vat_custom_note text
  | "hidden";        // no VAT row at all

/** Tri-state visibility for optional columns/cells. */
export type TriStateVisibility = "auto" | "show" | "hide";

export interface DocumentDisplayOptions {
  /** VAT row presentation (see VatDisplayMode). Default "auto". */
  vat_mode?: VatDisplayMode;
  /** Free-text VAT note — rendered instead of the amount when vat_mode = "custom". */
  vat_custom_note?: string | null;
  /** Services nature: Service Period cell + Period column.
   *  "auto" (default) = show only when the doc or any line carries dates. */
  show_period?: TriStateVisibility;
  /** Services nature: "Place of Service" cell in the Service Details grid. Default true. */
  show_service_location?: boolean;
  /** "Payment" cell (goods Trade Terms grid AND services Service Details grid). Default true. */
  show_payment_terms?: boolean;
  /** Services nature: Quantity column. "auto" (default) = show. */
  show_quantity?: TriStateVisibility;
  /** Overrides the document title ("Invoice", "Tax Invoice", "Fee Note"…). */
  custom_title?: string | null;
  /** Legal notice box under the body (the per-doc-type disclaimer). Default true. */
  show_notice?: boolean;
  /** Replaces the default notice text when present. */
  custom_notice?: string | null;
  /** "Amount in Words" block under the grand total. Default true. */
  show_amount_words?: boolean;
  /** Bank details section. Default true (subject to the Template Studio layout too). */
  show_bank_details?: boolean;
  /** Authorized signatures block. Default true (subject to the Template Studio layout too). */
  show_signatures?: boolean;
  /** Custom header for the FROM party box. Default: "FROM (SELLER)" (goods) /
   *  "SERVICE PROVIDER (CONSULTANT)" (services). Free text — the issuer
   *  decides what the document calls each party. */
  from_label?: string | null;
  /** Custom header for the TO party box. Default: "TO (BUYER)" (goods) /
   *  "CLIENT" (services). */
  to_label?: string | null;
  /** QR verification code in the footer. Default true (still subject to the
   *  memorandum / template settings too). false = never rendered, even when
   *  the memorandum has QR enabled. */
  show_qr_code?: boolean;
}

const VAT_MODES = new Set<VatDisplayMode>(["auto", "amount", "reverse_charge", "custom", "hidden"]);
const TRI_STATES = new Set<TriStateVisibility>(["auto", "show", "hide"]);

function cleanString(v: unknown, maxLen: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, maxLen);
}

/**
 * Defensive parse of the raw `display_options` column (JSONB object, JSON
 * string, null, or garbage). Unknown keys are dropped; wrong-typed values
 * fall back to the built-in default. NEVER throws — a malformed column
 * renders the document with defaults instead of 500-ing the PDF.
 */
export function parseDisplayOptions(
  raw: unknown,
): DocumentDisplayOptions {
  let obj: any = raw;
  if (typeof raw === "string" && raw.trim()) {
    try { obj = JSON.parse(raw); } catch { obj = null; }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};

  const out: DocumentDisplayOptions = {};
  if (typeof obj.vat_mode === "string" && VAT_MODES.has(obj.vat_mode as VatDisplayMode)) {
    out.vat_mode = obj.vat_mode as VatDisplayMode;
  }
  const note = cleanString(obj.vat_custom_note, 300);
  if (note) out.vat_custom_note = note;
  if (typeof obj.show_period === "string" && TRI_STATES.has(obj.show_period as TriStateVisibility)) {
    out.show_period = obj.show_period as TriStateVisibility;
  }
  if (typeof obj.show_service_location === "boolean") out.show_service_location = obj.show_service_location;
  if (typeof obj.show_payment_terms === "boolean") out.show_payment_terms = obj.show_payment_terms;
  if (typeof obj.show_quantity === "string" && TRI_STATES.has(obj.show_quantity as TriStateVisibility)) {
    out.show_quantity = obj.show_quantity as TriStateVisibility;
  }
  const title = cleanString(obj.custom_title, 120);
  if (title) out.custom_title = title;
  if (typeof obj.show_notice === "boolean") out.show_notice = obj.show_notice;
  const notice = cleanString(obj.custom_notice, 500);
  if (notice) out.custom_notice = notice;
  if (typeof obj.show_amount_words === "boolean") out.show_amount_words = obj.show_amount_words;
  if (typeof obj.show_bank_details === "boolean") out.show_bank_details = obj.show_bank_details;
  if (typeof obj.show_signatures === "boolean") out.show_signatures = obj.show_signatures;
  const fromLabel = cleanString(obj.from_label, 60);
  if (fromLabel) out.from_label = fromLabel;
  const toLabel = cleanString(obj.to_label, 60);
  if (toLabel) out.to_label = toLabel;
  if (typeof obj.show_qr_code === "boolean") out.show_qr_code = obj.show_qr_code;
  return out;
}

/**
 * Server-side validation for POST/PUT bodies. Returns a CLEAN
 * DocumentDisplayOptions object, or null when the input carries nothing
 * usable (so callers can drop the key entirely / keep the stored value).
 * Mirrors parseDisplayOptions (same rules) — kept separate so the API can
 * evolve stricter validation (length caps, rate limits) without touching
 * the PDF's defensive reader.
 */
export function sanitizeDisplayOptions(
  raw: unknown,
): DocumentDisplayOptions | null {
  const parsed = parseDisplayOptions(raw);
  return Object.keys(parsed).length > 0 ? parsed : null;
}

/** True when the option object would change nothing (all defaults). */
export function isDefaultDisplayOptions(opts: DocumentDisplayOptions | null | undefined): boolean {
  return !opts || Object.keys(opts).length === 0;
}
