"use client";

/**
 * TemplateVisualEditor
 * --------------------
 * A drag-and-drop WYSIWYG editor for designing the layout of a PDF document
 * template. Users see a scaled A4/Letter page rendered with REAL content
 * (company name, logo, sample line items, totals, etc.) — not just labels.
 *
 * Features:
 *   • Live content preview — every field shows actual letterhead / template data
 *   • Logo size + position control — drag corner to resize, drag body to move
 *   • Multi-page preview — render 1 / 2 / 3 / 5 stacked pages
 *   • Inline text editing — header / footer / custom text via properties panel
 *   • Toolbar — ruler, grid, snap, add text, add image, zoom, page count
 *   • Snap engine — to page edges, page center, and other elements
 *   • mm ruler on top and left edges
 */

import * as React from "react";
import {
  Ruler,
  Move,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignVerticalJustifyStart,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  RotateCcw,
  Maximize2,
  Grid3x3,
  Plus,
  Type,
  Image as ImageIcon,
  ZoomIn,
  ZoomOut,
  GripVertical,
  Info,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { DocumentTemplate, TenantLetterhead } from "@/lib/supabase/types";
import { useT } from "@/lib/i18n/store";
import { readTemplateLayout } from "@/lib/pdf/doc-template";
import {
  parseContentConfig,
  substitutePlaceholders as substituteEnginePlaceholders,
  type ContentSegment,
  type PlaceholderData,
} from "@/lib/utils/content-config";

// ============================================================
// Types
// ============================================================

export type FieldType =
  | "header"
  | "logo"
  | "company_name"
  | "company_address"
  | "doc_title"
  | "doc_meta"
  | "from_box"
  | "to_box"
  | "trade_terms"
  | "line_items_table"
  | "specifications"
  | "totals"
  | "amount_in_words"
  | "offer_text"
  | "bank_details"
  | "signatures"
  | "seal"
  | "footer"
  | "custom_text"
  | "custom_image";

export interface FieldElement {
  id: string;
  type: FieldType;
  label: string;
  x: number; // mm from left
  y: number; // mm from top
  width: number; // mm
  height: number; // mm
  visible: boolean;
  locked: boolean;
  props?: Record<string, unknown>; // field-specific props (e.g. content, logoUrl, logoWidth)
}

interface SnapGuide {
  orientation: "horizontal" | "vertical";
  position: number; // mm
  type: "edge" | "center" | "element";
}

interface TemplateVisualEditorProps {
  template: Partial<DocumentTemplate>;
  onChange: (template: Partial<DocumentTemplate>) => void;
  /** Optional override; falls back to template.page_size, then A4. */
  pageSize?: "A4" | "Letter";
  /** Linked letterhead supplies real company name, logo URL, bank details, etc.
   *  Pass null when no letterhead is linked — the editor falls back to sample data. */
  letterhead: TenantLetterhead | null;
}

// ============================================================
// Constants
// ============================================================

const PAGE_DIMENSIONS = {
  A4: { width: 210, height: 297 }, // mm
  Letter: { width: 216, height: 279 },
} as const;

// Base screen scale: 1 mm → 2 px on screen at 100% zoom.
const BASE_SCALE = 2;

// Snap threshold in mm.
const SNAP_THRESHOLD = 3;

// Default field layout (positions in mm on A4). Logo is its own draggable element.
// `label` is a translation key (resolved via `t()` at render time).
const DEFAULT_FIELDS: FieldElement[] = [
  { id: "logo", type: "logo", label: "misc-tve-logo", x: 15, y: 8, width: 40, height: 15, visible: true, locked: false, props: { logoWidth: 40, logoHeight: 15 } },
  { id: "header", type: "header", label: "misc-tve-header-memorandum", x: 60, y: 8, width: 135, height: 15, visible: true, locked: false },
  { id: "doc_title", type: "doc_title", label: "misc-tve-doc-title", x: 15, y: 40, width: 180, height: 12, visible: true, locked: false },
  { id: "doc_meta", type: "doc_meta", label: "misc-tve-doc-meta", x: 15, y: 54, width: 180, height: 14, visible: true, locked: false },
  { id: "from_box", type: "from_box", label: "misc-tve-from-box", x: 15, y: 74, width: 87, height: 40, visible: true, locked: false },
  { id: "to_box", type: "to_box", label: "misc-tve-to-box", x: 108, y: 74, width: 87, height: 40, visible: true, locked: false },
  { id: "trade_terms", type: "trade_terms", label: "misc-tve-trade-terms", x: 15, y: 118, width: 180, height: 22, visible: true, locked: false },
  { id: "line_items_table", type: "line_items_table", label: "misc-tve-line-items", x: 15, y: 145, width: 180, height: 50, visible: true, locked: false },
  { id: "specifications", type: "specifications", label: "misc-tve-specifications", x: 15, y: 200, width: 180, height: 30, visible: true, locked: false },
  { id: "totals", type: "totals", label: "misc-tve-totals", x: 120, y: 235, width: 75, height: 25, visible: true, locked: false },
  { id: "amount_in_words", type: "amount_in_words", label: "misc-tve-amount-words", x: 15, y: 235, width: 100, height: 20, visible: true, locked: false },
  { id: "offer_text", type: "offer_text", label: "misc-tve-offer-text", x: 15, y: 255, width: 180, height: 18, visible: true, locked: false },
  { id: "bank_details", type: "bank_details", label: "misc-tve-bank-details", x: 15, y: 263, width: 180, height: 12, visible: true, locked: false },
  { id: "signatures", type: "signatures", label: "misc-tve-signatures", x: 15, y: 277, width: 180, height: 14, visible: true, locked: false },
  { id: "footer", type: "footer", label: "misc-tve-footer", x: 15, y: 286, width: 180, height: 8, visible: true, locked: false },
];

// ============================================================
// Sample data (realistic trade document examples)
// ============================================================

interface SampleRow {
  sku: string;
  name: string;
  qty: number;
  unit: string;
  price: number;
  total: number;
}

const SAMPLE_LINE_ITEMS: SampleRow[] = [
  { sku: "SUG-IC45", name: "White Sugar ICUMSA 45", qty: 24, unit: "MT", price: 540, total: 12960 },
  { sku: "WHT-1250", name: "Hard Red Winter Wheat", qty: 68, unit: "MT", price: 374, total: 25400 },
  { sku: "OIL-SUN", name: "Refined Sunflower Oil", qty: 8, unit: "MT", price: 1160, total: 9280 },
  { sku: "CMT-PC42", name: "Portland Cement 42.5N", qty: 200, unit: "MT", price: 78, total: 15600 },
  { sku: "ALU-A7", name: "Aluminium Ingot A7", qty: 40, unit: "MT", price: 2150, total: 86000 },
];

const DOC_TYPE_LABELS: Record<NonNullable<DocumentTemplate["type"]>, string> = {
  offer: "OFFER",
  invoice: "INVOICE",
  proforma: "PROFORMA INVOICE",
  contract: "CONTRACT",
  loi: "LETTER OF INTENT",
  generic: "DOCUMENT",
};

// ============================================================
// Draggable placeholder chips for inline text fields
// (header / footer / custom_text / offer_text / bank_details).
// Keys use the canonical {token} syntax consumed by the shared
// substitutePlaceholders() engine in content-config.ts — the same
// engine the PDF generator uses, so chips dropped into a field
// actually substitute at render time. `label` is a translation key.
// ============================================================
const PLACEHOLDERS: { key: string; label: string }[] = [
  { key: "{company_name}", label: "doc-var-company-name" },
  { key: "{company_legal_name}", label: "doc-var-legal-name" },
  { key: "{company_address}", label: "doc-var-address" },
  { key: "{company_city}", label: "doc-var-city" },
  { key: "{company_country}", label: "doc-var-country" },
  { key: "{company_reg}", label: "doc-var-reg" },
  { key: "{company_vat}", label: "doc-var-vat" },
  { key: "{company_tax_id}", label: "doc-var-tax-id" },
  { key: "{company_phone}", label: "doc-var-phone" },
  { key: "{company_email}", label: "doc-var-email" },
  { key: "{company_website}", label: "doc-var-website" },
  { key: "{bank_name}", label: "doc-var-bank" },
  { key: "{bank_iban}", label: "doc-var-iban" },
  { key: "{bank_swift}", label: "doc-var-swift" },
  { key: "{doc_number}", label: "doc-var-doc-num" },
  { key: "{doc_date}", label: "doc-var-doc-date" },
  { key: "{valid_until}", label: "doc-var-valid-until" },
  { key: "{due_date}", label: "doc-var-due-date" },
  { key: "{partner_name}", label: "doc-var-partner-name" },
  { key: "{partner_address}", label: "doc-var-partner-address" },
  { key: "{total}", label: "doc-var-total" },
  { key: "{currency}", label: "doc-var-currency" },
  { key: "{page_number}", label: "doc-var-page-num" },
  { key: "{total_pages}", label: "doc-var-total-pages" },
];

// ============================================================
// Live content helpers — pull real data from template + letterhead
// ============================================================

function buildCompanyAddress(letterhead: TenantLetterhead | null): string {
  if (!letterhead) return "Trg Republike 5, Belgrade";
  const parts: string[] = [];
  if (letterhead.company_address_line) parts.push(letterhead.company_address_line);
  const cityLine = [letterhead.company_postal_code, letterhead.company_city]
    .filter(Boolean)
    .join(" ");
  if (cityLine) parts.push(cityLine);
  if (letterhead.company_country) parts.push(letterhead.company_country);
  return parts.length ? parts.join(", ") : "Trg Republike 5, Belgrade";
}

function getCompanyName(letterhead: TenantLetterhead | null): string {
  return (
    letterhead?.company_name ||
    letterhead?.company_legal_name ||
    "VELOS Trading"
  );
}

function getLogoUrl(letterhead: TenantLetterhead | null): string | null {
  return letterhead?.logo_url || null;
}

function getRegNumber(letterhead: TenantLetterhead | null): string {
  return (
    letterhead?.company_registration_number ||
    "DMCC-889293"
  );
}

function getVatNumber(letterhead: TenantLetterhead | null): string | null {
  return letterhead?.company_vat_number || null;
}

/** Normalize the legacy {{token}} syntax to the canonical {token} syntax so
 *  both forms substitute through the shared engine, and map legacy token
 *  names (offered by the old {{...}} palettes) onto the engine's set. */
function normalizeLegacyTokens(text: string): string {
  return text
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, "{$1}")
    .replace(/{company_bank}/g, "{bank_name}")
    .replace(/{company_iban}/g, "{bank_iban}")
    .replace(/{company_swift}/g, "{bank_swift}")
    .replace(/{doc_valid}/g, "{valid_until}")
    .replace(/{page_total}/g, "{total_pages}")
    .replace(/{address}/g, "{company_address}")
    .replace(/{reg}/g, "{company_reg}")
    .replace(/{vat}/g, "{company_vat}")
    .replace(/{date}/g, "{doc_date}");
}

