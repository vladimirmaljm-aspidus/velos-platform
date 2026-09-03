"use client";

/**
 * TemplateVisualEditor (audit27 redesign)
 * ----------------------------------------
 * A REAL sections editor for document templates. The previous incarnation
 * looked like a free-form WYSIWYG canvas (drag fields anywhere, ruler, grid,
 * snap) — but the drag positions were preview-only, which taught users the
 * hard way that "nothing you arrange here reaches the PDF".
 *
 * The new model is honest by construction:
 *   • Document sections render as a vertical FLOW in the exact order the
 *     generated PDF uses. Dragging a section up/down (list, canvas handle or
 *     ↑/↓ buttons) rewrites its sort key (layout_json y) and the PDF
 *     renderer honours it (see templates.tsx → orderedBody).
 *   • The eye-toggle per section gates the PDF render.
 *   • Text / image blocks are freely-placed overlays — they render at their
 *     absolute x/y on EVERY page (already honoured by the PDF renderer).
 *   • Header / logo / footer are page furniture (fixed on every page); the
 *     logo eye-toggle gates the rendered logo, header/footer content is
 *     edited through their fields (persisted columns).
 */

import * as React from "react";
import {
  Eye,
  EyeOff,
  RotateCcw,
  Maximize2,
  Plus,
  Type,
  Image as ImageIcon,
  ZoomIn,
  ZoomOut,
  GripVertical,
  Lock,
  ArrowUp,
  ArrowDown,
  Trash2,
  Info,
} from "lucide-react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  | "doc_title"
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
  | "footer"
  | "custom_text"
  | "custom_image";

export interface FieldElement {
  id: string;
  type: FieldType;
  label: string;
  x: number; // mm from left (overlays: real; flow: unused)
  y: number; // mm from top  (overlays: real; flow: SORT KEY — reindexed 10,20,30…)
  width: number; // mm (overlays)
  height: number; // mm (overlays)
  visible: boolean;
  locked: boolean;
  props?: Record<string, unknown>;
}

/** Fields that participate in the reorderable body flow. */
const FLOW_TYPES = new Set<FieldType>([
  "doc_title", "from_box", "to_box", "trade_terms", "line_items_table",
  "specifications", "totals", "amount_in_words", "offer_text",
  "bank_details", "signatures",
]);

/** Fixed page furniture — always first (header zone) / last (footer zone). */
const FIXED_TOP: FieldType[] = ["logo", "header"];
const FIXED_BOTTOM: FieldType[] = ["footer"];

type TemplateType = NonNullable<DocumentTemplate["type"]>;

interface TemplateVisualEditorProps {
  template: Partial<DocumentTemplate>;
  onChange: (template: Partial<DocumentTemplate>) => void;
  pageSize?: "A4" | "Letter";
  letterhead: TenantLetterhead | null;
}

// ============================================================
// Constants
// ============================================================

const PAGE_DIMENSIONS = {
  A4: { width: 210, height: 297 },
  Letter: { width: 216, height: 279 },
} as const;

const BASE_SCALE = 2; // 1 mm → 2 px at 100% zoom

interface FieldSpec {
  type: FieldType;
  labelKey: string;
}

/** Sections the PDF actually renders, per template type (honesty first:
 *  an LOI template never offers "Line items" / "Totals"). */
const FLOW_SECTIONS_BY_TYPE: Record<string, FieldSpec[]> = {
  loi: [
    { type: "doc_title", labelKey: "misc-tve-doc-title-block" },
    { type: "from_box", labelKey: "misc-tve-from-buyer" },
    { type: "to_box", labelKey: "misc-tve-to-seller" },
    { type: "offer_text", labelKey: "misc-tve-loi-text" },
    { type: "specifications", labelKey: "misc-tve-product-specs" },
    { type: "trade_terms", labelKey: "misc-tve-delivery-terms" },
    { type: "signatures", labelKey: "misc-tve-signatures" },
  ],
  default: [
    { type: "doc_title", labelKey: "misc-tve-doc-title-block" },
    { type: "from_box", labelKey: "misc-tve-from-box" },
    { type: "to_box", labelKey: "misc-tve-to-box" },
    { type: "trade_terms", labelKey: "misc-tve-trade-terms" },
    { type: "line_items_table", labelKey: "misc-tve-line-items" },
    { type: "specifications", labelKey: "misc-tve-specifications" },
    { type: "totals", labelKey: "misc-tve-totals" },
    { type: "amount_in_words", labelKey: "misc-tve-amount-words" },
    { type: "offer_text", labelKey: "misc-tve-offer-text" },
    { type: "bank_details", labelKey: "misc-tve-bank-details" },
    { type: "signatures", labelKey: "misc-tve-signatures" },
  ],
};

function flowSectionsFor(type: TemplateType | undefined): FieldSpec[] {
  return (FLOW_SECTIONS_BY_TYPE[type ?? "offer"] ?? FLOW_SECTIONS_BY_TYPE.default);
}

function defaultFieldsFor(type: TemplateType | undefined): FieldElement[] {
  const fields: FieldElement[] = [];
  FIXED_TOP.forEach((t) =>
    fields.push({
      id: t, type: t, label: t === "logo" ? "misc-tve-logo" : "misc-tve-header-memorandum",
      x: 0, y: 0, width: 0, height: 0, visible: true, locked: false,
    }),
  );
  flowSectionsFor(type).forEach((spec, i) =>
    fields.push({
      id: spec.type, type: spec.type, label: spec.labelKey,
      x: 0, y: (i + 1) * 10, width: 0, height: 0, visible: true, locked: false,
    }),
  );
  FIXED_BOTTOM.forEach((t) =>
    fields.push({
      id: t, type: t, label: "misc-tve-footer",
      x: 0, y: 9999, width: 0, height: 0, visible: true, locked: false,
    }),
  );
  return fields;
}

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
];

