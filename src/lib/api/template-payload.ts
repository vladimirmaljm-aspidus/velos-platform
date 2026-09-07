import { normalizeBlocks } from "@/lib/utils/doc-blocks";

/**
 * Shared document-templates payload sanitizer (audit23 / audit35).
 *
 * The POST / PUT / preview document-template routes accept a JSON body from
 * the Template Studio editor. The column whitelist + clamps used to live
 * inline in the POST route; the live "Preview PDF" route (preview/route.ts)
 * renders with the SAME form payload, so the sanitization is now shared —
 * one definition of "what a template payload may contain", no drift between
 * what is SAVED and what is PREVIEWED.
 *
 * audit35 (Document Studio sync): the FRAME columns (page_*, header_*,
 * footer_enabled/height/footer_show_*) are REMOVED from the whitelist —
 * they have been dead since audit33 (the renderer reads the frame from
 * memorandum_settings ONLY). Old editor payloads that still carry them get
 * them silently dropped (compat) instead of stored-and-ignored: nothing
 * outside the memorandum route can ever touch the frame. footer_content
 * stays — it renders as the memo footer's center note lines.
 * Added: content_json (the Document Studio block body).
 */

export const TEMPLATE_COLUMNS = new Set([
  "name", "type", "is_default",
  // NOTE: page_*/header_*/footer_* frame columns are intentionally absent —
  // memorandum-owned since audit33, hard-dropped since audit35.
  "footer_content",
  "body_font_family", "body_font_size", "body_line_height",
  "primary_color", "accent_color",
  "table_header_bg", "table_header_color", "table_border_color", "table_stripe",
  "letterhead_id", "seal_id", "seal_enabled", "selected_bank_accounts",
  // audit22 Template Studio — extended styling + visual layout blobs.
  "style_json", "layout_json",
  // audit35 Document Studio — block-authored body.
  "content_json",
]);

/** Frame columns dropped by the sanitizer (audit35). Exported for the
 *  routes' compat logging and for tests. */
export const DROPPED_FRAME_COLUMNS = new Set([
  "page_size", "page_margin_top", "page_margin_bottom", "page_margin_left", "page_margin_right",
  "header_enabled", "header_height", "header_content", "header_show_logo", "header_show_company_name", "header_show_contact",
  "footer_enabled", "footer_height", "footer_show_page_number", "footer_show_bank_details", "footer_show_tax_id",
  "qr_position", "qr_size_mm", "qr_opacity",
]);

export const TEMPLATE_TYPES = new Set(["offer", "invoice", "proforma", "contract", "loi", "generic"]);
export const TEMPLATE_PAGE_SIZES = new Set(["A4", "Letter"]);

// (column → [min, max]) — clamped instead of 400'd so a fat-fingered value
// still saves (the print layout stays usable); non-numeric junk is DROPPED
// so the store defaults apply instead of poisoning the column with null/NaN.
export const TEMPLATE_CLAMPS: Record<string, [number, number]> = {
  body_font_size: [6, 16], body_line_height: [1, 2.5],
};

// Columns that are Int in the schema (vs Float) — rounded after clamping so
// a JSON float like 11.5 can't 500 the insert on the int columns.
export const TEMPLATE_INT_COLUMNS = new Set([
  "body_font_size",
]);

export interface SanitizedTemplate {
  sanitized: Record<string, unknown>;
  dropped: string[];
}

/**
 * Whitelist + clamp a template payload (the editor form object).
 *   • unknown keys are dropped (and reported) — they would either 500 the
 *     supabase smartUpsert or mass-assign DB-managed columns
 *   • numeric columns are clamped into their safe range
 *   • junk numerics are dropped so store defaults apply
 *   • style_json / layout_json are shape + size guarded (≤ 32 KB)
 *
 * Invalid `type` / `page_size` values are REJECTED (throws) — the caller
 * maps that to a 400. Mirrors the audit20 / 20-b POST semantics.
 */
export function sanitizeTemplatePayload(body: Record<string, unknown>): SanitizedTemplate {
  const sanitized: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (k === "id" || k === "tenant_id" || k === "created_by") continue;
    if (TEMPLATE_COLUMNS.has(k)) sanitized[k] = v;
    else dropped.push(k);
  }
  if (dropped.length) {
    console.warn(`[template-payload] dropped unknown fields: ${dropped.join(", ")}`);
  }

  // Type — hard reject (caller 400s).
  if (sanitized.type !== undefined && (typeof sanitized.type !== "string" || !TEMPLATE_TYPES.has(sanitized.type))) {
    throw new Error("Invalid template type. Allowed: offer, invoice, proforma, contract, loi, generic.");
  }

  // Numeric clamping.
  for (const [col, [min, max]] of Object.entries(TEMPLATE_CLAMPS)) {
    if (sanitized[col] === undefined || sanitized[col] === null) {
      delete sanitized[col];
      continue;
    }
    const n = Number(sanitized[col]);
    if (!Number.isFinite(n)) {
      console.warn(`[template-payload] dropped non-numeric ${col}`);
      delete sanitized[col];
      continue;
    }
    const clamped = Math.min(max, Math.max(min, n));
    sanitized[col] = TEMPLATE_INT_COLUMNS.has(col) ? Math.round(clamped) : clamped;
  }

  // selected_bank_accounts — null or integer index array.
  if (sanitized.selected_bank_accounts !== undefined) {
    const v = sanitized.selected_bank_accounts;
    const ok = v === null || (Array.isArray(v) && v.every((x) => Number.isInteger(x) && x >= 0));
    if (!ok) {
      console.warn("[template-payload] dropped invalid selected_bank_accounts");
      delete sanitized.selected_bank_accounts;
    }
  }

  // style_json / layout_json — null or plain object ≤ 32 KB.
  for (const col of ["style_json", "layout_json"] as const) {
    if (sanitized[col] === undefined) continue;
    const v = sanitized[col];
    const ok = v === null || (typeof v === "object" && !Array.isArray(v));
    const size = ok ? JSON.stringify(v ?? "").length : 0;
    if (!ok || size > 32768) {
      console.warn(`[template-payload] dropped invalid ${col}${ok ? " (too large)" : ""}`);
      delete sanitized[col];
    }
  }

  // content_json (audit35 Document Studio) — the block body. Strictly
  // normalized through the SAME gate the renderer uses: junk degrades to
  // a DROP (never nulls existing content — a bad payload can't wipe a
  // good body). null / "" are honoured (clears the block body on purpose).
  if (sanitized.content_json !== undefined) {
    const v = sanitized.content_json;
    if (v === null || v === "" ) {
      sanitized.content_json = null;
    } else {
      const normalized = normalizeBlocks(v);
      if (!normalized) {
        console.warn("[template-payload] dropped invalid content_json");
        delete sanitized.content_json;
      } else {
        sanitized.content_json = normalized;
      }
    }
  }

  return { sanitized, dropped };
}