/** Substitute {placeholders} (plus legacy {{placeholders}}) with live data for
 *  inline text rendering. Delegates to the SAME substitution engine the PDF
 *  generator uses (content-config.ts) so the editor preview matches the PDF. */
function substituteForFieldPreview(
  text: string,
  letterhead: TenantLetterhead | null
): string {
  const data: PlaceholderData = {
    company_name: getCompanyName(letterhead),
    company_legal_name: letterhead?.company_legal_name || getCompanyName(letterhead),
    company_address: buildCompanyAddress(letterhead),
    company_city: letterhead?.company_city || "Belgrade",
    company_country: letterhead?.company_country || "Serbia",
    company_postal_code: letterhead?.company_postal_code || null,
    company_reg: getRegNumber(letterhead),
    company_vat: getVatNumber(letterhead),
    company_tax_id: letterhead?.company_tax_id || null,
    company_phone: letterhead?.company_phone || "+971 4 555 0100",
    company_email: letterhead?.company_email || "office@velos.trade",
    company_website: letterhead?.company_website || "www.velos.trade",
    bank_name: letterhead?.bank_name || "Abu Dhabi Islamic Bank",
    bank_iban: letterhead?.bank_iban || "AE11 0200 0000 1234 5678 901",
    bank_swift: letterhead?.bank_swift || "ABDIAEAD",
    doc_number: "OF-2026-0014",
    doc_date: "14 Mar 2026",
    valid_until: "14 Apr 2026",
    due_date: "14 Apr 2026",
    partner_name: "Mediterra Exports GmbH",
    partner_address: "Hafenstraße 4, 20457 Hamburg",
    partner_city: "Hamburg",
    partner_country: "Germany",
    total: "$42,196.00",
    currency: "USD",
    page_number: 1,
    total_pages: 5,
  };
  return substituteEnginePlaceholders(normalizeLegacyTokens(text || ""), data);
}

/** Convert stored header/footer content (segments JSON or legacy plain text)
 *  into the PLAIN TEXT shown in the content Textarea (segments joined with
 *  "\n" — never the raw JSON string). */
function contentToPlainText(content: string | null | undefined): string {
  if (!content) return "";
  return parseContentConfig(content)
    .segments.map((s) => s.text ?? "")
    .join("\n");
}

/** Persist edited plain text back into the segments JSON format used by
 *  header_content / footer_content:
 *  • exactly one existing segment → its text is updated in place (styling kept);
 *  • otherwise → the text is wrapped as a single default segment.
 *  Sibling JSON keys (e.g. the reserved `_qrConfig`) are preserved. */
function plainTextToContentJson(
  text: string,
  existing: string | null | undefined,
  segmentId: string
): string {
  let parsed: Record<string, unknown> | null = null;
  if (existing) {
    try {
      const maybe: unknown = JSON.parse(existing);
      if (
        maybe &&
        typeof maybe === "object" &&
        !Array.isArray(maybe) &&
        Array.isArray((maybe as { segments?: unknown }).segments)
      ) {
        parsed = maybe as Record<string, unknown>;
      }
    } catch {
      // Legacy plain text — fall through and wrap it.
    }
  }
  const segments = (parsed?.segments as ContentSegment[] | undefined) ?? [];
  if (parsed && segments.length === 1) {
    return JSON.stringify({ ...parsed, segments: [{ ...segments[0], text }] });
  }
  const segment: ContentSegment = {
    id: segmentId,
    text,
    fontSize: 9,
    bold: false,
    italic: false,
    color: "#666666",
    alignment: "left",
  };
  return JSON.stringify(parsed ? { ...parsed, segments: [segment] } : { segments: [segment] });
}

/** Resolve the text content to render for header / footer / custom_text fields. */
function resolveFieldContent(
  field: FieldElement,
  template: Partial<DocumentTemplate>
): string {
  const override = (field.props?.content as string) || "";
  if (override) return override;
  if (field.type === "header") return template.header_content || "";
  if (field.type === "footer") return template.footer_content || "";
  return "";
}

// ============================================================
// Live field content renderer
// ============================================================