const DOC_TYPE_LABELS: Record<NonNullable<DocumentTemplate["type"]>, string> = {
  offer: "OFFER",
  invoice: "INVOICE",
  proforma: "PROFORMA INVOICE",
  contract: "CONTRACT",
  loi: "LETTER OF INTENT",
  generic: "DOCUMENT",
};

// Draggable placeholder chips for the inline content editors.
const PLACEHOLDERS: { key: string; label: string }[] = [
  { key: "{company_name}", label: "doc-var-company-name" },
  { key: "{company_legal_name}", label: "doc-var-legal-name" },
  { key: "{company_address}", label: "doc-var-address" },
  { key: "{company_city}", label: "doc-var-city" },
  { key: "{company_country}", label: "doc-var-country" },
  { key: "{company_reg}", label: "doc-var-reg" },
  { key: "{company_vat}", label: "doc-var-vat" },
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
  { key: "{total}", label: "doc-var-total" },
  { key: "{currency}", label: "doc-var-currency" },
  { key: "{page_number}", label: "doc-var-page-num" },
  { key: "{total_pages}", label: "doc-var-total-pages" },
];

// ============================================================
// Live content helpers
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
  return letterhead?.company_name || letterhead?.company_legal_name || "VELOS Trading";
}

function getLogoUrl(letterhead: TenantLetterhead | null): string | null {
  return letterhead?.logo_url || null;
}

function getRegNumber(letterhead: TenantLetterhead | null): string {
  return letterhead?.company_registration_number || "DMCC-889293";
}

function getVatNumber(letterhead: TenantLetterhead | null): string | null {
  return letterhead?.company_vat_number || null;
}

function normalizeLegacyTokens(text: string): string {
  return text
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, "{$1}")
    .replace(/\{company_bank\}/g, "{bank_name}")
    .replace(/\{company_iban\}/g, "{bank_iban}")
    .replace(/\{company_swift\}/g, "{bank_swift}")
    .replace(/\{doc_valid\}/g, "{valid_until}")
    .replace(/\{page_total\}/g, "{total_pages}")
    .replace(/\{address\}/g, "{company_address}")
    .replace(/\{reg\}/g, "{company_reg}")
    .replace(/\{vat\}/g, "{company_vat}")
    .replace(/\{date\}/g, "{doc_date}");
}

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

