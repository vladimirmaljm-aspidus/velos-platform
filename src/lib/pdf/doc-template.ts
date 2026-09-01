// ─────────────────────────────────────────────────────────────────────────────
// DocumentTemplate → PDF bridge (audit20 / task 20-a).
//
// Until audit20 the `document_templates` table was a write-only subsystem: the
// template editor UI saved page size, margins, header/footer content segments,
// colours, table styling, letterhead/seal links, QR placement and bank-account
// selection — and NOTHING read them back. PDFs were styled exclusively from
// `memorandum_settings` (migration 003, which even bragged about "replacing
// the complex document_templates module").
//
// This module resolves the right DocumentTemplate row for a (tenant, docType)
// pair so the generator can style the PDF from it. Precedence per field is:
//   DocumentTemplate value → memorandum_settings value → built-in default
// (implemented in templates.tsx). Tenants that never seeded/opened the
// Document Templates page fall through to memorandum_settings unchanged.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  DocumentTemplate,
  Tenant,
  Partner,
  TenantLetterhead,
  Offer,
  Invoice,
  Proforma,
  LetterOfIntent,
} from "@/lib/supabase/types";
import { fmtDateIso, fmtMoney } from "@/lib/pdf/shared";
import { parseContentConfig, type ContentSegment, type PlaceholderData } from "@/lib/utils/content-config";

/** Store surface required by the resolver (satisfied by all store impls). */
export interface TemplateResolverStore {
  listDocumentTemplates(tenantId: string): Promise<DocumentTemplate[]>;
}

/**
 * docType (PDF pipeline) → candidate DocumentTemplate.type values, in order.
 *  • offer/invoice/proforma map to their own type, then the generic fallback.
 *  • loi has no dedicated template type — "generic" is the natural home
 *    (a letter of intent isn't a commercial offer), with "offer" as a
 *    second-chance fallback for tenants that only configured an offer look.
 *  • contract/generic template types exist in the model but no contract PDF
 *    is generated today; "generic" rows serve LOI + future doc types.
 */
const TEMPLATE_TYPE_CANDIDATES: Record<string, string[]> = {
  offer: ["offer", "generic"],
  invoice: ["invoice", "generic"],
  proforma: ["proforma", "generic"],
  loi: ["generic", "offer"],
};

/**
 * Pick the DocumentTemplate that styles a (tenant, docType) PDF.
 *
 * Selection order within each candidate type:
 *   1. the template flagged is_default (the UI enforces one default per
 *      (tenant, type) — audit20 also fixed the supabase store to maintain it)
 *   2. failing that, the most recently updated template of that type
 *
 * Returns null when the tenant has no usable template row — the PDF then
 * falls back to memorandum_settings / built-in defaults (previous behaviour).
 * Never throws: a broken templates table must not break PDF generation.
 */
export async function resolveDocumentTemplate(
  store: TemplateResolverStore,
  tenantId: string,
  docType: string,
): Promise<DocumentTemplate | null> {
  let templates: DocumentTemplate[] = [];
  try {
    templates = await store.listDocumentTemplates(tenantId);
  } catch (err) {
    console.warn("[pdf.doc-template] listDocumentTemplates failed — continuing without template:", err);
    return null;
  }
  if (!Array.isArray(templates) || templates.length === 0) return null;

  const candidates = TEMPLATE_TYPE_CANDIDATES[docType] || ["generic"];
  for (const type of candidates) {
    const oftype = templates.filter((t) => t && t.type === type);
    if (oftype.length === 0) continue;
    const def = oftype.find((t) => t.is_default === true);
    if (def) return def;
    // No flagged default — most recently updated wins (deterministic).
    const sorted = [...oftype].sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    return sorted[0];
  }
  return null;
}

// ─── QR placement (footer_content._qrConfig) ─────────────────────────────────
//
// QR position / size / opacity are NOT real document_templates columns — the
// template editor serialises them into the footer_content JSON under a
// reserved `_qrConfig` key (see document-templates-view.tsx → handleSave).
// parseContentConfig() ignores that key, so segments rendering is unaffected.
// This is the server-side reader — mirror of the UI's parseQrConfig.

export interface TemplateQrConfig {
  position: "footer-left" | "footer-center" | "footer-right" | "none";
  size: number; // mm
  opacity: number; // 0..1
}

const QR_DEFAULTS: TemplateQrConfig = { position: "footer-right", size: 15, opacity: 1 };

export function readTemplateQrConfig(footerContent: string | null | undefined): TemplateQrConfig {
  if (!footerContent) return { ...QR_DEFAULTS };
  try {
    const parsed = JSON.parse(footerContent);
    const q = parsed?._qrConfig;
    if (q && typeof q === "object") {
      const position =
        q.position === "footer-left" || q.position === "footer-center" || q.position === "footer-right" || q.position === "none"
          ? q.position
          : QR_DEFAULTS.position;
      return {
        position,
        size: typeof q.size === "number" && q.size > 0 ? Math.min(q.size, 40) : QR_DEFAULTS.size,
        opacity: typeof q.opacity === "number" ? Math.max(0, Math.min(q.opacity, 1)) : QR_DEFAULTS.opacity,
      };
    }
  } catch {
    // legacy plain-text footer — fall through to defaults
  }
  return { ...QR_DEFAULTS };
}