function MiniLineItemsTable({ rows, t }: { rows: SampleRow[]; t: (k: string) => string }) {
  return (
    <table className="w-full border-collapse text-[6px] leading-tight">
      <thead>
        <tr className="bg-slate-700 text-white">
          <th className="border border-slate-400 px-0.5 py-0.5 text-left font-semibold">{t("misc-tve-sku")}</th>
          <th className="border border-slate-400 px-0.5 py-0.5 text-left font-semibold">{t("misc-product")}</th>
          <th className="border border-slate-400 px-0.5 py-0.5 text-right font-semibold">{t("misc-qty") || "Qty"}</th>
          <th className="border border-slate-400 px-0.5 py-0.5 text-right font-semibold">{t("misc-price")}</th>
          <th className="border border-slate-400 px-0.5 py-0.5 text-right font-semibold">{t("misc-total")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.sku} className={i % 2 === 1 ? "bg-slate-100" : ""}>
            <td className="border border-slate-300 px-0.5 py-0.5 text-teal-700 font-semibold">{r.sku}</td>
            <td className="border border-slate-300 px-0.5 py-0.5 truncate max-w-[60px]">{r.name}</td>
            <td className="border border-slate-300 px-0.5 py-0.5 text-right">{r.qty} {r.unit}</td>
            <td className="border border-slate-300 px-0.5 py-0.5 text-right">${r.price.toLocaleString()}</td>
            <td className="border border-slate-300 px-0.5 py-0.5 text-right font-semibold">${r.total.toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function renderFieldContent(
  field: FieldElement,
  template: Partial<DocumentTemplate>,
  letterhead: TenantLetterhead | null,
  t: (k: string) => string
): React.ReactNode {
  const companyName = getCompanyName(letterhead);
  const logoUrl = getLogoUrl(letterhead);
  const address = buildCompanyAddress(letterhead);
  const vat = getVatNumber(letterhead);
  const reg = getRegNumber(letterhead);
  const docType = template.type || "offer";
  const docTypeLabel = DOC_TYPE_LABELS[docType] || "DOCUMENT";
  const primaryColor = template.primary_color || letterhead?.primary_color || "#0f766e";
  const accentColor = template.accent_color || letterhead?.accent_color || "#0d9488";
  const bankName = letterhead?.bank_name || "Abu Dhabi Islamic Bank";
  const iban = letterhead?.bank_iban || "AE11 0200 0000 1234 5678 901";

  switch (field.type) {
    case "logo":
      return logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          alt="Company logo"
          className="h-full w-full object-contain"
          draggable={false}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-teal-700/10 text-[7px] font-semibold text-teal-700">
          {t("misc-tve-logo-placeholder")}
        </div>
      );

    case "header": {
      const cfg = parseContentConfig(resolveFieldContent(field, template));
      if (cfg.segments.length > 0) {
        // Render the real segments (styled + substituted) — never raw JSON.
        return (
          <div className="flex h-full w-full flex-col justify-center overflow-hidden">
            {cfg.segments.map((seg) => (
              <div
                key={seg.id}
                className="leading-tight"
                style={{
                  fontSize: `${Math.max(4, Math.round(seg.fontSize * 0.7))}px`,
                  fontWeight: seg.bold ? 700 : 400,
                  fontStyle: seg.italic ? "italic" : "normal",
                  color: seg.color,
                  textAlign: seg.alignment,
                }}
              >
                {substituteForFieldPreview(seg.text, letterhead)}
              </div>
            ))}
          </div>
        );
      }
      return (
        <div className="flex h-full w-full flex-col justify-center text-[6.5px] leading-tight">
          {template.header_show_company_name !== false && (
            <div className="text-[8px] font-bold leading-none" style={{ color: primaryColor }}>
              {companyName}
            </div>
          )}
          {template.header_show_contact !== false && (
            <div className="mt-0.5 text-slate-500 truncate">
              {address}
              {letterhead?.company_email ? ` · ${letterhead.company_email}` : ""}
              {letterhead?.company_phone ? ` · ${letterhead.company_phone}` : ""}
            </div>
          )}
        </div>
      );
    }

    case "company_name":
      return (
        <div className="text-[8px] font-bold" style={{ color: primaryColor }}>
          {companyName}
        </div>
      );

    case "company_address":
      return (
        <div className="text-[6px] text-slate-500 leading-tight">{address}</div>
      );

    case "doc_title":
      return (
        <div className="flex h-full w-full items-center">
          <span className="text-xs font-extrabold tracking-[0.15em]" style={{ color: primaryColor }}>
            {docTypeLabel}
          </span>
        </div>
      );

    case "doc_meta":
      return (
        <div className="flex h-full w-full items-center justify-between text-[6.5px] text-slate-600">
          <span>{t("misc-number")}: <span className="font-semibold text-slate-800">OF-2026-0014</span></span>
          <span>{t("misc-date")}: <span className="font-semibold text-slate-800">14 Mar 2026</span></span>
          <span>Valid: <span className="font-semibold text-slate-800">14 Apr 2026</span></span>
        </div>
      );

    case "from_box":
      return (
        <div className="h-full w-full text-[6px] leading-tight">
          <div className="text-[6px] font-bold uppercase tracking-wide text-slate-400">{t("misc-tve-from-label")}</div>
          <div className="text-[7px] font-bold" style={{ color: primaryColor }}>{companyName}</div>
          <div className="text-slate-500">{address}</div>
          {vat && <div className="text-slate-500">{t("misc-tve-vat-label")}: {vat}</div>}
          {letterhead?.company_email && <div className="text-slate-500">{letterhead.company_email}</div>}
        </div>
      );

    case "to_box":
      return (
        <div className="h-full w-full text-[6px] leading-tight">
          <div className="text-[6px] font-bold uppercase tracking-wide text-slate-400">{t("misc-bill-to")}</div>
          <div className="text-[7px] font-bold text-slate-800">Mediterra Exports GmbH</div>
          <div className="text-slate-500">Hafenstraße 4, 20457 Hamburg</div>
          <div className="text-slate-500">Germany</div>
          <div className="text-slate-500">{t("misc-tve-vat-label")}: DE876543210</div>
        </div>
      );

    case "trade_terms":
      return (
        <div className="flex h-full w-full items-center justify-between text-[6.5px]">
          <span className="font-semibold text-slate-800">{t("misc-tve-incoterm")}: <span style={{ color: primaryColor }}>EXW · Hamburg</span></span>
          <span className="text-slate-500">{t("misc-tve-payment")}: <span className="font-semibold">Net 30</span></span>
        </div>
      );

    case "line_items_table":
      return <MiniLineItemsTable rows={SAMPLE_LINE_ITEMS.slice(0, 2)} t={t} />;

    case "specifications":
      return (
        <div className="h-full w-full text-[6px] leading-tight">
          <div className="text-[7px] font-bold text-slate-800">{t("misc-tve-specifications")}</div>
          <div className="text-slate-600">Moisture: ≤14% · Foreign matter: ≤2% · Broken: ≤5%</div>
          <div className="text-slate-600">Packing: 50kg PP bags · Origin: EU</div>
          <div className="text-slate-600">Inspection: SGS at loading port</div>
        </div>
      );

    case "totals": {
      const subtotal = 12960 + 25400; // matches SAMPLE_LINE_ITEMS.slice(0,2)
      const vat10 = Math.round(subtotal * 0.1);
      const total = subtotal + vat10;
      return (
        <div className="h-full w-full text-right text-[6.5px] leading-tight">
          <div className="flex justify-between text-slate-600"><span>{t("misc-subtotal")}</span><span>${subtotal.toLocaleString()}.00</span></div>
          <div className="flex justify-between text-slate-500"><span>{t("misc-tax")} (10%)</span><span>${vat10.toLocaleString()}.00</span></div>
          <div className="mt-0.5 flex justify-between border-t pt-0.5 font-bold" style={{ borderColor: primaryColor, color: primaryColor }}>
            <span>{t("misc-total")}</span><span>${total.toLocaleString()}.00</span>
          </div>
        </div>
      );
    }

    case "amount_in_words":
      return (
        <div className="h-full w-full text-[6px] italic leading-tight text-slate-600">
          <span className="font-semibold not-italic">{t("misc-tve-amount-words")}:</span> Forty-two thousand one hundred ninety-six US dollars only.
        </div>
      );

    case "offer_text":
      return (
        <div className="h-full w-full text-[6px] leading-tight text-slate-600">
          <span className="font-semibold" style={{ color: accentColor }}>{t("misc-terms")}: </span>
          30% advance, 70% before shipment. Delivery CIF Hamburg port. Inspection by SGS at loading.
        </div>
      );

    case "bank_details":
      return (
        <div className="h-full w-full text-[6px] leading-tight">
          <span className="font-semibold text-slate-800">{t("misc-tve-bank-label")}: </span>
          <span className="text-slate-700">{bankName}</span>
          <span className="text-slate-500"> · {t("misc-tve-iban-label")}: {iban}</span>
          {letterhead?.bank_swift && <span className="text-slate-500"> · {t("misc-tve-swift-label")}: {letterhead.bank_swift}</span>}
        </div>
      );

    case "signatures":
      return (
        <div className="flex h-full w-full items-end justify-between text-[6px] text-slate-600">
          <div className="flex flex-col items-center">
            <div className="border-t border-slate-500" style={{ width: 50 }} />
            <div className="mt-0.5">{t("misc-tve-seller-signature")}</div>
          </div>
          <div className="flex flex-col items-center">
            <div className="border-t border-slate-500" style={{ width: 50 }} />
            <div className="mt-0.5">{t("misc-tve-buyer-signature")}</div>
          </div>
        </div>
      );

    case "seal":
      return (
        <div className="flex h-full w-full items-center justify-center rounded-full border border-dashed border-slate-300 text-[6px] text-slate-400">
          {t("misc-tve-seal-placeholder")}
        </div>
      );

    case "footer": {
      const cfg = parseContentConfig(resolveFieldContent(field, template));
      if (cfg.segments.length > 0) {
        // Render the real segments (styled + substituted) — never raw JSON.
        return (
          <div className="flex h-full w-full flex-col justify-center overflow-hidden">
            {cfg.segments.map((seg) => (
              <div
                key={seg.id}
                className="truncate leading-tight"
                style={{
                  fontSize: `${Math.max(4, Math.round(seg.fontSize * 0.7))}px`,
                  fontWeight: seg.bold ? 700 : 400,
                  fontStyle: seg.italic ? "italic" : "normal",
                  color: seg.color,
                  textAlign: seg.alignment,
                }}
              >
                {substituteForFieldPreview(seg.text, letterhead)}
              </div>
            ))}
          </div>
        );
      }
      return (
        <div className="h-full w-full truncate text-[6px] text-slate-500">
          {`${companyName} · Reg#${reg}${vat ? ` · ${t("misc-tve-vat-label")}: ${vat}` : ""} · ${t("misc-tve-page-n-of-m").replace("{n}", "1").replace("{m}", "5")}`}
        </div>
      );
    }

    case "custom_text": {
      const text = (field.props?.content as string) || "";
      return (
        <div className="h-full w-full whitespace-pre-line text-[7px] leading-tight text-slate-700">
          {text || <span className="text-slate-400">{t(field.label)}</span>}
        </div>
      );
    }

    case "custom_image": {
      const url = (field.props?.imageUrl as string) || null;
      return url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={field.label} className="h-full w-full object-contain" draggable={false} />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-[7px] text-slate-400">
          {t("misc-tve-image-placeholder")}
        </div>
      );
    }

    default:
      return <span className="text-slate-700">{t(field.label)}</span>;
  }
}

// ============================================================
// Ruler Component
// ============================================================

/**
 * RulerBar renders a tick-marked ruler in mm units.
 * Renamed from `Ruler` to avoid clashing with the lucide-react icon of the same name.
 */
function RulerBar({
  orientation,
  length,
  scale,
}: {
  orientation: "horizontal" | "vertical";
  length: number;
  scale: number;
}) {
  const ticks: React.ReactNode[] = [];
  for (let i = 0; i <= length; i += 10) {
    const isMajor = i % 50 === 0;
    const tickLength = isMajor ? 8 : 4;
    const pos = i * scale;
    if (pos < 0) continue;
    ticks.push(
      <div
        key={i}
        className="absolute"
        style={
          orientation === "horizontal"
            ? { left: pos, top: 0, width: 1, height: tickLength }
            : { top: pos, left: 0, width: tickLength, height: 1 }
        }
      >
        <div className="h-full w-full bg-muted-foreground/40" />
        {isMajor && (
          <span
            className="absolute text-[8px] leading-none text-muted-foreground"
            style={
              orientation === "horizontal"
                ? { top: 10, left: 2 }
                : { left: 10, top: -2 }
            }
          >
            {i}
          </span>
        )}
      </div>
    );
  }
  return (
    <div
      className={cn(
        "relative overflow-hidden border-border bg-muted/20",
        orientation === "horizontal" ? "h-6 border-b" : "w-6 border-r"
      )}
    >
      {ticks}
    </div>
  );
}

// ============================================================
// Snap Engine
// ============================================================

function calculateSnapGuides(
  dragging: FieldElement,
  fields: FieldElement[],
  pageWidth: number,
  pageHeight: number
): SnapGuide[] {
  const guides: SnapGuide[] = [];

  // Page edge + center guides
  guides.push({ orientation: "vertical", position: 0, type: "edge" });
  guides.push({ orientation: "vertical", position: pageWidth, type: "edge" });
  guides.push({ orientation: "vertical", position: pageWidth / 2, type: "center" });
  guides.push({ orientation: "horizontal", position: 0, type: "edge" });
  guides.push({ orientation: "horizontal", position: pageHeight, type: "edge" });
  guides.push({ orientation: "horizontal", position: pageHeight / 2, type: "center" });

  // Other element edges + centers (the dragging element is excluded).
  for (const f of fields) {
    if (f.id === dragging.id || !f.visible) continue;
    guides.push({ orientation: "vertical", position: f.x, type: "element" });
    guides.push({ orientation: "vertical", position: f.x + f.width, type: "element" });
    guides.push({ orientation: "vertical", position: f.x + f.width / 2, type: "element" });
    guides.push({ orientation: "horizontal", position: f.y, type: "element" });
    guides.push({ orientation: "horizontal", position: f.y + f.height, type: "element" });
    guides.push({ orientation: "horizontal", position: f.y + f.height / 2, type: "element" });
  }

  return guides;
}

function findSnap(
  dragging: FieldElement,
  guides: SnapGuide[],
  threshold: number = SNAP_THRESHOLD
): { x?: number; y?: number; guides: SnapGuide[] } {
  const activeGuides: SnapGuide[] = [];
  let snapX: number | undefined;
  let snapY: number | undefined;

  const dragLeft = dragging.x;
  const dragRight = dragging.x + dragging.width;
  const dragCenterX = dragging.x + dragging.width / 2;

  for (const g of guides) {
    if (g.orientation !== "vertical") continue;
    if (snapX === undefined && Math.abs(g.position - dragLeft) < threshold) {
      snapX = g.position;
      activeGuides.push(g);
      continue;
    }
    if (snapX === undefined && Math.abs(g.position - dragRight) < threshold) {
      snapX = g.position - dragging.width;
      activeGuides.push(g);
      continue;
    }
    if (snapX === undefined && Math.abs(g.position - dragCenterX) < threshold) {
      snapX = g.position - dragging.width / 2;
      activeGuides.push(g);
      continue;
    }
  }

  const dragTop = dragging.y;
  const dragBottom = dragging.y + dragging.height;
  const dragCenterY = dragging.y + dragging.height / 2;

  for (const g of guides) {
    if (g.orientation !== "horizontal") continue;
    if (snapY === undefined && Math.abs(g.position - dragTop) < threshold) {
      snapY = g.position;
      activeGuides.push(g);
      continue;
    }
    if (snapY === undefined && Math.abs(g.position - dragBottom) < threshold) {
      snapY = g.position - dragging.height;
      activeGuides.push(g);
      continue;
    }
    if (snapY === undefined && Math.abs(g.position - dragCenterY) < threshold) {
      snapY = g.position - dragging.height / 2;
      activeGuides.push(g);
      continue;
    }
  }

  return { x: snapX, y: snapY, guides: activeGuides };
}

// ============================================================
// Continuation Page (page 2+) — static preview
// ============================================================

function ContinuationPage({
  pageIdx,
  pageCount,
  template,
  letterhead,
  page,
  scale,
  t,
}: {
  pageIdx: number;
  pageCount: number;
  template: Partial<DocumentTemplate>;
  letterhead: TenantLetterhead | null;
  page: { width: number; height: number };
  scale: number;
  t: (k: string) => string;
}) {
  const companyName = getCompanyName(letterhead);
  const logoUrl = getLogoUrl(letterhead);
  const reg = getRegNumber(letterhead);
  const primaryColor = template.primary_color || letterhead?.primary_color || "#0f766e";
  // Show one extra sample row per continuation page (cycling through the list).
  const rowIndex = (pageIdx - 1) % SAMPLE_LINE_ITEMS.length;
  const row = SAMPLE_LINE_ITEMS[rowIndex];

  return (
    <div
      className="relative bg-white shadow-lg"
      style={{ width: page.width * scale, height: page.height * scale }}
    >
      {/* Continued header */}
      <div
        className="absolute left-0 right-0 flex items-center gap-1 border-b-2"
        style={{ top: 8 * scale, height: 15 * scale, paddingLeft: 15 * scale, paddingRight: 15 * scale, borderColor: primaryColor }}
      >
        {logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt="" className="shrink-0 object-contain" style={{ width: 20, height: 12 }} draggable={false} />
        )}
        <span className="text-[8px] font-bold" style={{ color: primaryColor }}>{companyName}</span>
        <span className="ml-auto text-[6px] text-slate-500">{t("misc-tve-continued")}</span>
      </div>

      {/* Continued table */}
      <div className="absolute" style={{ top: 30 * scale, left: 15 * scale, right: 15 * scale }}>
        <MiniLineItemsTable rows={[row]} t={t} />
        <div className="mt-1 text-[6px] italic text-slate-400">{t("misc-tve-continued-from")}</div>
      </div>

      {/* Footer */}
      <div
        className="absolute left-0 right-0 flex items-center justify-between border-t border-slate-300 text-[6px] text-slate-500"
        style={{ bottom: 6 * scale, paddingLeft: 15 * scale, paddingRight: 15 * scale, paddingTop: 3 }}
      >
        <span className="truncate">{companyName} · Reg#{reg}</span>
        <span>{t("misc-tve-page-n-of-m").replace("{n}", String(pageIdx + 1)).replace("{m}", String(pageCount))}</span>
      </div>
    </div>
  );
}