function contentToPlainText(content: string | null | undefined): string {
  if (!content) return "";
  return parseContentConfig(content)
    .segments.map((s) => s.text ?? "")
    .join("\n");
}

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
// Live field content renderer (canvas preview)
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
            <td className="border border-slate-300 px-0.5 py-0.5 truncate">{r.name}</td>
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
  const docType = template.type || "offer";
  const isLoi = docType === "loi";
  const docTypeLabel = DOC_TYPE_LABELS[docType] || "DOCUMENT";
  const primaryColor = template.primary_color || letterhead?.primary_color || "#0f766e";
  const bankName = letterhead?.bank_name || "Abu Dhabi Islamic Bank";
  const iban = letterhead?.bank_iban || "AE11 0200 0000 1234 5678 901";

  switch (field.type) {
    case "logo":
      return logoUrl ? (
         
        <img src={logoUrl} alt="Company logo" className="h-full max-h-8 w-full object-contain" draggable={false} />
      ) : (
        <div className="flex h-6 items-center justify-center rounded bg-teal-700/10 px-2 text-[7px] font-semibold text-teal-700">
          {t("misc-tve-logo-placeholder")}
        </div>
      );

    case "header": {
      const cfg = parseContentConfig(resolveFieldContent(field, template));
      if (cfg.segments.length > 0) {
        return (
          <div className="flex w-full flex-col justify-center overflow-hidden">
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
        <div className="flex w-full flex-col justify-center">
          <div className="text-[8px] font-bold leading-none" style={{ color: primaryColor }}>
            {companyName}
          </div>
          <div className="mt-0.5 truncate text-[6px] text-slate-500">
            {address}
            {letterhead?.company_email ? ` · ${letterhead.company_email}` : ""}
          </div>
        </div>
      );
    }

    // Title + document number/date/currency — ONE section in the PDF.
    case "doc_title":
      return (
        <div className="flex w-full items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] font-extrabold tracking-[0.12em]" style={{ color: primaryColor }}>
              {docTypeLabel}
            </div>
            <div className="mt-0.5 text-[6px] text-slate-500">
              {t("misc-number")}: <span className="font-semibold text-slate-700">OF-2026-0014</span>
            </div>
          </div>
          <div className="shrink-0 text-right text-[6px] text-slate-600">
            <div>{t("misc-date")}: <span className="font-semibold text-slate-800">14 Mar 2026</span></div>
            <div>{t("misc-valid-until")}: <span className="font-semibold text-slate-800">14 Apr 2026</span></div>
            <div>{t("misc-currency")}: <span className="font-semibold text-slate-800">USD</span></div>
          </div>
        </div>
      );

    case "from_box":
      return (
        <div className="w-full text-[6px] leading-tight">
          <div className="text-[6px] font-bold uppercase tracking-wide text-slate-400">
            {isLoi ? "FROM (BUYER)" : "FROM (SELLER)"}
          </div>
          <div className="text-[7px] font-bold" style={{ color: primaryColor }}>{companyName}</div>
          <div className="text-slate-500">{address}</div>
          {vat && <div className="text-slate-500">{t("misc-tve-vat-label")}: {vat}</div>}
        </div>
      );

    case "to_box":
      return (
        <div className="w-full text-[6px] leading-tight">
          <div className="text-[6px] font-bold uppercase tracking-wide text-slate-400">
            {isLoi ? "TO (SELLER)" : "TO (BUYER)"}
          </div>
          <div className="text-[7px] font-bold text-slate-800">Mediterra Exports GmbH</div>
          <div className="text-slate-500">Hafenstraße 4, 20457 Hamburg</div>
          <div className="text-slate-500">Germany</div>
        </div>
      );

    case "trade_terms":
      return isLoi ? (
        <div className="w-full text-[6px] leading-tight">
          <div className="text-[7px] font-bold text-slate-800">{t("misc-tve-delivery-terms")}</div>
          <div className="text-slate-600">Delivery Terms: CIF Hamburg · Payment: 30% advance, 70% at sight</div>
          <div className="text-slate-600">Delivery Date: 30 Apr 2026 · Valid Until: 14 Apr 2026</div>
        </div>
      ) : (
        <div className="flex w-full items-center justify-between text-[6.5px]">
          <span className="font-semibold text-slate-800">{t("misc-tve-incoterm")}: <span style={{ color: primaryColor }}>EXW · Hamburg</span></span>
          <span className="text-slate-500">{t("misc-tve-payment")}: <span className="font-semibold">Net 30</span></span>
        </div>
      );

    case "line_items_table":
      return <MiniLineItemsTable rows={SAMPLE_LINE_ITEMS} t={t} />;

    case "specifications":
      return isLoi ? (
        <div className="w-full text-[6px] leading-tight">
          <div className="text-[7px] font-bold text-slate-800">{t("misc-tve-product-specs")}</div>
          <div className="text-slate-600">Product Name: Refined Sunflower Oil · Quantity: 500 MT</div>
          <div className="text-slate-600">Unit Price: $1,160.00 · Total Value: $580,000.00</div>
          <div className="text-slate-600">Origin Country: Ukraine · HS Code: 15121110</div>
        </div>
      ) : (
        <div className="w-full text-[6px] leading-tight">
          <div className="text-[7px] font-bold text-slate-800">{t("misc-tve-specifications")}</div>
          <div className="text-slate-600">Moisture: ≤14% · Foreign matter: ≤2% · Broken: ≤5%</div>
          <div className="text-slate-600">Packing: 50kg PP bags · Origin: EU</div>
        </div>
      );

    case "totals": {
      const subtotal = 12960 + 25400;
      const vat10 = Math.round(subtotal * 0.1);
      const total = subtotal + vat10;
      return (
        <div className="w-1/2 text-right text-[6.5px] leading-tight">
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
        <div className="w-full text-[6px] italic leading-tight text-slate-600">
          <span className="font-semibold not-italic">{t("misc-tve-amount-words")}:</span> Forty-two thousand one hundred ninety-six US dollars only.
        </div>
      );

    case "offer_text":
      return isLoi ? (
        <div className="w-full text-[6px] leading-relaxed text-slate-600">
          <span className="font-semibold" style={{ color: primaryColor }}>Dear Mediterra Exports GmbH,</span>
          <div className="mt-0.5">We, {companyName}, hereby express our firm intention to purchase the following goods under the terms and conditions stated in this Letter of Intent…</div>
        </div>
      ) : (
        <div className="w-full text-[6px] leading-tight text-slate-600">
          <span className="font-semibold" style={{ color: primaryColor }}>{t("misc-terms")}: </span>
          30% advance, 70% before shipment. Delivery CIF Hamburg port. Inspection by SGS at loading.
        </div>
      );

    case "bank_details":
      return (
        <div className="w-full text-[6px] leading-tight">
          <span className="font-semibold text-slate-800">{t("misc-tve-bank-label")}: </span>
          <span className="text-slate-700">{bankName}</span>
          <span className="text-slate-500"> · {t("misc-tve-iban-label")}: {iban}</span>
        </div>
      );

    case "signatures":
      return (
        <div className="flex w-full items-end justify-between px-6 text-[6px] text-slate-600">
          <div className="flex flex-col items-center">
            <div className="border-t border-slate-500" style={{ width: 60 }} />
            <div className="mt-0.5">{t("misc-tve-seller-signature")}</div>
          </div>
          <div className="flex flex-col items-center">
            <div className="border-t border-slate-500" style={{ width: 60 }} />
            <div className="mt-0.5">{t("misc-tve-buyer-signature")}</div>
          </div>
        </div>
      );

    case "footer": {
      const cfg = parseContentConfig(resolveFieldContent(field, template));
      if (cfg.segments.length > 0) {
        return (
          <div className="flex w-full flex-col justify-center overflow-hidden">
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
        <div className="w-full truncate text-[6px] text-slate-500">
          {`${companyName} · Reg#${getRegNumber(letterhead)} · ${t("misc-tve-page-n-of-m").replace("{n}", "1").replace("{m}", "5")}`}
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
// Sortable section row (left panel)
// ============================================================

function SortableSectionRow({
  field,
  position,
  total,
  selected,
  onSelect,
  onToggleVisible,
}: {
  field: FieldElement;
  position: number;
  total: number;
  selected: boolean;
  onSelect: () => void;
  onToggleVisible: () => void;
}) {
  const t = useT();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: field.id,
  });
  const isFixed = !FLOW_TYPES.has(field.type);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex items-center gap-1.5 rounded-md border p-1.5 pr-2 text-sm transition-colors",
        selected ? "border-primary/40 bg-primary/10" : "border-transparent hover:bg-muted/60",
        isDragging && "z-10 shadow-md ring-1 ring-primary/30",
        !field.visible && "opacity-60"
      )}
      onClick={onSelect}
    >
      {isFixed ? (
        <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground/50">
          <Lock className="size-3" />
        </span>
      ) : (
        <button
          type="button"
          className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground/70 hover:text-foreground active:cursor-grabbing"
          title={t("misc-tve-drag-reorder")}
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="size-3.5" />
        </button>
      )}
      <span className={cn("flex-1 truncate", !field.visible && "line-through")}>
        {t(field.label)}
      </span>
      {isFixed ? (
        <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[9px] font-medium">
          {t("misc-tve-fixed")}
        </Badge>
      ) : (
        <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground">
          {position}/{total}
        </span>
      )}
      <button
        type="button"
        className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
        title={field.visible ? t("misc-tve-hide-field") : t("misc-tve-show-field")}
        onClick={(e) => {
          e.stopPropagation();
          onToggleVisible();
        }}
      >
        {field.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
      </button>
    </div>
  );
}

// ============================================================
// Main editor
// ============================================================

export function TemplateVisualEditor({
  template,
  onChange,
  pageSize,
  letterhead,
}: TemplateVisualEditorProps) {
  const t = useT();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [fields, setFields] = React.useState<FieldElement[]>(() =>
    defaultFieldsFor(template.type)
  );

  // ── layout persistence: hydrate on template identity change ────────
  const hydratedFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    const key = `${(template as { id?: string })?.id ?? "new"}:${template.type ?? "offer"}`;
    if (hydratedFor.current === key) return;
    hydratedFor.current = key;
    const parsed = readTemplateLayout((template as { layout_json?: unknown }).layout_json);
    const allowed = new Set<string>([
      ...FIXED_TOP, ...FIXED_BOTTOM,
      ...flowSectionsFor(template.type).map((s) => s.type),
      "custom_text", "custom_image",
    ]);
    let base: FieldElement[] = defaultFieldsFor(template.type);
    if (parsed && parsed.fields.length > 0) {
      const canonicalLabels = new Map<string, string>(
        defaultFieldsFor(template.type).map((d) => [d.id, d.label] as [string, string]),
      );
      const stored = parsed.fields
        .filter((f) => allowed.has(f.type))
        .map((f) => ({
          ...f,
          type: f.type as FieldType,
          // Built-in sections always carry the canonical label for the
          // template type (stored labels are pre-audit27 relics); only
          // custom fields keep their user-edited label.
          label:
            f.type === "custom_text" || f.type === "custom_image"
              ? (f.label ?? "Custom")
              : (canonicalLabels.get(f.id) ?? canonicalLabels.get(f.type) ?? "Custom"),
        }));
      if (stored.length > 0) base = stored;
    }
    // Reindex the flow sort keys (y) to a clean 10, 20, 30… sequence so the
    // order survives round-trips deterministically.
    const flows = base.filter((f) => FLOW_TYPES.has(f.type)).sort((a, b) => a.y - b.y);
    flows.forEach((f, i) => { f.y = (i + 1) * 10; });
    const fixedTop = base.filter((f) => FIXED_TOP.includes(f.type));
    const fixedBottom = base.filter((f) => FIXED_BOTTOM.includes(f.type));
    const customs = base.filter((f) => f.type === "custom_text" || f.type === "custom_image");
     
    setFields([...fixedTop, ...flows, ...fixedBottom, ...customs]);
  }, [template]);

  // ── emit into the parent form on every change (persist to layout_json)
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
   
  }, [fields]);

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [zoom, setZoom] = React.useState(1);
  const [customFieldCounter, setCustomFieldCounter] = React.useState(0);
  const canvasContainerRef = React.useRef<HTMLDivElement | null>(null);
  const flowRefs = React.useRef<Map<string, HTMLDivElement>>(new Map());
  const [dragOverContent, setDragOverContent] = React.useState(false);

  const renderScale = BASE_SCALE * zoom;
  const effectivePageSize: "A4" | "Letter" =
    pageSize ?? (template.page_size === "Letter" ? "Letter" : "A4");
  const page = PAGE_DIMENSIONS[effectivePageSize];
  const pageWidthPx = page.width * renderScale;

  // Ordered flow fields (sort by y — the same key the PDF renderer uses).
  const flowFields = React.useMemo(
    () => fields.filter((f) => FLOW_TYPES.has(f.type)).sort((a, b) => a.y - b.y),
    [fields]
  );
  const overlays = fields.filter((f) => f.type === "custom_text" || f.type === "custom_image");
  const logoField = fields.find((f) => f.type === "logo");
  const headerField = fields.find((f) => f.type === "header");
  const footerField = fields.find((f) => f.type === "footer");

  const selected = fields.find((f) => f.id === selectedId) ?? null;
  const selectedIsOverlay = selected?.type === "custom_text" || selected?.type === "custom_image";
  const selectedFlowIndex = selected ? flowFields.findIndex((f) => f.id === selected.id) : -1;

  const marginTop = template.page_margin_top ?? 20;
  const marginBottom = template.page_margin_bottom ?? 20;
  const marginLeft = template.page_margin_left ?? 18;
  const marginRight = template.page_margin_right ?? 18;

  // ---------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------

  const updateTemplate = (updates: Partial<DocumentTemplate>) => {
    onChange({ ...template, ...updates });
  };

  const updateField = (id: string, updates: Partial<FieldElement>) => {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...updates } : f)));
  };

  const updateFieldProps = (id: string, props: Record<string, unknown>) => {
    setFields((prev) =>
      prev.map((f) => (f.id === id ? { ...f, props: { ...(f.props || {}), ...props } } : f))
    );
  };

  /** Reindex the flow y keys after any reorder (10, 20, 30…). */
  const reindexFlow = (next: FieldElement[]): FieldElement[] => {
    const flows = next.filter((f) => FLOW_TYPES.has(f.type)).sort((a, b) => a.y - b.y);
    const keyed = new Map(flows.map((f, i) => [f.id, (i + 1) * 10]));
    return next.map((f) => (keyed.has(f.id) ? { ...f, y: keyed.get(f.id)! } : f));
  };

  /** Move a flow field one position up/down. */
  const moveFlow = (id: string, dir: -1 | 1) => {
    setFields((prev) => {
      const flows = prev.filter((f) => FLOW_TYPES.has(f.type)).sort((a, b) => a.y - b.y);
      const idx = flows.findIndex((f) => f.id === id);
      const target = idx + dir;
      if (idx < 0 || target < 0 || target >= flows.length) return prev;
      const moved = arrayMove(flows, idx, target);
      const keyed = new Map(moved.map((f, i) => [f.id, (i + 1) * 10]));
      return reindexFlow(prev.map((f) => (keyed.has(f.id) ? { ...f, y: keyed.get(f.id)! } : f)));
    });
  };

  /** dnd-kit reorder from the section list. */
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    setFields((prev) => {
      const flows = prev.filter((f) => FLOW_TYPES.has(f.type)).sort((a, b) => a.y - b.y);
      const from = flows.findIndex((f) => f.id === activeId);
      const to = flows.findIndex((f) => f.id === overId);
      if (from < 0 || to < 0) return prev;
      const moved = arrayMove(flows, from, to);
      const keyed = new Map(moved.map((f, i) => [f.id, (i + 1) * 10]));
      return reindexFlow(prev.map((f) => (keyed.has(f.id) ? { ...f, y: keyed.get(f.id)! } : f)));
    });
  };

  // ---------------------------------------------------------
  // Canvas flow-section drag (mousedown on a section header bar →
  // live-swap when the pointer crosses a neighbour's midpoint)
  // ---------------------------------------------------------

  const flowDrag = React.useRef<{ id: string; startY: number } | null>(null);

  const startFlowDrag = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    setSelectedId(id);
    flowDrag.current = { id, startY: e.clientY };
    const onMove = (ev: MouseEvent) => {
      const d = flowDrag.current;
      if (!d) return;
      const draggedEl = flowRefs.current.get(d.id);
      if (!draggedEl) return;
      const r = draggedEl.getBoundingClientRect();
      const center = r.top + r.height / 2;
      for (const [otherId, el] of flowRefs.current) {
        if (otherId === d.id) continue;
        const or = el.getBoundingClientRect();
        if (center > or.top + or.height * 0.35 && center < or.bottom - or.height * 0.35) {
          // Crossed far enough into the neighbour → swap the sort keys.
          setFields((prev) => {
            const a = prev.find((f) => f.id === d.id);
            const b = prev.find((f) => f.id === otherId);
            if (!a || !b) return prev;
            const yA = a.y, yB = b.y;
            return reindexFlow(prev.map((f) =>
              f.id === d.id ? { ...f, y: yB } : f.id === otherId ? { ...f, y: yA } : f
            ));
          });
          break;
        }
      }
    };
    const onUp = () => {
      flowDrag.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // ---------------------------------------------------------
  // Overlay drag / resize (free absolute placement — real in the PDF)
  // ---------------------------------------------------------

  const overlayDrag = React.useRef<{
    id: string; startX: number; startY: number; origX: number; origY: number;
    origW: number; origH: number; mode: "move" | "resize";
  } | null>(null);

  const startOverlayDrag = (e: React.MouseEvent, field: FieldElement, mode: "move" | "resize") => {
    if (field.locked) return;
    e.preventDefault();
    e.stopPropagation();
    setSelectedId(field.id);
    overlayDrag.current = {
      id: field.id, startX: e.clientX, startY: e.clientY,
      origX: field.x, origY: field.y, origW: field.width, origH: field.height, mode,
    };
    const onMove = (ev: MouseEvent) => {
      const d = overlayDrag.current;
      if (!d) return;
      const dx = (ev.clientX - d.startX) / renderScale;
      const dy = (ev.clientY - d.startY) / renderScale;
      setFields((prev) => prev.map((f) => {
        if (f.id !== d.id) return f;
        if (d.mode === "resize") {
          return {
            ...f,
            width: Math.max(10, Math.min(page.width - d.origX, d.origW + dx)),
            height: Math.max(6, Math.min(page.height - d.origY, d.origH + dy)),
          };
        }
        return {
          ...f,
          x: Math.max(0, Math.min(page.width - f.width, d.origX + dx)),
          y: Math.max(0, Math.min(page.height - f.height, d.origY + dy)),
        };
      }));
    };
    const onUp = () => {
      overlayDrag.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // ---------------------------------------------------------
  // Add / delete / reset
  // ---------------------------------------------------------

  const addCustomText = () => {
    const idx = customFieldCounter + 1;
    const newField: FieldElement = {
      id: `custom_text_${Date.now()}`,
      type: "custom_text",
      label: `Custom text ${idx}`,
      x: 40, y: 40, width: 90, height: 12,
      visible: true, locked: false,
      props: { content: "" },
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
      label: `Custom image ${idx}`,
      x: 60, y: 100, width: 50, height: 25,
      visible: true, locked: false,
      props: { imageUrl: null },
    };
    setFields((prev) => [...prev, newField]);
    setCustomFieldCounter(idx);
    setSelectedId(newField.id);
  };

  const deleteField = (id: string) => {
    setFields((prev) => prev.filter((f) => f.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const resetLayout = () => {
    setFields(defaultFieldsFor(template.type));
    setSelectedId(null);
    setCustomFieldCounter(0);
  };

  const fitToWidth = () => {
    const containerWidth = canvasContainerRef.current?.clientWidth || 800;
    const padding = 48;
    const newZoom = (containerWidth - padding) / (page.width * BASE_SCALE);
    setZoom(Math.max(0.4, Math.min(2, newZoom)));
  };

  // ---------------------------------------------------------
  // Inline content editing (header / footer persist to the template
  // columns; custom_text overlays persist in field props — both are REAL
  // and render in the PDF.)
  // ---------------------------------------------------------

  const selectedPersistedKey: "header_content" | "footer_content" | null =
    selected?.type === "header" ? "header_content" : selected?.type === "footer" ? "footer_content" : null;

  const getSelectedContentText = (): string => {
    if (!selected) return "";
    if (selectedPersistedKey) return contentToPlainText(template[selectedPersistedKey]);
    return (selected.props?.content as string) || "";
  };

  const setSelectedContentText = (text: string) => {
    if (!selected) return;
    if (selectedPersistedKey) {
      updateTemplate({
        [selectedPersistedKey]: plainTextToContentJson(text, template[selectedPersistedKey], `visual-${selected.type}`),
      } as Partial<DocumentTemplate>);
    } else {
      updateFieldProps(selected.id, { content: text });
    }
  };

  // ---------------------------------------------------------
  // Canvas
  // ---------------------------------------------------------

  const canvasHeaderFooterStrip = (field: FieldElement | undefined, zone: "top" | "bottom") => {
    if (!field) return null;
    const isSelected = selectedId === field.id;
    return (
      <div
        className={cn(
          "flex cursor-pointer items-center gap-2 border-b border-dashed px-2 py-1.5 transition-colors",
          zone === "bottom" && "border-b-0 border-t",
          isSelected ? "bg-primary/10" : "bg-slate-50/80 hover:bg-slate-100"
        )}
        onClick={() => setSelectedId(field.id)}
        title={t("misc-tve-fixed-every-page")}
      >
        {field.type === "logo" ? (
          <div className="w-24 shrink-0">
            {renderFieldContent(field, template, letterhead, t)}
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          {renderFieldContent(field, template, letterhead, t)}
        </div>
        <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[8px]">
          <Lock className="mr-1 size-2.5" />
          {t("misc-tve-fixed")}
        </Badge>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ─── Toolbar ─── */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-background p-2">
        <Button size="sm" variant="outline" onClick={addCustomText} title={t("misc-tve-add-text-block")}>
          <Plus className="size-3.5" /> <Type className="size-3.5" /> {t("misc-tve-text-block")}
        </Button>
        <Button size="sm" variant="outline" onClick={addCustomImage} title={t("misc-tve-add-image-block")}>
          <Plus className="size-3.5" /> <ImageIcon className="size-3.5" /> {t("misc-tve-image-block")}
        </Button>
        <div className="h-6 w-px bg-border" />
        <Button
          size="sm"
          variant="outline"
          onClick={resetLayout}
          title={t("misc-tve-reset-layout")}
        >
          <RotateCcw className="size-3.5" /> {t("misc-tve-reset-layout")}
        </Button>
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="outline" className="size-8 p-0" onClick={() => setZoom((z) => Math.max(0.4, Math.round((z - 0.15) * 100) / 100))} title={t("misc-tve-zoom-out")}>
            <ZoomOut className="size-3" />
          </Button>
          <span className="w-11 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
          <Button size="sm" variant="outline" className="size-8 p-0" onClick={() => setZoom((z) => Math.min(2, Math.round((z + 0.15) * 100) / 100))} title={t("misc-tve-zoom-in")}>
            <ZoomIn className="size-3" />
          </Button>
          <Button size="sm" variant="outline" className="h-8 px-2" onClick={fitToWidth} title={t("misc-tve-fit-hint")}>
            <Maximize2 className="size-3" /> {t("misc-tve-fit")}
          </Button>
          <span className="ml-2 hidden text-xs text-muted-foreground lg:inline">
            {effectivePageSize} · {page.width}×{page.height}mm
          </span>
        </div>
      </div>

      {/* ─── Honest hint — everything here is real ─── */}
      <div className="flex items-center gap-1.5 border-b bg-muted/30 px-3 py-1.5 text-[11px] leading-tight text-muted-foreground">
        <Info className="size-3 shrink-0" />
        <span>{t("doc-visual-flow-hint")}</span>
      </div>

      {/* ─── Body: 3 panels ─── */}
      <div className="flex min-h-0 flex-1">
        {/* LEFT — Sections (sortable list) */}
        <div className="w-56 shrink-0 overflow-y-auto border-r custom-scroll">
          <div className="space-y-1 p-2.5">
            <h3 className="mb-1.5 px-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("misc-tve-sections")}
            </h3>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={flowFields.map((f) => f.id)}
                strategy={verticalListSortingStrategy}
              >
                {flowFields.map((f, i) => (
                  <SortableSectionRow
                    key={f.id}
                    field={f}
                    position={i + 1}
                    total={flowFields.length}
                    selected={selectedId === f.id}
                    onSelect={() => setSelectedId(f.id)}
                    onToggleVisible={() => updateField(f.id, { visible: !f.visible })}
                  />
                ))}
              </SortableContext>
            </DndContext>

            <div className="mt-2 border-t pt-2">
              <p className="mb-1.5 px-1.5 text-[10px] text-muted-foreground">
                {t("misc-tve-fixed-every-page")}
              </p>
              {[logoField, headerField, footerField].map((f) =>
                f ? (
                  <div
                    key={f.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-1.5 rounded-md border border-transparent p-1.5 pr-2 text-sm transition-colors",
                      selectedId === f.id ? "border-primary/40 bg-primary/10" : "hover:bg-muted/60",
                      !f.visible && "opacity-60"
                    )}
                    onClick={() => setSelectedId(f.id)}
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground/50">
                      <Lock className="size-3" />
                    </span>
                    <span className={cn("flex-1 truncate", !f.visible && "line-through")}>{t(f.label)}</span>
                    {f.type === "logo" ? (
                      <button
                        type="button"
                        className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                        title={f.visible ? t("misc-tve-hide-field") : t("misc-tve-show-field")}
                        onClick={(e) => {
                          e.stopPropagation();
                          updateField(f.id, { visible: !f.visible });
                        }}
                      >
                        {f.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                      </button>
                    ) : null}
                  </div>
                ) : null
              )}
            </div>

            {overlays.length > 0 && (
              <div className="mt-2 border-t pt-2">
                <p className="mb-1.5 px-1.5 text-[10px] text-muted-foreground">
                  {t("misc-tve-overlays")}
                </p>
                {overlays.map((f) => (
                  <div
                    key={f.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-1.5 rounded-md border border-transparent p-1.5 pr-2 text-sm transition-colors",
                      selectedId === f.id ? "border-primary/40 bg-primary/10" : "hover:bg-muted/60",
                      !f.visible && "opacity-60"
                    )}
                    onClick={() => setSelectedId(f.id)}
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground/70">
                      {f.type === "custom_text" ? <Type className="size-3" /> : <ImageIcon className="size-3" />}
                    </span>
                    <span className={cn("flex-1 truncate", !f.visible && "line-through")}>{t(f.label)}</span>
                    <button
                      type="button"
                      className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                      title={f.visible ? t("misc-tve-hide-field") : t("misc-tve-show-field")}
                      onClick={(e) => {
                        e.stopPropagation();
                        updateField(f.id, { visible: !f.visible });
                      }}
                    >
                      {f.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* CENTER — Canvas */}
        <div ref={canvasContainerRef} className="flex-1 overflow-y-auto bg-muted/20 p-4 custom-scroll">
          <div
            className="relative mx-auto flex flex-col bg-white shadow-lg"
            style={{ width: pageWidthPx }}
            onClick={(e) => {
              if (e.target === e.currentTarget) setSelectedId(null);
            }}
          >
            {/* Fixed header zone */}
            {canvasHeaderFooterStrip(logoField && logoField.visible ? logoField : undefined, "top")}
            {canvasHeaderFooterStrip(headerField, "top")}

            {/* Flow body */}
            <div
              className="relative border-x border-dashed"
              style={{
                borderColor: "rgba(147,197,253,0.6)",
                margin: 0,
                padding: `${Math.max(4, marginTop * 0.25 * zoom)}px ${Math.max(4, marginRight * 0.3 * zoom)}px`,
              }}
            >
              {flowFields.map((f, i) => {
                const isSelected = selectedId === f.id;
                return (
                  <div
                    key={f.id}
                    ref={(el) => {
                      if (el) flowRefs.current.set(f.id, el);
                      else flowRefs.current.delete(f.id);
                    }}
                    className={cn(
                      "group mb-1.5 rounded-md border transition-colors",
                      isSelected
                        ? "border-primary bg-primary/5"
                        : "border-slate-200 hover:border-slate-300",
                      !f.visible && "opacity-40"
                    )}
                  >
                    {/* Drag bar */}
                    <div
                      className="flex cursor-grab select-none items-center gap-1.5 border-b border-slate-100 bg-slate-50/80 px-1.5 py-1 active:cursor-grabbing"
                      onMouseDown={(e) => startFlowDrag(e, f.id)}
                    >
                      <GripVertical className="size-3 shrink-0 text-slate-400" />
                      <span className="truncate text-[9px] font-medium text-slate-500">
                        {t(f.label)}
                      </span>
                      <span className="ml-auto text-[8px] tabular-nums text-slate-400">
                        {i + 1}/{flowFields.length}
                      </span>
                      <button
                        type="button"
                        className="flex size-4 items-center justify-center rounded text-slate-400 hover:text-slate-700"
                        title={f.visible ? t("misc-tve-hide-field") : t("misc-tve-show-field")}
                        onClick={(e) => {
                          e.stopPropagation();
                          updateField(f.id, { visible: !f.visible });
                        }}
                      >
                        {f.visible ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
                      </button>
                    </div>
                    {/* Content preview */}
                    <div
                      className="cursor-pointer px-2 py-1.5"
                      onClick={() => setSelectedId(f.id)}
                    >
                      {f.visible ? (
                        renderFieldContent(f, template, letterhead, t)
                      ) : (
                        <div className="py-1 text-center text-[9px] italic text-slate-400">
                          {t("misc-tve-hidden-section")}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Free overlays — real absolute placement (every PDF page) */}
              {overlays.filter((f) => f.visible).map((f) => {
                const isSelected = selectedId === f.id;
                return (
                  <div
                    key={f.id}
                    onMouseDown={(e) => startOverlayDrag(e, f, "move")}
                    className={cn(
                      "absolute z-10 flex select-none flex-col overflow-hidden border text-[9px] leading-tight",
                      isSelected
                        ? "cursor-move border-primary bg-primary/10"
                        : "cursor-move border-dashed border-teal-400 bg-teal-50/40 hover:bg-teal-50",
                      f.locked && "cursor-default opacity-60"
                    )}
                    style={{
                      left: f.x * renderScale,
                      top: f.y * renderScale,
                      width: f.width * renderScale,
                      height: f.height * renderScale,
                    }}
                    title={t("misc-tve-overlay-hint")}
                  >
                    <div className="pointer-events-none flex-1 overflow-hidden p-0.5">
                      {renderFieldContent(f, template, letterhead, t)}
                    </div>
                    {isSelected && !f.locked && (
                      <div
                        onMouseDown={(e) => startOverlayDrag(e, f, "resize")}
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

            {/* Fixed footer zone */}
            {canvasHeaderFooterStrip(footerField, "bottom")}
          </div>
        </div>

        {/* RIGHT — Properties */}
        <div className="w-72 shrink-0 overflow-y-auto border-l custom-scroll">
          <div className="space-y-4 p-3">
            {selected ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold uppercase text-muted-foreground">
                    {t("misc-tve-properties")}
                  </h3>
                  <Badge variant="outline" className="text-[10px]">
                    {selectedIsOverlay
                      ? t("misc-tve-overlay-badge")
                      : FLOW_TYPES.has(selected.type)
                        ? `${selectedFlowIndex + 1} / ${flowFields.length}`
                        : t("misc-tve-fixed")}
                  </Badge>
                </div>

                {/* Label */}
                <div>
                  <Label className="text-xs">{t("misc-tve-label")}</Label>
                  <Input
                    value={selected.label}
                    onChange={(e) => updateField(selected.id, { label: e.target.value })}
                  />
                </div>

                {/* Visibility */}
                <div className="flex items-center justify-between">
                  <Label className="flex items-center gap-1 text-xs">
                    <Eye className="size-3" /> {t("misc-tve-visible")}
                  </Label>
                  <Switch
                    checked={selected.visible}
                    onCheckedChange={(v) => updateField(selected.id, { visible: v })}
                    aria-label={t("misc-tve-visible")}
                  />
                </div>

                {/* Order — flow sections only */}
                {!selectedIsOverlay && FLOW_TYPES.has(selected.type) && (
                  <div>
                    <Label className="mb-1.5 block text-xs">{t("misc-tve-order")}</Label>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 flex-1"
                        disabled={selectedFlowIndex <= 0}
                        onClick={() => moveFlow(selected.id, -1)}
                        title={t("misc-tve-move-up")}
                      >
                        <ArrowUp className="size-3.5" /> {t("misc-tve-move-up")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 flex-1"
                        disabled={selectedFlowIndex < 0 || selectedFlowIndex >= flowFields.length - 1}
                        onClick={() => moveFlow(selected.id, 1)}
                        title={t("misc-tve-move-down")}
                      >
                        <ArrowDown className="size-3.5" /> {t("misc-tve-move-down")}
                      </Button>
                    </div>
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      {t("misc-tve-order-hint")}
                    </p>
                  </div>
                )}

                <Separator />

                {/* Geometry — overlays only (REAL absolute placement) */}
                {selectedIsOverlay && (
                  <div>
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <Label className="text-xs">{t("misc-tve-position-size")}</Label>
                      <span className="text-[10px] text-muted-foreground">{t("misc-tve-overlay-hint")}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {(["x", "y", "width", "height"] as const).map((k) => (
                        <div key={k}>
                          <Label className="text-[10px] capitalize text-muted-foreground">
                            {k === "x" ? "X (mm)" : k === "y" ? "Y (mm)" : k === "width" ? t("misc-tve-width-mm") : t("misc-tve-height-mm")}
                          </Label>
                          <Input
                            type="number"
                            value={Math.round(selected[k])}
                            onChange={(e) => {
                              const v = Number(e.target.value) || 0;
                              updateField(selected.id, { [k]: Math.max(k === "x" || k === "y" ? 0 : 6, v) } as Partial<FieldElement>);
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Image URL — custom images */}
                {selected.type === "custom_image" && (
                  <div>
                    <Label className="text-xs">{t("misc-tve-image-url")}</Label>
                    <Input
                      placeholder="https://… or /uploads/…"
                      value={(selected.props?.imageUrl as string) || ""}
                      onChange={(e) => updateFieldProps(selected.id, { imageUrl: e.target.value })}
                    />
                  </div>
                )}

                {/* Content editor — header / footer (persisted columns) and
                    custom_text overlays (field props). Both render in the PDF. */}
                {["header", "footer", "custom_text"].includes(selected.type) && (
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold uppercase text-muted-foreground">
                      {t("misc-tve-content")}
                    </h4>
                    <div>
                      <Label className="text-xs text-muted-foreground">
                        {t("misc-tve-click-placeholders")}
                      </Label>
                      <div className="mt-1 flex max-h-24 flex-wrap gap-1 overflow-y-auto rounded border bg-muted/30 p-1.5 custom-scroll">
                        {PLACEHOLDERS.map((ph) => (
                          <button
                            key={ph.key}
                            type="button"
                            draggable
                            onDragStart={(e) => {
                              e.dataTransfer.setData("text/plain", ph.key);
                              e.dataTransfer.effectAllowed = "copy";
                            }}
                            onClick={() => {
                              // Click = append (faster than dragging).
                              const current = getSelectedContentText();
                              setSelectedContentText(current.trim() ? `${current} ${ph.key}` : ph.key);
                            }}
                            className="flex items-center gap-1 rounded border bg-background px-1.5 py-0.5 text-[10px] cursor-grab hover:border-primary/40 hover:bg-primary/5 select-none"
                            title={`${t(ph.label)} — ${ph.key}`}
                          >
                            {t(ph.label)}
                          </button>
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
                          const current = getSelectedContentText();
                          setSelectedContentText(current.trim() ? `${current} ${ph}` : ph);
                        }
                        setDragOverContent(false);
                      }}
                      placeholder={t("misc-tve-content-placeholder")}
                      className={cn("text-xs", dragOverContent && "ring-2 ring-primary ring-offset-1")}
                    />
                    {selectedPersistedKey && (
                      <p className="text-[10px] text-muted-foreground">
                        {t("misc-tve-content-persists-hint")}
                      </p>
                    )}
                  </div>
                )}

                {/* Honest hints for auto-filled sections */}
                {!selectedIsOverlay &&
                  ["offer_text", "bank_details", "trade_terms", "specifications",
                    "line_items_table", "totals", "amount_in_words", "doc_title",
                    "from_box", "to_box", "signatures"].includes(selected.type) && (
                  <div className="rounded-md border bg-muted/30 p-2.5 text-xs text-muted-foreground">
                    <Info className="mb-1 size-3.5" />
                    {t("misc-tve-auto-content-hint")}
                  </div>
                )}

                {/* Logo hint */}
                {selected.type === "logo" && (
                  <div className="rounded-md border bg-muted/30 p-2.5 text-xs text-muted-foreground">
                    {letterhead?.logo_url
                      ? t("misc-tve-source-from-letterhead")
                      : t("misc-tve-no-logo-hint")}
                  </div>
                )}

                {/* Delete — custom fields only */}
                {selectedIsOverlay && (
                  <>
                    <Separator />
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full text-destructive hover:text-destructive"
                      onClick={() => deleteField(selected.id)}
                    >
                      <Trash2 className="size-3.5" /> {t("misc-tve-delete-field")}
                    </Button>
                  </>
                )}
              </>
            ) : (
              <div className="py-8 text-center text-sm text-muted-foreground">
                <GripVertical className="mx-auto mb-2 size-6 opacity-40" />
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
                onValueChange={(v) => updateTemplate({ page_size: v as "A4" | "Letter" })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t("misc-tve-page-size")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="A4">{t("misc-tve-page-size-a4")}</SelectItem>
                  <SelectItem value="Letter">{t("misc-tve-page-size-letter")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="mb-1 block text-xs">{t("misc-tve-margins-mm")}</Label>
              <div className="grid grid-cols-2 gap-2">
                {(["top", "bottom", "left", "right"] as const).map((mm) => (
                  <div key={mm}>
                    <Label className="text-[10px] capitalize text-muted-foreground">
                      {t(`misc-tve-margin-${mm}`)}
                    </Label>
                    <Input
                      type="number"
                      value={template[`page_margin_${mm}`] ?? 20}
                      onChange={(e) =>
                        updateTemplate({
                          [`page_margin_${mm}`]: Number(e.target.value) || 0,
                        } as Partial<DocumentTemplate>)
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