// ─── Segments helpers ────────────────────────────────────────────────────────

/**
 * Parse a template header/footer content column into renderable segments.
 * Empty content → [] (the caller falls back to the auto header/footer).
 * Plain-text legacy content → a single muted segment (parseContentConfig
 * already handles that).
 */
export function templateSegments(content: string | null | undefined): ContentSegment[] {
  if (!content || !String(content).trim()) return [];
  try {
    return parseContentConfig(content).segments;
  } catch {
    return [];
  }
}

// ─── Visual layout (audit22 — layout_json column) ────────────────────────────
//
// The drag-and-drop Template Studio persists its field layout (x/y/width/
// height in mm, visibility, locks, per-field props) into the layout_json
// jsonb column. The PDF renderer honors:
//   • body-section visibility  (e.g. hide trade_terms / specifications)
//   • custom_text / custom_image fields → rendered at their ABSOLUTE x/y
//     position on every page (fixed overlays, like Word text boxes)
// Everything else (body flow order) stays the canonical trade-document
// layout so multi-page tables keep paginating correctly.

export interface TemplateFieldLayout {
  id: string;
  type: string;
  /** Display label from the visual editor (custom fields keep theirs). */
  label?: string;
  x: number; // mm from page left
  y: number; // mm from page top
  width: number; // mm
  height: number; // mm
  visible: boolean;
  locked: boolean;
  props?: Record<string, unknown>;
}

export interface TemplateLayout {
  fields: TemplateFieldLayout[];
}

function num(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Parse + clamp the layout_json column. Returns null when absent/junk —
 * the renderer then uses its built-in default layout (previous behaviour).
 */
export function readTemplateLayout(json: unknown): TemplateLayout | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const fields = (json as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return null;
  const out: TemplateFieldLayout[] = [];
  for (const f of fields) {
    if (!f || typeof f !== "object") continue;
    const r = f as Record<string, unknown>;
    const type = typeof r.type === "string" ? r.type : "";
    if (!type) continue;
    out.push({
      id: typeof r.id === "string" ? r.id : `f${out.length}`,
      type,
      label: typeof r.label === "string" ? r.label : undefined,
      x: num(r.x, -20, 250, 15),
      y: num(r.y, -20, 400, 20),
      width: num(r.width, 5, 250, 60),
      height: num(r.height, 3, 300, 10),
      visible: r.visible !== false,
      locked: r.locked === true,
      props: (r.props && typeof r.props === "object" && !Array.isArray(r.props))
        ? (r.props as Record<string, unknown>)
        : {},
    });
  }
  return { fields: out };
}

// ─── Placeholder data ────────────────────────────────────────────────────────

/**
 * Build the {token} substitution data for template header/footer segments.
 * Letterhead values win over tenant values when the letterhead row carries
 * them (the letterhead is the tenant's explicit "memorandum firme" — its
 * company fields are the curated presentation of the company).
 */
export function buildPlaceholderData(args: {
  doc: Offer | Invoice | Proforma | LetterOfIntent;
  tenant: Tenant | null;
  partner: Partner | null;
  letterhead?: TenantLetterhead | null;
}): PlaceholderData {
  const { doc, tenant, partner, letterhead } = args;
  const d = doc as any;
  const lh = letterhead || null;
  const companyName = lh?.company_legal_name || lh?.company_name || tenant?.legal_name || tenant?.name || "";
  const currency = doc.currency || tenant?.currency || "USD";
  const total = (d as any).total ?? (d as any).total_value;
  return {
    company_name: lh?.company_name || tenant?.name || "",
    company_legal_name: lh?.company_legal_name || tenant?.legal_name || tenant?.name || "",
    company_address: lh?.company_address_line || tenant?.address_line || "",
    company_city: lh?.company_city || tenant?.city || "",
    company_country: lh?.company_country || tenant?.country || "",
    company_postal_code: lh?.company_postal_code || tenant?.postal_code || "",
    company_reg: lh?.company_registration_number || tenant?.registration_number || "",
    company_vat: lh?.company_vat_number || tenant?.vat_number || "",
    company_tax_id: lh?.company_tax_id || tenant?.tax_id || "",
    company_phone: lh?.company_phone || tenant?.phone || "",
    company_email: lh?.company_email || tenant?.email || "",
    company_website: lh?.company_website || tenant?.website || "",
    bank_name: tenant?.bank_name || "",
    bank_iban: tenant?.bank_iban || "",
    bank_swift: tenant?.bank_swift || "",
    doc_number: doc.number || "",
    doc_date: fmtDateIso(d.issue_date || doc.created_at),
    valid_until: fmtDateIso(d.valid_until || d.validity_until || null),
    due_date: fmtDateIso(d.due_date || null),
    partner_name: partner?.name || "",
    partner_address: partner?.address_line || "",
    partner_city: partner?.city || "",
    partner_country: partner?.country || "",
    total: typeof total === "number" ? fmtMoney(total, currency) : "",
    currency,
    // page_number / total_pages are filled by react-pdf's <Text render> prop
  };
}