// ============================================================
// Main Component
// ============================================================

type DragState = {
  id: string;
  startX: number; // client px
  startY: number; // client px
  origX: number; // mm
  origY: number; // mm
  origW: number; // mm
  origH: number; // mm
  mode: "move" | "resize";
};

export function TemplateVisualEditor({
  template,
  onChange,
  pageSize,
  letterhead,
}: TemplateVisualEditorProps) {
  const t = useT();
  const [fields, setFields] = React.useState<FieldElement[]>(
    DEFAULT_FIELDS.map((f) => ({ ...f }))
  );

  // ── audit22: layout persistence ────────────────────────────────────
  // Hydrate the persisted visual layout (template.layout_json, written by
  // this editor on every field mutation) when the TEMPLATE IDENTITY
  // changes — not on every parent form update (form re-renders produce a
  // new object each keystroke; hydrating then would reset in-progress
  // drags). Built-in fields keep their translated label when the stored
  // layout row doesn't carry one.
  const hydratedFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    const key = `${(template as { id?: string })?.id ?? "new"}`;
    if (hydratedFor.current === key) return;
    hydratedFor.current = key;
    const parsed = readTemplateLayout((template as { layout_json?: unknown }).layout_json);
    if (parsed && parsed.fields.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFields(parsed.fields.map((f) => ({
        ...f,
        type: f.type as FieldType,
        label: f.label ?? DEFAULT_FIELDS.find((d) => d.id === f.id)?.label ?? "Custom",
      })));
    }
  }, [template]);

  // Emit the layout into the parent form on every field change (drag move,
  // resize, add/delete, visibility/lock toggles, custom-field edits) so it
  // PERSISTS to layout_json on save and the PDF renderer can honor it.
  // Echo guards:
  //   • the PRISTINE default layout is never emitted (opening the editor
  //     alone must not dirty layout_json on templates that have none);
  //   • identical serializations are skipped (label-only churn ignored).
  const lastLayoutEmitted = React.useRef<string>("");
  const suppressNextEmit = React.useRef(true);
  React.useEffect(() => {
    const json = JSON.stringify({ fields: fields.map(({ label, ...rest }) => (label ? { ...rest } : rest)) });
    if (suppressNextEmit.current) {
      suppressNextEmit.current = false;
      lastLayoutEmitted.current = json;
      return;
    }
    if (json === lastLayoutEmitted.current) return;
    lastLayoutEmitted.current = json;
    onChange({ ...template, layout_json: { fields } });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields]);

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [dragging, setDragging] = React.useState<DragState | null>(null);
  const [activeGuides, setActiveGuides] = React.useState<SnapGuide[]>([]);
  const [showRuler, setShowRuler] = React.useState(true);
  const [showGrid, setShowGrid] = React.useState(false);
  const [snapEnabled, setSnapEnabled] = React.useState(true);
  const [zoom, setZoom] = React.useState(1);
  const [pageCount, setPageCount] = React.useState(1);
  const [customFieldCounter, setCustomFieldCounter] = React.useState(0);
  // "vertical" = stacked pages (default), "grid" = 2-column side-by-side.
  const [pageLayout, setPageLayout] = React.useState<"vertical" | "grid">("vertical");
  // True while a placeholder chip is being dragged over the content Textarea.
  const [dragOverContent, setDragOverContent] = React.useState(false);
  // Ref to the scrollable canvas container — used by the "Fit" button to
  // calculate the zoom level that fits the page width in the visible area.
  const canvasContainerRef = React.useRef<HTMLDivElement | null>(null);

  // Effective scale combines the base pixel-per-mm with zoom factor.
  const renderScale = BASE_SCALE * zoom;

  // Effective page size: explicit prop wins, then template.page_size, then A4.
  const effectivePageSize: "A4" | "Letter" =
    pageSize ?? (template.page_size === "Letter" ? "Letter" : "A4");
  const page = PAGE_DIMENSIONS[effectivePageSize];
  const pageWidthPx = page.width * renderScale;
  const pageHeightPx = page.height * renderScale;

  const selected = fields.find((f) => f.id === selectedId) ?? null;

  // ---------------------------------------------------------
  // Drag / resize handlers
  // ---------------------------------------------------------

  const startDrag = (
    e: React.MouseEvent,
    field: FieldElement,
    mode: "move" | "resize"
  ) => {
    if (field.locked) return;
    e.preventDefault();
    e.stopPropagation();
    setSelectedId(field.id);
    setDragging({
      id: field.id,
      startX: e.clientX,
      startY: e.clientY,
      origX: field.x,
      origY: field.y,
      origW: field.width,
      origH: field.height,
      mode,
    });
  };

  React.useEffect(() => {
    if (!dragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const dx = (e.clientX - dragging.startX) / renderScale;
      const dy = (e.clientY - dragging.startY) / renderScale;

      setFields((prev) =>
        prev.map((f) => {
          if (f.id !== dragging.id) return f;

          if (dragging.mode === "resize") {
            // Resize: update width/height based on drag delta, keep x/y clamped
            // to original so the field's top-left stays fixed.
            const newWidth = Math.max(
              10,
              Math.min(page.width - dragging.origX, dragging.origW + dx)
            );
            const newHeight = Math.max(
              6,
              Math.min(page.height - dragging.origY, dragging.origH + dy)
            );
            return { ...f, width: newWidth, height: newHeight };
          }

          // Move mode.
          let newX = Math.max(
            0,
            Math.min(page.width - f.width, dragging.origX + dx)
          );
          let newY = Math.max(
            0,
            Math.min(page.height - f.height, dragging.origY + dy)
          );

          if (snapEnabled) {
            const candidate: FieldElement = { ...f, x: newX, y: newY };
            const guides = calculateSnapGuides(
              candidate,
              prev,
              page.width,
              page.height
            );
            const snap = findSnap(candidate, guides);
            if (snap.x !== undefined) newX = snap.x;
            if (snap.y !== undefined) newY = snap.y;
            setActiveGuides(snap.guides);
          }

          return { ...f, x: newX, y: newY };
        })
      );
    };

    const handleMouseUp = () => {
      setDragging(null);
      setActiveGuides([]);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, snapEnabled, page.width, page.height, renderScale]);

  // ---------------------------------------------------------
  // Template / field mutations
  // ---------------------------------------------------------

  const updateTemplate = (updates: Partial<DocumentTemplate>) => {
    onChange({ ...template, ...updates });
  };

  const updateField = (id: string, updates: Partial<FieldElement>) => {
    setFields((prev) =>
      prev.map((f) => (f.id === id ? { ...f, ...updates } : f))
    );
  };

  const updateFieldProps = (id: string, props: Record<string, unknown>) => {
    setFields((prev) =>
      prev.map((f) =>
        f.id === id ? { ...f, props: { ...(f.props || {}), ...props } } : f
      )
    );
  };

  // ---------------------------------------------------------
  // Inline content editing (properties panel Textarea)
  //
  // header / footer content is PERSISTED through the parent form state
  // (template.header_content / template.footer_content, segments JSON) so
  // edits survive tab switches and are included in the save payload.
  // custom_text / offer_text / bank_details keep their content in local
  // field props (preview-only, as before).
  // ---------------------------------------------------------
  const selectedPersistedKey: "header_content" | "footer_content" | null =
    selected?.type === "header"
      ? "header_content"
      : selected?.type === "footer"
        ? "footer_content"
        : null;

  const getSelectedContentText = (): string => {
    if (!selected) return "";
    if (selectedPersistedKey) {
      return contentToPlainText(template[selectedPersistedKey]);
    }
    return (selected.props?.content as string) || "";
  };

  const setSelectedContentText = (text: string) => {
    if (!selected) return;
    if (selectedPersistedKey) {
      // Write through to the parent form (QR config etc. are untouched — the
      // parent re-serializes _qrConfig from its own state at save time and
      // plainTextToContentJson preserves sibling JSON keys anyway).
      updateTemplate({
        [selectedPersistedKey]: plainTextToContentJson(
          text,
          template[selectedPersistedKey],
          `visual-${selected.type}`
        ),
      } as Partial<DocumentTemplate>);
    } else {
      updateFieldProps(selected.id, { content: text });
    }
  };

  const alignField = (id: string, alignment: string) => {
    setFields((prev) =>
      prev.map((f) => {
        if (f.id !== id) return f;
        switch (alignment) {
          case "left":
            return { ...f, x: 0 };
          case "center-h":
            return { ...f, x: (page.width - f.width) / 2 };
          case "right":
            return { ...f, x: page.width - f.width };
          case "top":
            return { ...f, y: 0 };
          case "middle":
            return { ...f, y: (page.height - f.height) / 2 };
          case "bottom":
            return { ...f, y: page.height - f.height };
          default:
            return f;
        }
      })
    );
  };

  const resetLayout = () => {
    setFields(DEFAULT_FIELDS.map((f) => ({ ...f })));
    setSelectedId(null);
    setActiveGuides([]);
    setCustomFieldCounter(0);
  };

  // Fit-to-width: zoom so the full page width (ruler excluded) fits inside the
  // visible canvas area. Falls back to 1 if the container isn't measured yet.
  const fitToWidth = () => {
    const containerWidth = canvasContainerRef.current?.clientWidth || 800;
    const pageWidthPx = page.width * BASE_SCALE;
    // Account for ~32px of padding on each side + the left ruler (~24px).
    const padding = showRuler ? 56 : 32;
    const newZoom = (containerWidth - padding) / pageWidthPx;
    setZoom(Math.max(0.25, Math.min(3, newZoom)));
  };

  const addCustomText = () => {
    const idx = customFieldCounter + 1;
    const newField: FieldElement = {
      id: `custom_text_${Date.now()}`,
      type: "custom_text",
      label: `Custom Text ${idx}`,
      x: 60,
      y: 60 + idx * 4,
      width: 90,
      height: 12,
      visible: true,
      locked: false,
      props: { content: "Enter your text here..." },
    };
    setFields((prev) => [...prev, newField]);
    setCustomFieldCounter(idx);
    setSelectedId(newField.id);
  };

  const addCustomImage = () => {
    const idx = customFieldCounter + 1;
    const newField: FieldElement = {
      id: `custom_image_${Date.now()}`,
      type: "custom_image",
      label: `Custom Image ${idx}`,
      x: 80,
      y: 100 + idx * 4,
      width: 50,
      height: 25,
      visible: true,
      locked: false,
      props: { imageUrl: null },
    };
    setFields((prev) => [...prev, newField]);
    setCustomFieldCounter(idx);
    setSelectedId(newField.id);
  };

  const deleteField = (id: string) => {
    // Prevent deletion of built-in default fields.
    if (DEFAULT_FIELDS.some((f) => f.id === id)) return;
    setFields((prev) => prev.filter((f) => f.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  // ---------------------------------------------------------
  // Margins (with safe fallbacks)
  // ---------------------------------------------------------
  const marginTop = template.page_margin_top ?? 20;
  const marginBottom = template.page_margin_bottom ?? 20;
  const marginLeft = template.page_margin_left ?? 18;
  const marginRight = template.page_margin_right ?? 18;

  // ---------------------------------------------------------
  // Render the editable page (interactive field canvas)
  // ---------------------------------------------------------
  const renderEditorPage = () => (
    <div
      className="relative bg-white shadow-lg"
      style={{ width: pageWidthPx, height: pageHeightPx }}
      onClick={(e) => {
        if (e.target === e.currentTarget) setSelectedId(null);
      }}
    >
      {/* Page margin guides (dashed blue) */}
      <div
        className="absolute border-l border-dashed border-blue-300/50"
        style={{ left: marginLeft * renderScale, top: 0, bottom: 0 }}
      />
      <div
        className="absolute border-r border-dashed border-blue-300/50"
        style={{ right: marginRight * renderScale, top: 0, bottom: 0 }}
      />
      <div
        className="absolute border-t border-dashed border-blue-300/50"
        style={{ top: marginTop * renderScale, left: 0, right: 0 }}
      />
      <div
        className="absolute border-b border-dashed border-blue-300/50"
        style={{ bottom: marginBottom * renderScale, left: 0, right: 0 }}
      />

      {/* Grid overlay (5mm squares) */}
      {showGrid && (
        <div className="pointer-events-none absolute inset-0">
          {Array.from({ length: Math.floor(page.width / 5) - 1 }).map((_, i) => (
            <div
              key={`gv-${i}`}
              className="absolute top-0 bottom-0 border-l border-blue-200/30"
              style={{ left: (i + 1) * 5 * renderScale }}
            />
          ))}
          {Array.from({ length: Math.floor(page.height / 5) - 1 }).map((_, i) => (
            <div
              key={`gh-${i}`}
              className="absolute left-0 right-0 border-t border-blue-200/30"
              style={{ top: (i + 1) * 5 * renderScale }}
            />
          ))}
        </div>
      )}

      {/* Active snap guides (red) */}
      {activeGuides.map((g, i) =>
        g.orientation === "vertical" ? (
          <div
            key={`snap-v-${i}`}
            className="absolute bg-red-500/60"
            style={{
              left: g.position * renderScale,
              top: 0,
              width: 1,
              height: pageHeightPx,
            }}
          />
        ) : (
          <div
            key={`snap-h-${i}`}
            className="absolute bg-red-500/60"
            style={{
              top: g.position * renderScale,
              left: 0,
              height: 1,
              width: pageWidthPx,
            }}
          />
        )
      )}

      {/* Fields */}
      {fields
        .filter((f) => f.visible)
        .map((f) => {
          const isSelected = selectedId === f.id;
          return (
            <div
              key={f.id}
              onMouseDown={(e) => startDrag(e, f, "move")}
              className={cn(
                "absolute flex select-none flex-col overflow-hidden border text-[9px] font-medium leading-tight",
                isSelected
                  ? "z-10 cursor-move border-primary bg-primary/10"
                  : "cursor-move border-blue-300 bg-blue-50/50 hover:bg-blue-50",
                f.locked && "cursor-default opacity-60"
              )}
              style={{
                left: f.x * renderScale,
                top: f.y * renderScale,
                width: f.width * renderScale,
                height: f.height * renderScale,
              }}
              title={`${f.label} — (${Math.round(f.x)}, ${Math.round(
                f.y
              )}) mm · ${Math.round(f.width)}×${Math.round(f.height)}mm`}
            >
              {/* Live content */}
              <div className="pointer-events-none flex-1 overflow-hidden p-0.5">
                {renderFieldContent(f, template, letterhead, t)}
              </div>

              {/* Tiny label badge so users still know what each block is */}
              <span className="pointer-events-none absolute -top-4 left-0 rounded bg-slate-700 px-1 py-px text-[7px] font-medium text-white opacity-0 group-hover:opacity-100" />

              {/* Coordinates badge */}
              {isSelected && (
                <span className="absolute -top-5 left-0 rounded bg-primary px-1.5 py-0.5 text-[8px] font-medium text-primary-foreground">
                  {Math.round(f.x)}, {Math.round(f.y)}
                </span>
              )}

              {/* Resize handle (bottom-right) */}
              {isSelected && !f.locked && (
                <div
                  onMouseDown={(e) => startDrag(e, f, "resize")}
                  className="absolute -bottom-1 -right-1 flex size-3 cursor-nwse-resize items-center justify-center rounded-sm border border-primary bg-white"
                  title="Drag to resize"
                >
                  <Maximize2 className="size-2 text-primary" />
                </div>
              )}
            </div>
          );
        })}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ─── Toolbar ─── */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-background p-2">
        <Button
          size="sm"
          variant={showRuler ? "default" : "outline"}
          onClick={() => setShowRuler(!showRuler)}
        >
          <Ruler className="size-4" /> {t("misc-tve-ruler")}
        </Button>
        <Button
          size="sm"
          variant={showGrid ? "default" : "outline"}
          onClick={() => setShowGrid(!showGrid)}
        >
          <Grid3x3 className="size-4" /> {t("misc-tve-grid")}
        </Button>
        <Button
          size="sm"
          variant={snapEnabled ? "default" : "outline"}
          onClick={() => setSnapEnabled(!snapEnabled)}
        >
          <Move className="size-4" /> {snapEnabled ? t("misc-tve-snap-on") : t("misc-tve-snap-off")}
        </Button>
        <div className="h-6 w-px bg-border" />
        <Button size="sm" variant="outline" onClick={addCustomText}>
          <Type className="size-4" /> {t("misc-tve-text")}
        </Button>
        <Button size="sm" variant="outline" onClick={addCustomImage}>
          <ImageIcon className="size-4" /> {t("misc-tve-image")}
        </Button>
        <div className="h-6 w-px bg-border" />
        <Button size="sm" variant="outline" onClick={resetLayout}>
          <RotateCcw className="size-4" /> {t("misc-tve-reset")}
        </Button>

        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          {/* Zoom: slider + buttons */}
          <div className="flex items-center gap-1">
            <Label className="text-xs">{t("misc-tve-zoom")}</Label>
            <Button
              size="sm"
              variant="outline"
              className="size-8 p-0"
              onClick={() => setZoom(Math.max(0.25, Math.round((zoom - 0.25) * 100) / 100))}
              title={t("misc-tve-zoom-out")}
            >
              <ZoomOut className="size-3" />
            </Button>
            <Slider
              value={[zoom]}
              onValueChange={(v) => setZoom(v[0])}
              min={0.25}
              max={3}
              step={0.05}
              className="w-28"
              aria-label="Zoom level"
            />
            <Button
              size="sm"
              variant="outline"
              className="size-8 p-0"
              onClick={() => setZoom(Math.min(3, Math.round((zoom + 0.25) * 100) / 100))}
              title={t("misc-tve-zoom-in")}
            >
              <ZoomIn className="size-3" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 px-2"
              onClick={() => setZoom(1)}
              title={t("misc-tve-reset-100")}
            >
              100%
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 px-2"
              onClick={fitToWidth}
              title={t("misc-tve-fit-hint")}
            >
              <Maximize2 className="size-3" /> {t("misc-tve-fit")}
            </Button>
            <span className="w-10 text-right tabular-nums">
              {Math.round(zoom * 100)}%
            </span>
          </div>
          {/* Pages selector */}
          <div className="flex items-center gap-1">
            <Label className="text-xs">{t("misc-tve-pages")}</Label>
            <Select
              value={String(pageCount)}
              onValueChange={(v) => setPageCount(Number(v))}
            >
              <SelectTrigger className="h-8 w-[60px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">1</SelectItem>
                <SelectItem value="2">2</SelectItem>
                <SelectItem value="3">3</SelectItem>
                <SelectItem value="5">5</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {/* Page layout: stacked vs grid */}
          <div className="flex items-center gap-1">
            <Label className="text-xs">{t("misc-tve-layout")}</Label>
            <Select
              value={pageLayout}
              onValueChange={(v) => setPageLayout(v as "vertical" | "grid")}
            >
              <SelectTrigger className="h-8 w-[88px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="vertical">{t("misc-tve-stacked")}</SelectItem>
                <SelectItem value="grid">{t("misc-tve-grid-2col")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <span>
            {effectivePageSize} · {page.width}×{page.height}mm
          </span>
        </div>
      </div>

      {/* ─── Honest-labeling hint: drag positions are preview-only ─── */}
      <div className="flex items-center gap-1.5 border-b bg-muted/30 px-3 py-1.5 text-[11px] leading-tight text-muted-foreground">
        <Info className="size-3 shrink-0" />
        <span>{t("doc-visual-preview-hint")}</span>
      </div>

      {/* ─── Body: 3 panels ─── */}
      <div className="flex min-h-0 flex-1">
        {/* LEFT — Fields list */}
        <ScrollArea className="w-48 shrink-0 border-r">
          <div className="space-y-1 p-3">
            <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
              {t("misc-tve-fields-count").replace("{n}", String(fields.length))}
            </h3>
            {fields.map((f) => (
              <div
                key={f.id}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded p-2 text-sm",
                  selectedId === f.id
                    ? "border border-primary/30 bg-primary/10"
                    : "hover:bg-muted/50"
                )}
                onClick={() => setSelectedId(f.id)}
              >
                <button
                  className="shrink-0"
                  title={f.visible ? t("misc-tve-hide-field") : t("misc-tve-show-field")}
                  onClick={(e) => {
                    e.stopPropagation();
                    updateField(f.id, { visible: !f.visible });
                  }}
                >
                  {f.visible ? (
                    <Eye className="size-3.5" />
                  ) : (
                    <EyeOff className="size-3.5 text-muted-foreground" />
                  )}
                </button>
                <span
                  className={cn(
                    "flex-1 truncate",
                    !f.visible && "text-muted-foreground line-through"
                  )}
                >
                  {t(f.label)}
                </span>
                {f.locked && <Lock className="size-3 text-muted-foreground" />}
              </div>
            ))}
            <div className="mt-3 border-t pt-3">
              <p className="mb-2 text-xs text-muted-foreground">
                {t("misc-tve-quick-add")}
              </p>
              <div className="flex flex-col gap-1">
                <Button size="sm" variant="outline" onClick={addCustomText}>
                  <Type className="size-3.5" /> {t("misc-tve-text-block")}
                </Button>
                <Button size="sm" variant="outline" onClick={addCustomImage}>
                  <ImageIcon className="size-3.5" /> {t("misc-tve-image-block")}
                </Button>
              </div>
            </div>
          </div>
        </ScrollArea>

        {/* CENTER — Canvas (scrollable: pan by scrolling when zoomed in) */}
        <div
          ref={canvasContainerRef}
          className="flex-1 overflow-auto bg-muted/20 p-4"
        >
          <div className="inline-block">
            {/* Ruler row */}
            {showRuler && (
              <div className="flex">
                {/* Top-left corner square */}
                <div className="size-6 shrink-0 bg-muted/20" />
                {/* Top ruler */}
                <RulerBar
                  orientation="horizontal"
                  length={page.width}
                  scale={renderScale}
                />
              </div>
            )}

            {/* Pages — stacked (vertical) or side-by-side grid (2-col) */}
            <div
              className={
                pageLayout === "grid"
                  ? "grid grid-cols-2 gap-4"
                  : "flex flex-col gap-4"
              }
            >
              {Array.from({ length: pageCount }).map((_, pageIdx) => (
                <div key={pageIdx} className="flex flex-col">
                  {/* Page label */}
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t("misc-tve-page-n-of-m").replace("{n}", String(pageIdx + 1)).replace("{m}", String(pageCount))}
                    </span>
                    {pageIdx > 0 && (
                      <span className="text-[9px] text-muted-foreground">
                        {t("misc-tve-auto-continued")}
                      </span>
                    )}
                  </div>

                  <div className="flex">
                    {/* Left ruler only beside page 1 */}
                    {showRuler && (
                      <RulerBar
                        orientation="vertical"
                        length={page.height}
                        scale={renderScale}
                      />
                    )}

                    {pageIdx === 0 ? (
                      renderEditorPage()
                    ) : (
                      <ContinuationPage
                        pageIdx={pageIdx}
                        pageCount={pageCount}
                        template={template}
                        letterhead={letterhead}
                        page={page}
                        scale={renderScale}
                        t={t}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Legend */}
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="inline-block size-2.5 rounded-sm border border-primary bg-primary/10" />
                {t("misc-tve-selected")}
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block size-2.5 rounded-sm border border-blue-300 bg-blue-50/50" />
                {t("misc-tve-field")}
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-3 border-t border-dashed border-blue-300" />
                {t("misc-tve-page-margin")}
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-3 border-t border-blue-200/60" />
                {t("misc-tve-grid-5mm")}
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-3 bg-red-500/60" />
                {t("misc-tve-active-snap")}
              </span>
            </div>
          </div>
        </div>

        {/* RIGHT — Properties */}
        <ScrollArea className="w-72 shrink-0 border-l">
          <div className="space-y-4 p-3">
            {selected ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold uppercase text-muted-foreground">
                    {t("misc-tve-properties")}
                  </h3>
                  <Badge variant="outline" className="text-xs">
                    {selected.type}
                  </Badge>
                </div>

                {/* Editable label */}
                <div>
                  <Label className="text-xs">{t("misc-tve-label")}</Label>
                  <Input
                    value={selected.label}
                    onChange={(e) =>
                      updateField(selected.id, { label: e.target.value })
                    }
                  />
                </div>

                {/* Position & size */}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs">{t("misc-tve-x-mm")}</Label>
                    <Input
                      type="number"
                      value={Math.round(selected.x)}
                      onChange={(e) =>
                        updateField(selected.id, {
                          x: Number(e.target.value) || 0,
                        })
                      }
                    />
                  </div>
                  <div>
                    <Label className="text-xs">{t("misc-tve-y-mm")}</Label>
                    <Input
                      type="number"
                      value={Math.round(selected.y)}
                      onChange={(e) =>
                        updateField(selected.id, {
                          y: Number(e.target.value) || 0,
                        })
                      }
                    />
                  </div>
                  <div>
                    <Label className="text-xs">{t("misc-tve-width-mm")}</Label>
                    <Input
                      type="number"
                      value={Math.round(selected.width)}
                      onChange={(e) =>
                        updateField(selected.id, {
                          width: Math.max(10, Number(e.target.value) || 10),
                        })
                      }
                    />
                  </div>
                  <div>
                    <Label className="text-xs">{t("misc-tve-height-mm")}</Label>
                    <Input
                      type="number"
                      value={Math.round(selected.height)}
                      onChange={(e) =>
                        updateField(selected.id, {
                          height: Math.max(6, Number(e.target.value) || 6),
                        })
                      }
                    />
                  </div>
                </div>

                {/* Toggles */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="flex items-center gap-1 text-xs">
                      <Eye className="size-3" /> {t("misc-tve-visible")}
                    </Label>
                    <Switch
                      checked={selected.visible}
                      onCheckedChange={(v) =>
                        updateField(selected.id, { visible: v })
                      }
                      aria-label={t("misc-tve-visible")}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label className="flex items-center gap-1 text-xs">
                      {selected.locked ? (
                        <Lock className="size-3" />
                      ) : (
                        <Unlock className="size-3" />
                      )}{" "}
                      {t("misc-tve-locked")}
                    </Label>
                    <Switch
                      checked={selected.locked}
                      onCheckedChange={(v) =>
                        updateField(selected.id, { locked: v })
                      }
                      aria-label={t("misc-tve-locked")}
                    />
                  </div>
                </div>

                <Separator />

                {/* Logo field controls */}
                {selected.type === "logo" && (
                  <div className="space-y-3">
                    <h4 className="text-xs font-semibold uppercase text-muted-foreground">
                      {t("misc-tve-logo")}
                    </h4>
                    <div>
                      <div className="mb-1 flex items-center justify-between">
                        <Label className="text-xs">{t("misc-tve-width-mm")}</Label>
                        <span className="text-xs tabular text-muted-foreground">
                          {Math.round(selected.width)}mm
                        </span>
                      </div>
                      <Slider
                        value={[selected.width]}
                        min={10}
                        max={100}
                        step={1}
                        onValueChange={(v) =>
                          updateField(selected.id, { width: v[0] })
                        }
                      />
                    </div>
                    <div>
                      <div className="mb-1 flex items-center justify-between">
                        <Label className="text-xs">{t("misc-tve-height-mm")}</Label>
                        <span className="text-xs tabular text-muted-foreground">
                          {Math.round(selected.height)}mm
                        </span>
                      </div>
                      <Slider
                        value={[selected.height]}
                        min={5}
                        max={50}
                        step={1}
                        onValueChange={(v) =>
                          updateField(selected.id, { height: v[0] })
                        }
                      />
                    </div>
                    <div>
                      <Label className="mb-1 block text-xs">{t("misc-tve-alignment")}</Label>
                      <div className="grid grid-cols-3 gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          title={t("misc-tve-align-left")}
                          onClick={() => alignField(selected.id, "left")}
                        >
                          <AlignLeft className="size-3" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          title={t("misc-tve-align-center-h")}
                          onClick={() => alignField(selected.id, "center-h")}
                        >
                          <AlignCenter className="size-3" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          title={t("misc-tve-align-right")}
                          onClick={() => alignField(selected.id, "right")}
                        >
                          <AlignRight className="size-3" />
                        </Button>
                      </div>
                    </div>
                    <div className="rounded border bg-muted/30 p-2 text-xs text-muted-foreground">
                      {letterhead?.logo_url
                        ? t("misc-tve-source-from-letterhead")
                        : t("misc-tve-no-logo-hint")}
                    </div>
                  </div>
                )}

                {/* Custom image field controls */}
                {selected.type === "custom_image" && (
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold uppercase text-muted-foreground">
                      {t("misc-tve-image")}
                    </h4>
                    <div>
                      <Label className="text-xs">{t("misc-tve-image-url")}</Label>
                      <Input
                        placeholder="https://… or /uploads/…"
                        value={(selected.props?.imageUrl as string) || ""}
                        onChange={(e) =>
                          updateFieldProps(selected.id, {
                            imageUrl: e.target.value,
                          })
                        }
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <div className="mb-1 flex items-center justify-between">
                          <Label className="text-xs">{t("misc-tve-width-mm")}</Label>
                          <span className="text-xs tabular text-muted-foreground">
                            {Math.round(selected.width)}
                          </span>
                        </div>
                        <Slider
                          value={[selected.width]}
                          min={10}
                          max={180}
                          step={1}
                          onValueChange={(v) =>
                            updateField(selected.id, { width: v[0] })
                          }
                        />
                      </div>
                      <div>
                        <div className="mb-1 flex items-center justify-between">
                          <Label className="text-xs">{t("misc-tve-height-mm")}</Label>
                          <span className="text-xs tabular text-muted-foreground">
                            {Math.round(selected.height)}
                          </span>
                        </div>
                        <Slider
                          value={[selected.height]}
                          min={5}
                          max={100}
                          step={1}
                          onValueChange={(v) =>
                            updateField(selected.id, { height: v[0] })
                          }
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* Content editor for header / footer / custom_text */}
                {["header", "footer", "custom_text", "offer_text", "bank_details"].includes(
                  selected.type
                ) && (
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold uppercase text-muted-foreground">
                      {t("misc-tve-content")}
                    </h4>
                    {/* Draggable placeholder palette — drag a chip into the text area below */}
                    <div>
                      <Label className="text-xs text-muted-foreground">
                        {t("misc-tve-drag-placeholders")}
                      </Label>
                      <div className="mt-1 flex max-h-28 flex-wrap gap-1 overflow-y-auto rounded border bg-muted/30 p-1.5">
                        {PLACEHOLDERS.map((ph) => (
                          <div
                            key={ph.key}
                            draggable
                            onDragStart={(e) => {
                              e.dataTransfer.setData("text/plain", ph.key);
                              e.dataTransfer.effectAllowed = "copy";
                            }}
                            className="flex items-center gap-1 rounded border bg-background px-1.5 py-0.5 text-xs cursor-grab hover:border-primary/40 hover:bg-primary/5 active:cursor-grabbing select-none"
                            title={`Drag into the text area: ${ph.key}`}
                          >
                            <GripVertical className="size-2.5 text-muted-foreground/70" />
                            {t(ph.label)}
                          </div>
                        ))}
                      </div>
                    </div>
                    <Textarea
                      rows={4}
                      value={getSelectedContentText()}
                      onChange={(e) => setSelectedContentText(e.target.value)}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "copy";
                        setDragOverContent(true);
                      }}
                      onDragLeave={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                          setDragOverContent(false);
                        }
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const ph = e.dataTransfer.getData("text/plain");
                        if (ph) {
                          // Append the chip to the current text. For header /
                          // footer this writes through to the persisted segments
                          // JSON (see setSelectedContentText); for other fields
                          // it stays in local field props.
                          const current = getSelectedContentText();
                          const next = current.trim() ? `${current} ${ph}` : ph;
                          setSelectedContentText(next);
                        }
                        setDragOverContent(false);
                      }}
                      placeholder={t("misc-tve-content-placeholder")}
                      className={cn(
                        "text-xs",
                        dragOverContent && "ring-2 ring-primary ring-offset-1"
                      )}
                    />
                    <p className="text-xs text-muted-foreground">
                      Placeholders: {"{company_name}"}, {"{company_address}"}, {"{company_reg}"},{" "}
                      {"{company_vat}"}, {"{doc_number}"}, {"{page_number}"}
                    </p>
                    {selected.type !== "custom_text" && (
                      <p className="text-xs italic text-muted-foreground">
                        {t("misc-tve-default-text-hint").replace("{type}", selected.type)}
                      </p>
                    )}
                  </div>
                )}

                <Separator />

                {/* Alignment buttons */}
                <div>
                  <Label className="mb-2 block text-xs">{t("misc-tve-align-to-page")}</Label>
                  <div className="grid grid-cols-3 gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      title={t("misc-tve-align-left")}
                      onClick={() => alignField(selected.id, "left")}
                    >
                      <AlignLeft className="size-3" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      title={t("misc-tve-align-center-h")}
                      onClick={() => alignField(selected.id, "center-h")}
                    >
                      <AlignCenter className="size-3" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      title={t("misc-tve-align-right")}
                      onClick={() => alignField(selected.id, "right")}
                    >
                      <AlignRight className="size-3" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      title={t("misc-tve-align-top")}
                      onClick={() => alignField(selected.id, "top")}
                    >
                      <AlignVerticalJustifyStart className="size-3" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      title={t("misc-tve-align-center-v")}
                      onClick={() => alignField(selected.id, "middle")}
                    >
                      <AlignVerticalJustifyCenter className="size-3" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      title={t("misc-tve-align-bottom")}
                      onClick={() => alignField(selected.id, "bottom")}
                    >
                      <AlignVerticalJustifyEnd className="size-3" />
                    </Button>
                  </div>
                </div>

                <Separator />

                {/* Quick geometry info + delete */}
                <div className="rounded border bg-muted/30 p-2 text-xs text-muted-foreground">
                  <div className="flex justify-between">
                    <span>{t("misc-tve-right-edge")}</span>
                    <span className="font-mono">
                      {Math.round(selected.x + selected.width)} mm
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>{t("misc-tve-bottom-edge")}</span>
                    <span className="font-mono">
                      {Math.round(selected.y + selected.height)} mm
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>{t("misc-tve-center")}</span>
                    <span className="font-mono">
                      ({Math.round(selected.x + selected.width / 2)},{" "}
                      {Math.round(selected.y + selected.height / 2)})
                    </span>
                  </div>
                </div>

                {!DEFAULT_FIELDS.some((f) => f.id === selected.id) && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full text-destructive hover:text-destructive"
                    onClick={() => deleteField(selected.id)}
                  >
                    {t("misc-tve-delete-field")}
                  </Button>
                )}
              </>
            ) : (
              <div className="py-8 text-center text-sm text-muted-foreground">
                <Move className="mx-auto mb-2 size-6 opacity-40" />
                {t("misc-tve-select-field-hint")}
              </div>
            )}

            <Separator />

            {/* Page settings */}
            <h3 className="text-xs font-semibold uppercase text-muted-foreground">
              {t("misc-tve-page")}
            </h3>
            <div>
              <Label className="text-xs">{t("misc-tve-size")}</Label>
              <Select
                value={template.page_size ?? "A4"}
                onValueChange={(v) =>
                  updateTemplate({ page_size: v as "A4" | "Letter" })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t("misc-tve-page-size")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="A4">{t("misc-tve-page-size-a4")}</SelectItem>
                  <SelectItem value="Letter">
                    {t("misc-tve-page-size-letter")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="mb-1 block text-xs">{t("misc-tve-margins-mm")}</Label>
              <div className="grid grid-cols-2 gap-2">
                {(["top", "bottom", "left", "right"] as const).map((m) => (
                  <div key={m}>
                    <Label className="text-xs capitalize text-muted-foreground">
                      {t(`misc-tve-margin-${m}`)}
                    </Label>
                    <Input
                      type="number"
                      value={template[`page_margin_${m}`] ?? 20}
                      onChange={(e) =>
                        updateTemplate({
                          [`page_margin_${m}`]: Number(e.target.value) || 0,
                        } as Partial<DocumentTemplate>)
                      }
                    />
                  </div>
                ))}
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              {t("misc-tve-snap-threshold-hint")
                .replace("{n}", String(SNAP_THRESHOLD))
                .replace("{s}", String(BASE_SCALE))
                .replace("{z}", String(Math.round(zoom * 100)))}
            </p>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
