"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  Plus, Pencil, Trash2, FileText, Star, Copy, Save, Eye, LayoutTemplate,
  Type, Palette, Table as TableIcon, AlignCenter, AlignJustify,
  Building2, Stamp, ShieldCheck, Upload, ImageIcon, X, Lock,
  Waves, Droplet, RotateCw, MapPin, Pen, Layers, ChevronDown,
  Loader2, ExternalLink, FileSearch, RefreshCw, Braces, Grid3x3,
  PanelRightClose, PanelRightOpen, TriangleAlert, QrCode,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { ModuleInfoTooltip } from "@/components/common/module-info-tooltip";

import { EmptyState } from "@/components/common/empty-state";
import { QueryError } from "@/components/common/query-error";
import { TemplateVisualEditor } from "@/components/common/template-visual-editor";
import { TemplateStylePanel } from "@/components/common/template-style-panel";
import { BankAccountSelector } from "@/components/common/bank-account-selector";
import { MemorandumStudio } from "@/components/common/memorandum-studio";
import {
  parseContentConfig,
  substitutePlaceholders,
  DEFAULT_HEADER_CONTENT_JSON,
  DEFAULT_FOOTER_CONTENT_JSON,
  type ContentSegment,
} from "@/lib/utils/content-config";
import { parseStyleConfig } from "@/lib/utils/style-config";
import { readTemplateLayout } from "@/lib/pdf/doc-template";
import { fmtDate } from "@/lib/utils/format";
import {
  DocumentTemplate, TenantLetterhead, TenantSeal, Tenant, MemorandumSettings,
} from "@/lib/supabase/types";
import { useAppStore, isAdmin, isSuperAdmin } from "@/lib/store/app-store";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import {
  STARTER_TEMPLATES,
  type StarterTemplate,
} from "@/lib/data/starter-templates";
import { useT } from "@/lib/i18n/store";
import { MAX_LOGO_UPLOAD_SIZE } from "@/lib/upload/constants";

// ============================================================
// Constants
// ============================================================

type TemplateType = DocumentTemplate["type"];

// Canonical body-section order — mirrors the PDF renderer's
// CANONICAL_SECTION_ORDER (templates.tsx) so the draft preview's fallback
// ordering matches the generated document.
const CANONICAL_ORDER = [
  "doc_title", "from_box", "to_box", "trade_terms", "line_items_table",
  "specifications", "totals", "amount_in_words", "offer_text",
  "bank_details", "signatures",
] as const;

// Translation keys (resolved via `t()` at render time) — see TYPE_LABEL_KEYS.
const TYPE_LABEL_KEYS: Record<TemplateType, string> = {
  offer: "doc-type-offer",
  invoice: "doc-type-invoice",
  proforma: "doc-type-proforma",
  contract: "doc-type-contract",
  loi: "doc-type-loi",
  generic: "doc-type-generic",
};

const TYPE_BADGE: Record<TemplateType, string> = {
  offer: "bg-chart-1/15 text-chart-1 border-chart-1/30",
  invoice: "bg-chart-3/15 text-chart-3 border-chart-3/30",
  proforma: "bg-chart-2/15 text-chart-2 border-chart-2/30",
  contract: "bg-chart-4/15 text-chart-4 border-chart-4/30",
  loi: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  generic: "bg-muted text-muted-foreground border-border",
};

// AVAILABLE_VARIABLES labels are translation keys (resolved via `t()`).
// Tokens use the canonical {single-brace} syntax consumed by the shared
// substitutePlaceholders() engine in content-config.ts — the SAME engine the
// PDF generator uses, so tokens copied from this palette actually substitute
// at render time (the legacy {{double-brace}} tokens never did).
const AVAILABLE_VARIABLES: { token: string; label: string }[] = [
  { token: "{company_name}", label: "doc-var-company-name" },
  { token: "{company_legal_name}", label: "doc-var-legal-name" },
  { token: "{company_address}", label: "doc-var-address" },
  { token: "{company_city}", label: "doc-var-city" },
  { token: "{company_country}", label: "doc-var-country" },
  { token: "{company_postal_code}", label: "doc-var-postal-code" },
  { token: "{company_reg}", label: "doc-var-reg" },
  { token: "{company_vat}", label: "doc-var-vat" },
  { token: "{company_tax_id}", label: "doc-var-tax-id" },
  { token: "{company_phone}", label: "doc-var-phone" },
  { token: "{company_email}", label: "doc-var-email" },
  { token: "{company_website}", label: "doc-var-website" },
  { token: "{bank_name}", label: "doc-var-bank" },
  { token: "{bank_iban}", label: "doc-var-iban" },
  { token: "{bank_swift}", label: "doc-var-swift" },
  { token: "{doc_number}", label: "doc-var-doc-num" },
  { token: "{doc_date}", label: "doc-var-doc-date" },
  { token: "{valid_until}", label: "doc-var-valid-until" },
  { token: "{due_date}", label: "doc-var-due-date" },
  { token: "{partner_name}", label: "doc-var-partner-name" },
  { token: "{partner_address}", label: "doc-var-partner-address" },
  { token: "{partner_city}", label: "doc-var-partner-city" },
  { token: "{partner_country}", label: "doc-var-partner-country" },
  { token: "{total}", label: "doc-var-total" },
  { token: "{currency}", label: "doc-var-currency" },
  { token: "{page_number}", label: "doc-var-page-num" },
  { token: "{total_pages}", label: "doc-var-total-pages" },
];

// audit22: token palette for the Segment Studio (token WITHOUT braces —
// the studio inserts {token} at the cursor itself).
const STUDIO_VARIABLES = AVAILABLE_VARIABLES.map(({ token, label }) => ({
  token: token.replace(/[{}]/g, ""),
  label,
}));

/** Sample substitution data for the Segment Studio live preview — real
 *  values from the linked letterhead / tenant so the preview shows the
 *  actual company identity (falls back to realistic trade-doc samples). */
function buildStudioPreviewData(tenant: Tenant | null, letterhead: TenantLetterhead | null): Record<string, string> {
  const lh = letterhead;
  return {
    company_name: lh?.company_name || tenant?.name || "VELOS Trading Ltd",
    company_legal_name: lh?.company_legal_name || tenant?.legal_name || tenant?.name || "VELOS Trading Ltd",
    company_address: lh?.company_address_line || tenant?.address_line || "Trg Republike 5",
    company_city: lh?.company_city || tenant?.city || "Belgrade",
    company_country: lh?.company_country || tenant?.country || "Serbia",
    company_postal_code: String(lh?.company_postal_code || tenant?.postal_code || "11000"),
    company_reg: lh?.company_registration_number || tenant?.registration_number || "21312345",
    company_vat: lh?.company_vat_number || tenant?.vat_number || "RS108123456",
    company_tax_id: lh?.company_tax_id || tenant?.tax_id || "123456789",
    company_phone: lh?.company_phone || tenant?.phone || "+381 11 123 4567",
    company_email: lh?.company_email || tenant?.email || "office@velos-trading.com",
    company_website: lh?.company_website || tenant?.website || "www.velos-trading.com",
    bank_name: tenant?.bank_name || "Raiffeisen Bank",
    bank_iban: tenant?.bank_iban || "RS3526000560101234567",
    bank_swift: tenant?.bank_swift || "RZGSRSBG",
    doc_number: "OF-2025-001",
    doc_date: fmtDate(new Date().toISOString()),
    valid_until: fmtDate(new Date(Date.now() + 30 * 86400000).toISOString()),
    due_date: fmtDate(new Date(Date.now() + 15 * 86400000).toISOString()),
    partner_name: "Al Manara General Trading LLC",
    partner_address: "Sheikh Zayed Road 124",
    partner_city: "Dubai",
    partner_country: "UAE",
    total: "1,014,240.00",
    currency: tenant?.currency || "EUR",
  };
}

// HEADER_LAYOUTS / FOOTER_LAYOUTS / SEAL_POSITIONS / SEAL_DOC_TYPES labels are
// translation keys (resolved via `t()` at render time).
const HEADER_LAYOUTS = [
  { value: "logo-left-info-right", label: "doc-header-layout-logo-left" },
  { value: "logo-right-info-left", label: "doc-header-layout-logo-right" },
  { value: "logo-center", label: "doc-header-layout-logo-center" },
  { value: "text-only", label: "doc-header-layout-text-only" },
  { value: "two-column", label: "doc-header-layout-two-column" },
];

const FOOTER_LAYOUTS = [
  { value: "bank-contact-tax", label: "doc-footer-layout-bank-contact-tax" },
  { value: "bank-only", label: "doc-footer-layout-bank-only" },
  { value: "contact-only", label: "doc-footer-layout-contact-only" },
  { value: "tax-id-only", label: "doc-footer-layout-tax-id-only" },
  { value: "custom", label: "doc-footer-layout-custom" },
];

const SEAL_POSITIONS: { value: TenantSeal["position"]; label: string }[] = [
  { value: "bottom-right", label: "doc-pos-bottom-right" },
  { value: "bottom-left", label: "doc-pos-bottom-left" },
  { value: "bottom-center", label: "doc-pos-bottom-center" },
  { value: "top-right", label: "doc-pos-top-right" },
  { value: "top-left", label: "doc-pos-top-left" },
  { value: "top-center", label: "doc-pos-top-center" },
];

const SEAL_DOC_TYPES: { value: string; label: string }[] = [
  { value: "offer", label: "doc-type-offer-plural" },
  { value: "invoice", label: "doc-type-invoice-plural" },
  { value: "proforma", label: "doc-type-proforma-plural" },
  { value: "contract", label: "doc-type-contract-plural" },
  { value: "loi", label: "doc-type-loi-plural" },
];

// ============================================================
// Helpers
// ============================================================

function substituteForPreview(text: string): string {
  // 1. Normalize the legacy {{token}} syntax to the canonical {token} —
  //    before engine substitution, so a legacy token never half-matches.
  const normalized = (text || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, "{$1}");
  // 2. Map legacy token names that don't exist in the engine's canonical set
  //    (they were offered by the old {{...}} palettes).
  const mapped = normalized
    .replace(/{company_bank}/g, "{bank_name}")
    .replace(/{company_iban}/g, "{bank_iban}")
    .replace(/{company_swift}/g, "{bank_swift}")
    .replace(/{doc_valid}/g, "{valid_until}")
    .replace(/{page_total}/g, "{total_pages}")
    .replace(/{address}/g, "{company_address}")
    .replace(/{reg}/g, "{company_reg}")
    .replace(/{vat}/g, "{company_vat}")
    .replace(/{date}/g, "{doc_date}")
    .replace(/{payment_terms}/g, "30% advance, 70% before shipment");
  // 3. Canonical substitution via the shared engine (same one the PDF
  //    generator uses) with sample data.
  return substitutePlaceholders(mapped, PREVIEW_PLACEHOLDER_DATA);
}

// Sample data used by the live preview to substitute the new {placeholder}
// tokens introduced by the TemplateContentEditor. The legacy {{token}}
// syntax is normalized + mapped by substituteForPreview() above.
const PREVIEW_PLACEHOLDER_DATA = {
  company_name: "VELOS Trading",
  company_legal_name: "VELOS Trading LLC",
  company_address: "Trg Republike 5, Belgrade",
  company_city: "Belgrade",
  company_country: "Serbia",
  company_postal_code: "11000",
  company_reg: "RS-12345678",
  company_vat: "RS123456789",
  company_tax_id: "Tax-001",
  company_phone: "+381 11 555 0100",
  company_email: "office@velos.trade",
  company_website: "velos.trade",
  bank_name: "Raiffeisen Bank",
  bank_iban: "RS35 2600 0560 0012 3456 78",
  bank_swift: "RAFRCSBG",
  doc_number: "OF-2026-0014",
  doc_date: "14 Mar 2026",
  valid_until: "14 Apr 2026",
  due_date: "14 Apr 2026",
  partner_name: "Mediterra Exports GmbH",
  partner_address: "Hafenstraße 4, 20457 Hamburg, Germany",
  partner_city: "Hamburg",
  partner_country: "Germany",
  total: "$1,601,316",
  currency: "USD",
  page_number: 1,
  total_pages: 1,
};

/**
 * Resolve raw `header_content` / `footer_content` (which may be either the
 * new JSON {segments:[…]} format or the legacy plain-text format) into a
 * list of styled segments with placeholders substituted for the live preview.
 */
function resolvePreviewSegments(content: string): ContentSegment[] {
  const cfg = parseContentConfig(content);
  if (cfg) {
    return cfg.segments.map((s) => ({
      ...s,
      text: substitutePlaceholders(s.text, PREVIEW_PLACEHOLDER_DATA),
    }));
  }
  // Fallback: legacy plain text — render as one muted line.
  return [
    {
      id: "legacy",
      text: substituteForPreview(content || ""),
      fontSize: 8,
      bold: false,
      italic: false,
      color: "#64748b",
      alignment: "left",
    },
  ];
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function parseApplyToTypes(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.filter((x) => typeof x === "string");
  } catch {
    // ignore
  }
  return [];
}

function serializeApplyToTypes(arr: string[]): string {
  return JSON.stringify(arr);
}

// ============================================================
// Default form states
// ============================================================

type LetterheadFormState = Omit<TenantLetterhead, "id" | "tenant_id" | "created_by" | "created_at" | "updated_at">;

function defaultLetterhead(name = "Untitled letterhead"): LetterheadFormState {
  return {
    name,
    is_default: false,
    company_name: "",
    company_legal_name: "",
    company_address_line: "",
    company_city: "",
    company_postal_code: "",
    company_country: "",
    company_email: "",
    company_phone: "",
    company_website: "",
    company_vat_number: "",
    company_tax_id: "",
    company_registration_number: "",
    bank_name: "",
    bank_iban: "",
    bank_swift: "",
    bank_account_holder: "",
    logo_url: null,
    logo_position: "left",
    logo_width_mm: 40,
    logo_height_mm: 15,
    logo_lock_aspect: true,
    primary_color: "#0f766e",
    accent_color: "#0d9488",
    text_color: "#0f172a",
    muted_text_color: "#64748b",
    page_size: "A4",
    margin_top_mm: 25,
    margin_bottom_mm: 25,
    margin_left_mm: 20,
    margin_right_mm: 20,
    header_height_mm: 35,
    footer_height_mm: 28,
    header_layout: "logo-left-info-right",
    header_show_logo: true,
    header_show_company_name: true,
    header_show_contact: true,
    header_show_vat: false,
    header_divider: true,
    header_divider_color: "#e2e8f0",
    header_custom_html: null,
    footer_layout: "bank-contact-tax",
    footer_show_bank_details: true,
    footer_show_contact: true,
    footer_show_tax_id: true,
    footer_show_page_number: true,
    footer_divider: true,
    footer_divider_color: "#e2e8f0",
    footer_custom_html: null,
    footer_text: "",
    watermark_enabled: false,
    watermark_text: "DRAFT",
    watermark_color: "#94a3b8",
    watermark_opacity: 0.08,
    watermark_rotation: -45,
    body_font_family: "Inter, system-ui, sans-serif",
    body_font_size_pt: 11,
    heading_font_family: "Inter, system-ui, sans-serif",
    heading_font_size_pt: 16,
  };
}

type SealFormState = Omit<TenantSeal, "id" | "tenant_id" | "created_by" | "created_at" | "updated_at">;

function defaultSeal(name = "Untitled seal"): SealFormState {
  return {
    name,
    is_default: false,
    image_url: "",
    image_width_mm: 35,
    image_height_mm: 35,
    image_format: "png",
    position: "bottom-right",
    offset_x_mm: 0,
    offset_y_mm: 0,
    opacity: 1,
    rotation_deg: 0,
    apply_to_types: "[]",
    signature_enabled: false,
    signature_label: "Authorized signature",
    signature_name: "",
  };
}

type TemplateFormState = Omit<DocumentTemplate, "id" | "tenant_id" | "created_by" | "created_at" | "updated_at" | "letterhead" | "seal">;

function defaultTemplate(name = "Untitled template"): TemplateFormState {
  return {
    name,
    type: "offer",
    is_default: false,
    page_size: "A4",
    page_margin_top: 20,
    page_margin_bottom: 20,
    page_margin_left: 18,
    page_margin_right: 18,
    header_enabled: true,
    header_height: 24,
    header_content: DEFAULT_HEADER_CONTENT_JSON,
    header_show_logo: true,
    header_show_company_name: true,
    header_show_contact: true,
    footer_enabled: true,
    footer_height: 18,
    footer_content: DEFAULT_FOOTER_CONTENT_JSON,
    footer_show_page_number: true,
    footer_show_bank_details: true,
    footer_show_tax_id: true,
    body_font_family: "Inter, system-ui, sans-serif",
    body_font_size: 11,
    body_line_height: 1.5,
    primary_color: "#0f766e",
    accent_color: "#0d9488",
    table_header_bg: "#0f766e",
    table_header_color: "#ffffff",
    table_border_color: "#e2e8f0",
    table_stripe: true,
    letterhead_id: null,
    seal_id: null,
    seal_enabled: true,
    selected_bank_accounts: null,
    // QR placement defaults. These are stored INSIDE footer_content._qrConfig
    // at save time (see handleSave) — they are NOT real DB columns.
    qr_position: "footer-right",
    qr_size_mm: 15,
    qr_opacity: 1,
  };
}

// ── QR config helpers ─────────────────────────────────────────────
// QR placement (position / size / opacity) lives inside the footer_content
// JSON under a reserved `_qrConfig` key. It is NOT a real DB column on
// document_templates — storing it inside footer_content means we don't need
// a schema migration. parseContentConfig() ignores `_qrConfig` (it only
// reads `segments`), so the visual editor / PDF rendering are unaffected.
const QR_DEFAULTS = { position: "footer-right", size: 15, opacity: 1 };

// ── PDF font normalization ────────────────────────────────────────
// The PDF renderer resolves any body_font_family through mapFont()
// (src/lib/pdf/shared.ts): a CSS stack like "Inter, system-ui, sans-serif"
// or "Helvetica" silently becomes NotoSans; "Times New Roman" becomes
// Times-Roman; "Courier New" becomes Courier. This UI mirror maps the
// STORED value onto one of the three canonical families so the Select
// always shows the font the PDF will actually render with.
const UI_FONT_MAP: Record<string, string> = {
  // exact react-pdf / mapFont outputs
  notosans: "NotoSans",
  "times-roman": "Times-Roman",
  times: "Times-Roman",
  courier: "Courier",
  "courier-new": "Courier",
  // common CSS stack names → same buckets
  helvetica: "NotoSans",
  inter: "NotoSans",
  "system-ui": "NotoSans",
  "sans-serif": "NotoSans",
  arial: "NotoSans",
  "segoe-ui": "NotoSans",
  roboto: "NotoSans",
  "open-sans": "NotoSans",
  verdana: "NotoSans",
  tahoma: "NotoSans",
  "times-new-roman": "Times-Roman",
  serif: "Times-Roman",
  georgia: "Times-Roman",
  garamond: "Times-Roman",
  monospace: "Courier",
};
function normalizePdfFontFamily(stored: string | null | undefined): "NotoSans" | "Times-Roman" | "Courier" {
  if (!stored) return "NotoSans";
  const first = String(stored).split(",")[0].trim().replace(/['"]/g, "").toLowerCase().replace(/\s+/g, "-");
  return (UI_FONT_MAP[first] as "NotoSans" | "Times-Roman" | "Courier") || "NotoSans";
}

function parseQrConfig(footerContent: string | null | undefined): {
  position: string;
  size: number;
  opacity: number;
} {
  if (!footerContent) return { ...QR_DEFAULTS };
  try {
    const parsed = JSON.parse(footerContent);
    const q = parsed?._qrConfig;
    if (q && typeof q === "object") {
      return {
        position: typeof q.position === "string" ? q.position : QR_DEFAULTS.position,
        size: typeof q.size === "number" ? q.size : QR_DEFAULTS.size,
        opacity: typeof q.opacity === "number" ? q.opacity : QR_DEFAULTS.opacity,
      };
    }
  } catch {
    // footer_content might be legacy plain text — fall through to defaults.
  }
  return { ...QR_DEFAULTS };
}

/** Merge the QR placement fields into footer_content's `_qrConfig` key,
 *  preserving any existing `segments` array. Returns the serialized JSON. */
function writeQrConfig(
  footerContent: string | null | undefined,
  qr: { position: string; size: number; opacity: number },
): string {
  let parsed: any = { segments: [] };
  if (footerContent) {
    try {
      const maybe = JSON.parse(footerContent);
      if (maybe && typeof maybe === "object") parsed = maybe;
    } catch {
      // Legacy plain text — wrap into a single segment so we don't lose it.
      parsed = {
        segments: [
          {
            id: "legacy-footer",
            text: footerContent,
            fontSize: 7.5,
            bold: false,
            italic: false,
            color: "#666666",
            alignment: "left",
          },
        ],
      };
    }
  }
  parsed._qrConfig = { position: qr.position, size: qr.size, opacity: qr.opacity };
  return JSON.stringify(parsed);
}

// ============================================================
// Main view component
// ============================================================

export function DocumentTemplatesView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const user = useAppStore((s) => s.user);
  const admin = isAdmin(user);
  const superAdmin = isSuperAdmin(user);
  // audit33: the Memorandum studio is the first tab — the frame the whole
  // document system hangs on. It is also embedded in Settings → Memorandum
  // (single component, two mount points).
  const [activeTab, setActiveTab] = useState<string>("memorandum-frame");

  // ── audit21 — CRITICAL tenant-context fix ─────────────────────────────
  // The template editor previously defaulted to `tenants[0]` (whatever
  // order /api/tenants returned — for this platform an inactive audit-test
  // tenant) and IGNORED the active tenant context from the topbar switcher.
  // A super-admin who selected "ASPIDUS DMCC" in the topbar still edited
  // the FIRST tenant's templates here, while `api()` silently rewrote the
  // fetch to the topbar tenant — the editor showed one tenant's templates,
  // saved to another's, and the user's PDFs never changed ("template edits
  // never apply"). Now:
  //   1. the local selector initializes from the effective tenant context
  //   2. it FOLLOWS the topbar switcher when that context changes
  //   3. the in-view selector remains a manual override
  //   4. the `tenants[0]` fallback fires ONLY when no context is active
  const activeTenantId = useAppStore((s) => s.activeTenantId);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(
    activeTenantId ?? user?.tenant_id ?? null,
  );
  // Follow the topbar tenant switcher. Derived-during-render pattern (the
  // same one the `tenants[0]` fallback below already uses) — when the
  // topbar context changes, the local selection adjusts on the very next
  // render without an effect round-trip.
  const [lastSeenActiveTenant, setLastSeenActiveTenant] = useState<string | null>(activeTenantId);
  if (superAdmin && activeTenantId && activeTenantId !== lastSeenActiveTenant) {
    setLastSeenActiveTenant(activeTenantId);
    setSelectedTenantId(activeTenantId);
  }

  const tenantsQ = useQuery<{ items: Tenant[] }>({
    queryKey: ["tenants", tenantKey, "list"],
    queryFn: async () => {
      const r = await fetch(api("/api/tenants"));
      if (!r.ok) throw new Error("Failed to load tenants");
      return r.json();
    },
    enabled: superAdmin,
  });

  const tenants = tenantsQ.data?.items ?? [];

  // Last-resort fallback: super_admin with no topbar context and no saved
  // selection → first tenant (previous behaviour, now only a fallback).
  if (superAdmin && !selectedTenantId && tenants.length > 0) {
    setSelectedTenantId(tenants[0].id);
  }

  // Build query string for tenant-scoped API calls
  const tenantQuery = superAdmin && selectedTenantId ? `?tenant_id=${encodeURIComponent(selectedTenantId)}` : "";

  if (!admin) {
    return (
      <div>
        <PageHeader title={t("doc-templates-title")} description={t("doc-templates-noaccess-desc")} />
        <Card className="border-amber-500/30 bg-amber-50/40 dark:bg-amber-500/5">
          <CardContent className="p-6 flex items-start gap-3">
            <div className="size-10 rounded-xl bg-amber-500/15 text-amber-600 flex items-center justify-center shrink-0">
              <Lock className="size-5" />
            </div>
            <div>
              <p className="font-medium">{t("doc-admin-access-required")}</p>
              <p className="text-sm text-muted-foreground mt-1">
                {t("doc-admin-only-desc")}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("doc-templates-title")}
        description={t("doc-templates-desc")}
      />
      <ModuleInfoTooltip
        title="Document Templates"
        description="Create reusable templates for invoices, proformas, letters, and contracts with variables and conditional sections."
        howToUse={["Create a template with variables ({company_name}, {total})", "Add conditional sections (show/hide based on data)", "Multi-language support (en, sr, tr, de, ru)", "Preview with sample data", "Use templates when generating documents"]}
      />

      {superAdmin && (
        <Card className="border-border/60">
          <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex items-center gap-2 text-sm font-medium shrink-0">
              <Building2 className="size-4 text-primary" />
              {t("doc-managing-tenant")}
            </div>
            {tenantsQ.isLoading ? (
              <Skeleton className="h-9 w-full sm:w-72" />
            ) : tenants.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("doc-no-tenants")}</p>
            ) : (
              <Select value={selectedTenantId ?? undefined} onValueChange={(v) => setSelectedTenantId(v)}>
                <SelectTrigger className="w-full sm:w-72 h-9">
                  <SelectValue placeholder={t("doc-choose-tenant")} />
                </SelectTrigger>
                <SelectContent>
                  {tenants.map((tn) => (
                    <SelectItem key={tn.id} value={tn.id}>
                      <span className="flex items-center gap-2">
                        <Building2 className="size-3.5 text-muted-foreground" />
                        <span className="truncate">{tn.name}</span>
                        <Badge variant="outline" className="ml-1 text-xs capitalize">{tn.plan}</Badge>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <div className="hidden sm:block text-xs text-muted-foreground ml-auto">
              {t("doc-super-admin-hint")}
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="w-fit">
          <TabsTrigger value="memorandum-frame">
            <Lock className="size-3.5 mr-1" /> {t("memo-tab")}
          </TabsTrigger>
          <TabsTrigger value="letterheads">
            <Building2 className="size-3.5 mr-1" /> {t("doc-tab-letterheads")}
          </TabsTrigger>
          <TabsTrigger value="seals">
            <Stamp className="size-3.5 mr-1" /> {t("doc-tab-zigled")}
          </TabsTrigger>
          <TabsTrigger value="templates">
            <LayoutTemplate className="size-3.5 mr-1" /> {t("doc-tab-templates")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="memorandum-frame" className="mt-6">
          <MemorandumStudio />
        </TabsContent>
        <TabsContent value="letterheads" className="mt-6">
          <LetterheadsTab tenantQuery={tenantQuery} />
        </TabsContent>
        <TabsContent value="seals" className="mt-6">
          <SealsTab tenantQuery={tenantQuery} />
        </TabsContent>
        <TabsContent value="templates" className="mt-6">
          <TemplatesTab tenantQuery={tenantQuery} onOpenMemorandumStudio={() => setActiveTab("memorandum-frame")} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ============================================================
// Tab 1: Letterheads (Memorandum firme)
// ============================================================

function LetterheadsTab({ tenantQuery }: { tenantQuery: string }) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();
  // Super-admins must explicitly pick a tenant before we can list letterheads
  // (the backend requires ?tenant_id= for super-admin — otherwise it returns
  // 400, which previously surfaced as an empty result + console error).
  const isSuperAdminUser = isSuperAdmin(useAppStore((s) => s.user));
  const queryEnabled = !!tenantQuery || !isSuperAdminUser;

  const qc = useQueryClient();
  const [editing, setEditing] = useState<TenantLetterhead | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState<TenantLetterhead | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["letterheads", tenantKey, tenantQuery],
    queryFn: async () => {
      const r = await fetch(api(`/api/letterheads${tenantQuery}`));
      if (!r.ok) throw new Error("Failed to load letterheads");
      return r.json() as Promise<{ items: TenantLetterhead[] }>;
    },
    enabled: queryEnabled,
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(api(`/api/letterheads/${id}`), { method: "DELETE" });
      if (!r.ok) throw new Error("Delete failed");
    },
    onSuccess: () => {
      toast.success(t("doc-letterhead-deleted-toast"));
      qc.invalidateQueries({ queryKey: ["letterheads", tenantKey, tenantQuery] });
      setDeleteId(null);
    },
    onError: () => toast.error(t("doc-delete-failed-toast")),
  });

  const duplicateMut = useMutation({
    mutationFn: async (l: TenantLetterhead) => {
      const { id, tenant_id, created_by, created_at, updated_at, ...rest } = l;
      const copy = { ...rest, name: l.name + " (copy)", is_default: false };
      const r = await fetch(api(`/api/letterheads${tenantQuery}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(copy),
      });
      if (!r.ok) throw new Error("Duplicate failed");
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("doc-letterhead-duplicated-toast"));
      qc.invalidateQueries({ queryKey: ["letterheads", tenantKey, tenantQuery] });
      setDuplicating(null);
    },
    onError: () => toast.error(t("doc-duplicate-failed-toast")),
  });

  const items = data?.items || [];

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">{t("doc-memorandum-firme")}</h2>
          <p className="text-sm text-muted-foreground">
            {items.length} {t(items.length === 1 ? "doc-letterhead-singular" : "doc-letterhead-plural")} {t("doc-configured-suffix")}
          </p>
        </div>
        <Button onClick={() => { setEditing(null); setShowForm(true); }}>
          <Plus className="size-4 mr-1" /> {t("doc-new-letterhead")}
        </Button>
      </div>

      {isError ? (
        <QueryError onRetry={() => refetch()} />
      ) : isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-44 w-full rounded-xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Building2 className="size-6" />}
          title={t("doc-no-letterheads")}
          description={t("doc-create-first-letterhead")}
          action={
            <Button onClick={() => { setEditing(null); setShowForm(true); }}>
              <Plus className="size-4 mr-1" /> {t("doc-new-letterhead")}
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((l) => (
            <Card key={l.id} className="border-border/60 shadow-soft hover:shadow-soft-md transition-shadow duration-200 flex flex-col">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-base truncate">{l.name}</CardTitle>
                      {l.is_default && (
                        <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30">
                          <Star className="size-3 fill-amber-400 text-amber-500" /> {t("doc-default-badge")}
                        </Badge>
                      )}
                    </div>
                    <CardDescription className="mt-1 text-xs">
                      {l.company_name || "—"} · {l.company_city || "—"} · {l.company_country || "—"}
                    </CardDescription>
                  </div>
                  <div
                    className="size-9 rounded-lg border border-border/60 flex items-center justify-center shrink-0"
                    style={{ backgroundColor: l.primary_color + "15" }}
                  >
                    <div className="size-3 rounded-full" style={{ backgroundColor: l.primary_color }} />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col justify-end gap-3">
                <div className="text-xs text-muted-foreground">
                  {t("doc-updated-label")} <span className="tabular">{fmtDate(l.updated_at)}</span>
                </div>
                <Separator />
                <div className="flex items-center gap-1 flex-wrap">
                  <Button size="sm" variant="ghost" className="h-8" onClick={() => { setEditing(l); setShowForm(true); }} title={t("edit")}>
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" className="h-8" onClick={() => setDuplicating(l)} title={t("doc-duplicate-action")}>
                    <Copy className="size-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" className="h-8 text-destructive" onClick={() => setDeleteId(l.id)} title={t("delete")}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <LetterheadEditorDialog
        open={showForm}
        onOpenChange={setShowForm}
        letterhead={editing}
        tenantQuery={tenantQuery}
        onSaved={() => {
          setShowForm(false);
          qc.invalidateQueries({ queryKey: ["letterheads", tenantKey, tenantQuery] });
        }}
      />

      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("doc-delete-letterhead-title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("doc-delete-letterhead-desc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteId && deleteMut.mutate(deleteId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!duplicating} onOpenChange={(o) => !o && setDuplicating(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("doc-duplicate-letterhead-title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("doc-duplicate-letterhead-desc-prefix")} <span className="font-medium">{duplicating?.name}</span> {t("doc-duplicate-letterhead-desc-suffix")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => duplicating && duplicateMut.mutate(duplicating)}>
              {t("doc-duplicate-action")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ============================================================
// Tab 2: Seals (Zigled)
// ============================================================

function SealsTab({ tenantQuery }: { tenantQuery: string }) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();
  // Super-admins must explicitly pick a tenant before we can list seals
  // (same reason as LetterheadsTab — backend requires ?tenant_id=).
  const isSuperAdminUser = isSuperAdmin(useAppStore((s) => s.user));
  const queryEnabled = !!tenantQuery || !isSuperAdminUser;

  const qc = useQueryClient();
  const [editing, setEditing] = useState<TenantSeal | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState<TenantSeal | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["seals", tenantKey, tenantQuery],
    queryFn: async () => {
      const r = await fetch(api(`/api/seals${tenantQuery}`));
      if (!r.ok) throw new Error("Failed to load seals");
      return r.json() as Promise<{ items: TenantSeal[] }>;
    },
    enabled: queryEnabled,
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(api(`/api/seals/${id}`), { method: "DELETE" });
      if (!r.ok) throw new Error("Delete failed");
    },
    onSuccess: () => {
      toast.success(t("doc-seal-deleted-toast"));
      qc.invalidateQueries({ queryKey: ["seals", tenantKey, tenantQuery] });
      setDeleteId(null);
    },
    onError: () => toast.error(t("doc-delete-failed-toast")),
  });

  const duplicateMut = useMutation({
    mutationFn: async (s: TenantSeal) => {
      const { id, tenant_id, created_by, created_at, updated_at, ...rest } = s;
      const copy = { ...rest, name: s.name + " (copy)", is_default: false };
      const r = await fetch(api(`/api/seals${tenantQuery}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(copy),
      });
      if (!r.ok) throw new Error("Duplicate failed");
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("doc-seal-duplicated-toast"));
      qc.invalidateQueries({ queryKey: ["seals", tenantKey, tenantQuery] });
      setDuplicating(null);
    },
    onError: () => toast.error(t("doc-duplicate-failed-toast")),
  });

  const items = data?.items || [];

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">{t("doc-seals-title")}</h2>
          <p className="text-sm text-muted-foreground">
            {items.length} {t(items.length === 1 ? "doc-seal-singular" : "doc-seal-plural")} {t("doc-configured-suffix")}
          </p>
        </div>
        <Button onClick={() => { setEditing(null); setShowForm(true); }}>
          <Plus className="size-4 mr-1" /> {t("doc-new-seal")}
        </Button>
      </div>

      {isError ? (
        <QueryError onRetry={() => refetch()} />
      ) : isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-44 w-full rounded-xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Stamp className="size-6" />}
          title={t("doc-no-seals")}
          description={t("doc-create-first-seal")}
          action={
            <Button onClick={() => { setEditing(null); setShowForm(true); }}>
              <Plus className="size-4 mr-1" /> {t("doc-new-seal")}
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((s) => {
            const appliesTo = parseApplyToTypes(s.apply_to_types);
            return (
              <Card key={s.id} className="border-border/60 shadow-soft hover:shadow-soft-md transition-shadow duration-200 flex flex-col">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <CardTitle className="text-base truncate">{s.name}</CardTitle>
                        {s.is_default && (
                          <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30">
                            <Star className="size-3 fill-amber-400 text-amber-500" /> {t("doc-default-badge")}
                          </Badge>
                        )}
                      </div>
                      <CardDescription className="mt-1 text-xs capitalize">
                        {s.position.replace(/-/g, " ")} · {s.image_width_mm}×{s.image_height_mm}mm
                      </CardDescription>
                    </div>
                    <div className="size-12 rounded-lg border border-border/60 bg-card flex items-center justify-center shrink-0 overflow-hidden">
                      {s.image_url ? (
                        <img src={s.image_url} alt={s.name} className="size-full object-contain" />
                      ) : (
                        <Stamp className="size-5 text-muted-foreground" />
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="flex-1 flex flex-col justify-end gap-3">
                  {appliesTo.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {appliesTo.map((tp) => (
                        <Badge key={tp} variant="outline" className="text-xs capitalize">{t(TYPE_LABEL_KEYS[tp as TemplateType] || tp)}</Badge>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground">{t("doc-applies-to-all-types")}</div>
                  )}
                  <div className="text-xs text-muted-foreground">
                    {t("doc-updated-label")} <span className="tabular">{fmtDate(s.updated_at)}</span>
                  </div>
                  <Separator />
                  <div className="flex items-center gap-1 flex-wrap">
                    <Button size="sm" variant="ghost" className="h-8" onClick={() => { setEditing(s); setShowForm(true); }} title={t("edit")}>
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-8" onClick={() => setDuplicating(s)} title={t("doc-duplicate-action")}>
                      <Copy className="size-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-8 text-destructive" onClick={() => setDeleteId(s.id)} title={t("delete")}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <SealEditorDialog
        open={showForm}
        onOpenChange={setShowForm}
        seal={editing}
        tenantQuery={tenantQuery}
        onSaved={() => {
          setShowForm(false);
          qc.invalidateQueries({ queryKey: ["seals", tenantKey, tenantQuery] });
        }}
      />

      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("doc-delete-seal-title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("doc-delete-seal-desc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteId && deleteMut.mutate(deleteId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!duplicating} onOpenChange={(o) => !o && setDuplicating(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("doc-duplicate-seal-title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("doc-duplicate-seal-desc-prefix")} <span className="font-medium">{duplicating?.name}</span> {t("doc-duplicate-seal-desc-suffix")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => duplicating && duplicateMut.mutate(duplicating)}>
              {t("doc-duplicate-action")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ============================================================
// Tab 3: Templates (Offers / Invoices / Proformas / etc.)
// ============================================================

/**
 * "New Template" dropdown button — exposes a blank template option plus
 * the three professional starter templates (offer / invoice / proforma).
 * Used in both the page header and the empty-state CTA so users always
 * have the same starter-picker available.
 */
function NewTemplateDropdown({
  onBlank,
  onStarter,
}: {
  onBlank: () => void;
  onStarter: (starter: StarterTemplate) => void;
}) {
  const t = useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>
          <Plus className="size-4 mr-1" /> {t("doc-new-template")}
          <ChevronDown className="size-4 ml-1" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem onClick={onBlank}>
          <FileText className="size-4 mr-2" />
          <span>{t("doc-blank-template")}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t("doc-start-from-starter")}
        </DropdownMenuLabel>
        {STARTER_TEMPLATES.map((starter) => (
          <DropdownMenuItem
            key={starter.type}
            onClick={() => onStarter(starter)}
            className="items-start py-2"
          >
            <LayoutTemplate className="size-4 mr-2 mt-0.5 shrink-0" />
            <div className="flex flex-col gap-0.5">
              <span className="font-medium leading-tight">{starter.name}</span>
              <span className="text-xs text-muted-foreground leading-snug">
                {starter.description}
              </span>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TemplatesTab({ tenantQuery, onOpenMemorandumStudio }: { tenantQuery: string; onOpenMemorandumStudio: () => void }) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();
  // Super-admins must explicitly pick a tenant before we can list templates
  // (same reason as LetterheadsTab — backend requires ?tenant_id= for the
  // templates/letterheads/seals list endpoints).
  const isSuperAdminUser = isSuperAdmin(useAppStore((s) => s.user));
  const queryEnabled = !!tenantQuery || !isSuperAdminUser;

  const qc = useQueryClient();
  const [editing, setEditing] = useState<DocumentTemplate | null>(null);
  // `draft` holds the initial form values for a brand-new template that
  // was created from a starter (e.g. "Professional Offer Template"). When
  // set, the editor dialog seeds the form from `draft` instead of the
  // built-in `defaultTemplate()`. Cleared on dialog close.
  const [draft, setDraft] = useState<TemplateFormState | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState<DocumentTemplate | null>(null);

  // Open the editor with a blank form (uses defaultTemplate()).
  function handleNewBlank() {
    setEditing(null);
    setDraft(null);
    setShowForm(true);
  }

  // Open the editor pre-filled with a starter template's settings.
  // `starter.template` is a `Partial<DocumentTemplate>` containing every
  // TemplateFormState field, so a cast is safe here.
  function handleNewFromStarter(starter: StarterTemplate) {
    setEditing(null);
    setDraft(starter.template as TemplateFormState);
    setShowForm(true);
  }

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["document-templates", tenantKey, tenantQuery],
    queryFn: async () => {
      const r = await fetch(api(`/api/document-templates${tenantQuery}`));
      if (!r.ok) throw new Error("Failed to load templates");
      return r.json() as Promise<{ items: DocumentTemplate[] }>;
    },
    enabled: queryEnabled,
  });

  // Load letterheads + seals so we can show their names on the cards
  const letterheadsQ = useQuery({
    queryKey: ["letterheads", tenantKey, tenantQuery],
    queryFn: async () => {
      const r = await fetch(api(`/api/letterheads${tenantQuery}`));
      if (!r.ok) throw new Error("Failed to load letterheads");
      return r.json() as Promise<{ items: TenantLetterhead[] }>;
    },
    enabled: queryEnabled,
  });
  const sealsQ = useQuery({
    queryKey: ["seals", tenantKey, tenantQuery],
    queryFn: async () => {
      const r = await fetch(api(`/api/seals${tenantQuery}`));
      if (!r.ok) throw new Error("Failed to load seals");
      return r.json() as Promise<{ items: TenantSeal[] }>;
    },
    enabled: queryEnabled,
  });

  // audit33: the memorandum settings (the LOCKED frame) — fetched so the
  // editor's Memorandum tab and the draft preview render the real frame.
  const memoQ = useQuery({
    queryKey: ["memorandum-settings", tenantKey, tenantQuery],
    queryFn: async () => {
      const r = await fetch(api(`/api/memorandum-settings${tenantQuery}`));
      if (!r.ok) throw new Error("Failed to load memorandum settings");
      return r.json() as Promise<MemorandumSettings | null>;
    },
    enabled: queryEnabled,
  });
  const memoSettings = memoQ.data ?? null;

  // Fetch the active tenant so we can read its bank_accounts array — needed by
  // the BankAccountSelector in the template editor.
  //   • Regular admin: GET /api/tenants returns only their own tenant.
  //   • Super-admin: returns ALL tenants, and we filter by ?tenant_id= in
  //     `tenantQuery` (set by the tenant switcher above).
  const tenantsQ = useQuery<{ items: Tenant[] }>({
    queryKey: ["tenants", tenantKey, "for-templates", tenantQuery],
    queryFn: async () => {
      const r = await fetch(api("/api/tenants"));
      if (!r.ok) throw new Error("Failed to load tenants");
      return r.json();
    },
    enabled: queryEnabled,
  });
  const activeTenantId = tenantQuery.startsWith("?tenant_id=")
    ? decodeURIComponent(tenantQuery.slice("?tenant_id=".length))
    : null;
  const tenant = (tenantsQ.data?.items ?? []).find((t) =>
    activeTenantId ? t.id === activeTenantId : true,
  ) ?? null;

  const letterheads = letterheadsQ.data?.items ?? [];
  const seals = sealsQ.data?.items ?? [];

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(api(`/api/document-templates/${id}`), { method: "DELETE" });
      if (!r.ok) throw new Error("Delete failed");
    },
    onSuccess: () => {
      toast.success(t("doc-template-deleted-toast"));
      qc.invalidateQueries({ queryKey: ["document-templates", tenantKey, tenantQuery] });
      setDeleteId(null);
    },
    onError: () => toast.error(t("doc-delete-failed-toast")),
  });

  const setDefaultMut = useMutation({
    mutationFn: async (tpl: DocumentTemplate) => {
      const r = await fetch(api(`/api/document-templates/${tpl.id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...tpl, is_default: true }),
      });
      if (!r.ok) throw new Error("Update failed");
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("doc-default-template-updated-toast"));
      qc.invalidateQueries({ queryKey: ["document-templates", tenantKey, tenantQuery] });
    },
    onError: () => toast.error(t("doc-failed-set-default-toast")),
  });

  const duplicateMut = useMutation({
    mutationFn: async (tpl: DocumentTemplate) => {
      const { id, tenant_id, created_by, created_at, updated_at, letterhead, seal, ...rest } = tpl;
      const copy = { ...rest, name: tpl.name + " (copy)", is_default: false };
      const r = await fetch(api(`/api/document-templates${tenantQuery}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(copy),
      });
      if (!r.ok) throw new Error("Duplicate failed");
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("doc-template-duplicated-toast"));
      qc.invalidateQueries({ queryKey: ["document-templates", tenantKey, tenantQuery] });
      setDuplicating(null);
    },
    onError: () => toast.error(t("doc-duplicate-failed-toast")),
  });

  const items = data?.items || [];

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">{t("doc-document-templates-title")}</h2>
          <p className="text-sm text-muted-foreground">
            {items.length} {t(items.length === 1 ? "doc-template-singular" : "doc-template-plural")} {t("doc-configured-suffix")}
          </p>
        </div>
        <NewTemplateDropdown onBlank={handleNewBlank} onStarter={handleNewFromStarter} />
      </div>

      {isError ? (
        <QueryError onRetry={() => refetch()} />
      ) : isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-44 w-full rounded-xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<FileText className="size-6" />}
          title={t("doc-no-templates")}
          description={t("doc-create-first-template")}
          action={
            <NewTemplateDropdown onBlank={handleNewBlank} onStarter={handleNewFromStarter} />
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((tpl) => {
            const linkedLetterhead = tpl.letterhead || letterheads.find((l) => l.id === tpl.letterhead_id);
            const linkedSeal = tpl.seal || seals.find((s) => s.id === tpl.seal_id);
            return (
              <Card key={tpl.id} className="border-border/60 shadow-soft hover:shadow-soft-md transition-shadow duration-200 flex flex-col">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <CardTitle className="text-base truncate">{tpl.name}</CardTitle>
                        {tpl.is_default && (
                          <Star className="size-4 fill-amber-400 text-amber-500 shrink-0" />
                        )}
                      </div>
                      <CardDescription className="mt-1 flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className={TYPE_BADGE[tpl.type]}>{t(TYPE_LABEL_KEYS[tpl.type])}</Badge>
                        <span className="text-xs">{tpl.page_size}</span>
                      </CardDescription>
                    </div>
                    <div
                      className="size-9 rounded-lg border border-border/60 flex items-center justify-center shrink-0"
                      style={{ backgroundColor: tpl.primary_color + "15" }}
                    >
                      <div className="size-3 rounded-full" style={{ backgroundColor: tpl.primary_color }} />
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="flex-1 flex flex-col justify-end gap-2">
                  <div className="text-xs text-muted-foreground space-y-1">
                    {linkedLetterhead ? (
                      <div className="flex items-center gap-1.5">
                        <Building2 className="size-3" /> <span className="truncate">{linkedLetterhead.name}</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 italic">
                        <Building2 className="size-3" /> {t("doc-no-letterhead")}
                      </div>
                    )}
                    {linkedSeal && tpl.seal_enabled ? (
                      <div className="flex items-center gap-1.5">
                        <Stamp className="size-3" /> <span className="truncate">{linkedSeal.name}</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 italic">
                        <Stamp className="size-3" /> {t("doc-no-seal")}
                      </div>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t("doc-updated-label")} <span className="tabular">{fmtDate(tpl.updated_at)}</span>
                  </div>
                  <Separator />
                  <div className="flex items-center gap-1 flex-wrap">
                    {!tpl.is_default && (
                      <Button size="sm" variant="outline" className="h-8" onClick={() => setDefaultMut.mutate(tpl)} disabled={setDefaultMut.isPending}>
                        <Star className="size-3.5 mr-1" /> {t("doc-set-default")}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" className="h-8" onClick={() => { setEditing(tpl); setShowForm(true); }} title={t("edit")}>
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-8" onClick={() => setDuplicating(tpl)} title={t("doc-duplicate-action")}>
                      <Copy className="size-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-8 text-destructive" onClick={() => setDeleteId(tpl.id)} title={t("delete")}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <TemplateEditorDialog
        open={showForm}
        onOpenChange={(o) => {
          setShowForm(o);
          if (!o) setDraft(null);
        }}
        template={editing}
        draft={draft}
        tenantQuery={tenantQuery}
        tenant={tenant}
        letterheads={letterheads}
        seals={seals}
        memoSettings={memoSettings}
        onOpenMemorandumStudio={() => {
          setShowForm(false);
          setDraft(null);
          onOpenMemorandumStudio();
        }}
        onSaved={() => {
          setShowForm(false);
          setDraft(null);
          qc.invalidateQueries({ queryKey: ["document-templates", tenantKey, tenantQuery] });
        }}
      />

      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("doc-delete-template-title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("doc-delete-template-desc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteId && deleteMut.mutate(deleteId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!duplicating} onOpenChange={(o) => !o && setDuplicating(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("doc-duplicate-template-title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("doc-duplicate-template-desc-prefix")} <span className="font-medium">{duplicating?.name}</span> {t("doc-duplicate-template-desc-suffix")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => duplicating && duplicateMut.mutate(duplicating)}>
              {t("doc-duplicate-action")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ============================================================
// Letterhead editor with live A4 preview
// ============================================================

function LetterheadEditorDialog({
  open, onOpenChange, letterhead, tenantQuery, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  letterhead: TenantLetterhead | null;
  tenantQuery: string;
  onSaved: () => void;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [form, setForm] = useState<LetterheadFormState>(defaultLetterhead());
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
// eslint-disable-next-line react-hooks/set-state-in-effect
      setForm(letterhead ? { ...letterhead } : defaultLetterhead());
    }
  }, [open, letterhead]);

  function set<K extends keyof LetterheadFormState>(k: K, v: LetterheadFormState[K]) {
    setForm((p) => ({ ...p, [k]: v }));
  }

  async function handleLogoUpload(file: File) {
    if (file.size > MAX_LOGO_UPLOAD_SIZE) { // AUDIT18: server contract is 2MB (lib/upload/constants); a local 1.5MB constant made valid uploads fail client-side
      toast.error(t("doc-logo-too-large-toast"));
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      set("logo_url", dataUrl);
      toast.success(t("doc-logo-uploaded-toast"));
    } catch {
      toast.error(t("doc-failed-read-image-toast"));
    }
  }

  async function handleSave() {
    if (!form.name?.trim()) {
      toast.error(t("doc-letterhead-name-required-toast"));
      return;
    }
    setSaving(true);
    try {
      const method = letterhead ? "PUT" : "POST";
      const url = letterhead ? api(`/api/letterheads/${letterhead.id}`) : api(`/api/letterheads${tenantQuery}`);
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error("Save failed");
      toast.success(letterhead ? t("doc-letterhead-updated-toast") : t("doc-letterhead-created-toast"));
      onSaved();
    } catch {
      toast.error(t("doc-failed-save-letterhead-toast"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="full" className="p-0 gap-0">
        <DialogHeader className="px-5 py-4 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="size-5 text-primary" />
            {letterhead ? t("doc-edit-letterhead-title") : t("doc-new-letterhead-title")}
          </DialogTitle>
          <DialogDescription>
            {t("doc-letterhead-editor-desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 min-h-0">
          {/* Left: form */}
          <div className="border-r border-border/60 min-h-0 flex flex-col">
            <div className="custom-scroll flex-1 overflow-y-auto">
              <div className="p-5">
                <Accordion type="multiple" defaultValue={["basics", "logo", "colors"]} className="w-full">
                  <AccordionItem value="basics">
                    <AccordionTrigger><SectionLabel icon={FileText} label={t("doc-section-basics-identity")} /></AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-3">
                        <Field label={t("doc-letterhead-name")}>
                          <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder={t("doc-letterhead-name-placeholder")} />
                        </Field>
                        <div className="grid grid-cols-2 gap-3">
                          <Field label={t("doc-company-name")}><Input value={form.company_name ?? ""} onChange={(e) => set("company_name", e.target.value)} /></Field>
                          <Field label={t("doc-legal-name")}><Input value={form.company_legal_name ?? ""} onChange={(e) => set("company_legal_name", e.target.value)} /></Field>
                        </div>
                        <Field label={t("doc-address-line")}><Input value={form.company_address_line ?? ""} onChange={(e) => set("company_address_line", e.target.value)} /></Field>
                        <div className="grid grid-cols-3 gap-3">
                          <Field label={t("doc-city")}><Input value={form.company_city ?? ""} onChange={(e) => set("company_city", e.target.value)} /></Field>
                          <Field label={t("doc-postal-code")}><Input value={form.company_postal_code ?? ""} onChange={(e) => set("company_postal_code", e.target.value)} /></Field>
                          <Field label={t("doc-country")}><Input value={form.company_country ?? ""} onChange={(e) => set("company_country", e.target.value)} placeholder="RS" /></Field>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <Field label={t("email")}><Input value={form.company_email ?? ""} onChange={(e) => set("company_email", e.target.value)} /></Field>
                          <Field label={t("doc-phone")}><Input value={form.company_phone ?? ""} onChange={(e) => set("company_phone", e.target.value)} /></Field>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <Field label={t("doc-website")}><Input value={form.company_website ?? ""} onChange={(e) => set("company_website", e.target.value)} /></Field>
                          <Field label={t("doc-vat-number")}><Input value={form.company_vat_number ?? ""} onChange={(e) => set("company_vat_number", e.target.value)} /></Field>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <Field label={t("doc-tax-id")}><Input value={form.company_tax_id ?? ""} onChange={(e) => set("company_tax_id", e.target.value)} /></Field>
                          <Field label={t("doc-registration-num")}><Input value={form.company_registration_number ?? ""} onChange={(e) => set("company_registration_number", e.target.value)} /></Field>
                        </div>
                        <Field label={t("doc-default-letterhead")}>
                          <div className="flex items-center gap-2">
                            <Switch checked={form.is_default} onCheckedChange={(v) => set("is_default", v)} aria-label={t("doc-default-letterhead")} />
                            <span className="text-sm text-muted-foreground">{t("doc-use-default-for-tenant")}</span>
                          </div>
                        </Field>
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="bank">
                    <AccordionTrigger><SectionLabel icon={Layers} label={t("doc-section-bank-details")} /></AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                          <Field label={t("doc-bank-name")}><Input value={form.bank_name ?? ""} onChange={(e) => set("bank_name", e.target.value)} /></Field>
                          <Field label={t("doc-account-holder")}><Input value={form.bank_account_holder ?? ""} onChange={(e) => set("bank_account_holder", e.target.value)} /></Field>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <Field label={t("doc-iban")}><Input value={form.bank_iban ?? ""} onChange={(e) => set("bank_iban", e.target.value)} className="font-mono text-xs" /></Field>
                          <Field label={t("doc-swift-bic")}><Input value={form.bank_swift ?? ""} onChange={(e) => set("bank_swift", e.target.value)} className="font-mono text-xs" /></Field>
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="logo">
                    <AccordionTrigger><SectionLabel icon={ImageIcon} label={t("doc-section-logo")} /></AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-3">
                        <Field label={t("doc-logo-image")}>
                          <div className="flex items-center gap-3">
                            <div className="size-16 rounded-lg border border-border/60 bg-card flex items-center justify-center overflow-hidden shrink-0">
                              {form.logo_url ? (
                                <img src={form.logo_url} alt="Logo" className="size-full object-contain" />
                              ) : (
                                <ImageIcon className="size-5 text-muted-foreground" />
                              )}
                            </div>
                            <input
                              ref={fileInputRef}
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) handleLogoUpload(f);
                                e.target.value = "";
                              }}
                            />
                            <div className="flex flex-col gap-1">
                              <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                                <Upload className="size-3.5 mr-1" /> {t("upload")}
                              </Button>
                              {form.logo_url && (
                                <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => set("logo_url", null)}>
                                  <X className="size-3.5 mr-1" /> {t("remove")}
                                </Button>
                              )}
                            </div>
                          </div>
                        </Field>
                        <Field label={t("doc-logo-position")}>
                          <Select value={form.logo_position} onValueChange={(v) => set("logo_position", v as "left" | "center" | "right")}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="left">{t("doc-pos-left")}</SelectItem>
                              <SelectItem value="center">{t("doc-pos-center")}</SelectItem>
                              <SelectItem value="right">{t("doc-pos-right")}</SelectItem>
                            </SelectContent>
                          </Select>
                        </Field>
                        <div className="grid grid-cols-2 gap-3">
                          <Field label={t("doc-width-mm")}><NumberInput value={form.logo_width_mm} onChange={(v) => set("logo_width_mm", v)} min={5} max={150} /></Field>
                          <Field label={t("doc-height-mm")}><NumberInput value={form.logo_height_mm} onChange={(v) => set("logo_height_mm", v)} min={5} max={80} /></Field>
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="colors">
                    <AccordionTrigger><SectionLabel icon={Palette} label={t("doc-section-branding-colors")} /></AccordionTrigger>
                    <AccordionContent>
                      <div className="grid grid-cols-2 gap-3">
                        <ColorField label={t("doc-primary-color")} value={form.primary_color} onChange={(v) => set("primary_color", v)} />
                        <ColorField label={t("doc-accent-color")} value={form.accent_color} onChange={(v) => set("accent_color", v)} />
                        <ColorField label={t("doc-body-text-color")} value={form.text_color} onChange={(v) => set("text_color", v)} />
                        <ColorField label={t("doc-muted-text-color")} value={form.muted_text_color} onChange={(v) => set("muted_text_color", v)} />
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="page">
                    <AccordionTrigger><SectionLabel icon={LayoutTemplate} label={t("doc-section-page-layout")} /></AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-3">
                        <Field label={t("doc-page-size")}>
                          <Select value={form.page_size} onValueChange={(v) => set("page_size", v as "A4" | "Letter")}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="A4">{t("doc-page-size-a4")}</SelectItem>
                              <SelectItem value="Letter">{t("doc-page-size-letter")}</SelectItem>
                            </SelectContent>
                          </Select>
                        </Field>
                        <Field label={t("doc-margins-mm")}>
                          <div className="grid grid-cols-4 gap-2">
                            <MarginInput label={t("doc-margin-top")} value={form.margin_top_mm} onChange={(v) => set("margin_top_mm", v)} />
                            <MarginInput label={t("doc-margin-bottom")} value={form.margin_bottom_mm} onChange={(v) => set("margin_bottom_mm", v)} />
                            <MarginInput label={t("doc-margin-left")} value={form.margin_left_mm} onChange={(v) => set("margin_left_mm", v)} />
                            <MarginInput label={t("doc-margin-right")} value={form.margin_right_mm} onChange={(v) => set("margin_right_mm", v)} />
                          </div>
                        </Field>
                        <div className="grid grid-cols-2 gap-3">
                          <Field label={t("doc-header-height-mm")}><NumberInput value={form.header_height_mm} onChange={(v) => set("header_height_mm", v)} min={5} max={80} /></Field>
                          <Field label={t("doc-footer-height-mm")}><NumberInput value={form.footer_height_mm} onChange={(v) => set("footer_height_mm", v)} min={5} max={60} /></Field>
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="header">
                    <AccordionTrigger><SectionLabel icon={AlignCenter} label={t("doc-section-header-layout")} /></AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-3">
                        <Field label={t("doc-section-header-layout")}>
                          <Select value={form.header_layout} onValueChange={(v) => set("header_layout", v)}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {HEADER_LAYOUTS.map((h) => (
                                <SelectItem key={h.value} value={h.value}>{t(h.label)}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </Field>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                          <ToggleField label={t("doc-toggle-logo")} checked={form.header_show_logo} onChange={(v) => set("header_show_logo", v)} />
                          <ToggleField label={t("doc-toggle-name")} checked={form.header_show_company_name} onChange={(v) => set("header_show_company_name", v)} />
                          <ToggleField label={t("doc-toggle-contact")} checked={form.header_show_contact} onChange={(v) => set("header_show_contact", v)} />
                          <ToggleField label={t("doc-toggle-vat")} checked={form.header_show_vat} onChange={(v) => set("header_show_vat", v)} />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <Field label={t("doc-divider")}>
                            <div className="flex items-center gap-2">
                              <Switch checked={form.header_divider} onCheckedChange={(v) => set("header_divider", v)} aria-label={t("doc-divider")} />
                              <span className="text-sm text-muted-foreground">{t("doc-show-below-header")}</span>
                            </div>
                          </Field>
                          {form.header_divider && (
                            <ColorField label={t("doc-divider-color")} value={form.header_divider_color} onChange={(v) => set("header_divider_color", v)} />
                          )}
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="footer">
                    <AccordionTrigger><SectionLabel icon={AlignJustify} label={t("doc-section-footer-layout")} /></AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-3">
                        <Field label={t("doc-section-footer-layout")}>
                          <Select value={form.footer_layout} onValueChange={(v) => set("footer_layout", v)}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {FOOTER_LAYOUTS.map((f) => (
                                <SelectItem key={f.value} value={f.value}>{t(f.label)}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </Field>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                          <ToggleField label={t("doc-toggle-bank")} checked={form.footer_show_bank_details} onChange={(v) => set("footer_show_bank_details", v)} />
                          <ToggleField label={t("doc-toggle-contact")} checked={form.footer_show_contact} onChange={(v) => set("footer_show_contact", v)} />
                          <ToggleField label={t("doc-toggle-tax-id")} checked={form.footer_show_tax_id} onChange={(v) => set("footer_show_tax_id", v)} />
                          <ToggleField label={t("doc-toggle-page-num")} checked={form.footer_show_page_number} onChange={(v) => set("footer_show_page_number", v)} />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <Field label={t("doc-divider")}>
                            <div className="flex items-center gap-2">
                              <Switch checked={form.footer_divider} onCheckedChange={(v) => set("footer_divider", v)} aria-label={t("doc-divider")} />
                              <span className="text-sm text-muted-foreground">{t("doc-show-above-footer")}</span>
                            </div>
                          </Field>
                          {form.footer_divider && (
                            <ColorField label={t("doc-divider-color")} value={form.footer_divider_color} onChange={(v) => set("footer_divider_color", v)} />
                          )}
                        </div>
                        <Field label={t("doc-footer-custom-text")}>
                          <Input value={form.footer_text ?? ""} onChange={(e) => set("footer_text", e.target.value)} placeholder={t("doc-footer-text-placeholder")} />
                        </Field>
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="watermark">
                    <AccordionTrigger><SectionLabel icon={Waves} label={t("doc-section-watermark")} /></AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-3">
                        <Field label={t("doc-enabled")}>
                          <div className="flex items-center gap-2">
                            <Switch checked={form.watermark_enabled} onCheckedChange={(v) => set("watermark_enabled", v)} aria-label={t("doc-enabled")} />
                            <span className="text-sm text-muted-foreground">{t("doc-watermark-overlay-desc")}</span>
                          </div>
                        </Field>
                        {form.watermark_enabled && (
                          <>
                            <Field label={t("doc-watermark-text")}><Input value={form.watermark_text ?? ""} onChange={(e) => set("watermark_text", e.target.value)} placeholder="DRAFT" /></Field>
                            <div className="grid grid-cols-2 gap-3">
                              <ColorField label={t("doc-color")} value={form.watermark_color} onChange={(v) => set("watermark_color", v)} />
                              <Field label={t("doc-opacity-pct").replace("{n}", String(Math.round(form.watermark_opacity * 100)))}>
                                <Slider
                                  value={[form.watermark_opacity]}
                                  min={0.02} max={0.5} step={0.02}
                                  onValueChange={(v) => set("watermark_opacity", v[0])}
                                />
                              </Field>
                            </div>
                            <Field label={t("doc-rotation-deg").replace("{n}", String(form.watermark_rotation))}>
                              <Slider
                                value={[form.watermark_rotation]}
                                min={-180} max={180} step={1}
                                onValueChange={(v) => set("watermark_rotation", v[0])}
                              />
                            </Field>
                          </>
                        )}
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="typography">
                    <AccordionTrigger><SectionLabel icon={Type} label={t("doc-section-typography")} /></AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-3">
                        <Field label={t("doc-body-font-family")}><Input value={form.body_font_family} onChange={(e) => set("body_font_family", e.target.value)} className="font-mono text-xs" /></Field>
                        <div className="grid grid-cols-2 gap-3">
                          <Field label={t("doc-body-size-pt")}><NumberInput value={form.body_font_size_pt} onChange={(v) => set("body_font_size_pt", v)} min={7} max={24} /></Field>
                          <Field label={t("doc-heading-size-pt")}><NumberInput value={form.heading_font_size_pt} onChange={(v) => set("heading_font_size_pt", v)} min={10} max={48} /></Field>
                        </div>
                        <Field label={t("doc-heading-font-family")}><Input value={form.heading_font_family} onChange={(e) => set("heading_font_family", e.target.value)} className="font-mono text-xs" /></Field>
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </div>
            </div>
          </div>

          {/* Right: live A4 preview */}
          <div className="bg-muted/30 min-h-0 flex flex-col">
            <div className="px-5 py-3 border-b border-border/60 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Eye className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">{t("doc-live-preview")}</span>
              </div>
              <Badge variant="outline" className="text-xs">{form.page_size}</Badge>
            </div>
            <div className="custom-scroll flex-1 overflow-y-auto">
              <div className="p-6 flex justify-center">
                <LetterheadPreview form={form} />
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="px-5 py-4 border-t border-border/60 bg-card">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button onClick={handleSave} disabled={saving}>
            <Save className="size-4 mr-1" /> {t("doc-save-letterhead")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// Letterhead live preview — scaled A4
// ============================================================

function LetterheadPreview({ form }: { form: LetterheadFormState }) {
  const pageWidthPx = 480;
  const pageHeightPx = Math.round(pageWidthPx * 1.414);
  const mmToPx = (mm: number) => (mm / 210) * pageWidthPx;

  // Header layout helpers
  const isLogoLeft = form.header_layout === "logo-left-info-right" || form.header_layout === "two-column";
  const isLogoRight = form.header_layout === "logo-right-info-left";
  const isLogoCenter = form.header_layout === "logo-center";
  const isTextOnly = form.header_layout === "text-only";

  const Logo = (
    <div style={{ width: mmToPx(form.logo_width_mm), height: mmToPx(form.logo_height_mm) }} className="flex items-center justify-center shrink-0 overflow-hidden">
      {form.logo_url ? (
        <img src={form.logo_url} alt="Logo" className="max-w-full max-h-full object-contain" />
      ) : (
        <div
          className="w-full h-full rounded-md flex items-center justify-center text-white"
          style={{ backgroundColor: form.primary_color, fontWeight: 700, fontSize: 14 }}
        >
          {(form.company_name || "C")[0]}
        </div>
      )}
    </div>
  );

  const CompanyInfo = (
    <div className="min-w-0">
      {form.header_show_company_name && (
        <div style={{ color: form.primary_color, fontWeight: 700, fontSize: form.heading_font_size_pt * 0.7 }}>
          {form.company_name || "Your Company"}
        </div>
      )}
      {form.header_show_contact && (
        <div style={{ fontSize: 8, color: form.muted_text_color, lineHeight: 1.4, marginTop: 2 }}>
          {[
            form.company_address_line,
            [form.company_postal_code, form.company_city].filter(Boolean).join(" "),
            form.company_country,
          ].filter(Boolean).join(" · ")}
          <br />
          {[form.company_email, form.company_phone, form.company_website].filter(Boolean).join(" · ")}
          {form.header_show_vat && form.company_vat_number && (
            <><br />VAT: {form.company_vat_number}</>
          )}
        </div>
      )}
    </div>
  );

  const headerContent = isTextOnly ? (
    <div className="w-full text-center">{CompanyInfo}</div>
  ) : isLogoCenter ? (
    <div className="w-full flex flex-col items-center gap-2">
      {form.header_show_logo && Logo}
      {CompanyInfo}
    </div>
  ) : isLogoRight ? (
    <div className="w-full flex items-center justify-between gap-3">
      <div className="flex-1 text-right">{CompanyInfo}</div>
      {form.header_show_logo && Logo}
    </div>
  ) : (
    <div className="w-full flex items-center justify-between gap-3">
      {form.header_show_logo && Logo}
      <div className="flex-1">{CompanyInfo}</div>
    </div>
  );

  return (
    <div
      className="bg-white shadow-soft-lg rounded-sm mx-auto relative overflow-hidden"
      style={{
        width: pageWidthPx,
        height: pageHeightPx,
        fontFamily: form.body_font_family,
        fontSize: form.body_font_size_pt,
        color: form.text_color,
        paddingTop: mmToPx(form.margin_top_mm),
        paddingBottom: mmToPx(form.margin_bottom_mm),
        paddingLeft: mmToPx(form.margin_left_mm),
        paddingRight: mmToPx(form.margin_right_mm),
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <div
        style={{
          minHeight: mmToPx(form.header_height_mm),
          borderBottom: form.header_divider ? `1px solid ${form.header_divider_color}` : "none",
          paddingBottom: 8,
          marginBottom: 14,
        }}
      >
        {headerContent}
      </div>

      {/* Body placeholder */}
      <div className="flex-1 min-h-0 flex flex-col gap-3">
        <div style={{ color: form.muted_text_color, fontSize: 7, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Document body
        </div>
        {[60, 90, 75, 100, 50].map((w, i) => (
          <div key={i} className="rounded-sm" style={{ width: `${w}%`, height: 6, backgroundColor: form.muted_text_color + "30" }} />
        ))}
        <div className="mt-2" style={{ height: 80, backgroundColor: form.accent_color + "10", border: `1px solid ${form.accent_color}30`, borderRadius: 4 }} />
      </div>

      {/* Footer */}
      <div
        style={{
          minHeight: mmToPx(form.footer_height_mm),
          borderTop: form.footer_divider ? `1px solid ${form.footer_divider_color}` : "none",
          paddingTop: 8,
          marginTop: 12,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 8,
          fontSize: 7.5,
          color: form.muted_text_color,
        }}
      >
        <div className="flex-1 space-y-0.5">
          {form.footer_show_bank_details && (form.bank_name || form.bank_iban) && (
            <div>
              <span style={{ color: form.primary_color, fontWeight: 600 }}>Bank:</span>{" "}
              {form.bank_name || "—"} {form.bank_iban && `· IBAN ${form.bank_iban}`} {form.bank_swift && `· SWIFT ${form.bank_swift}`}
            </div>
          )}
          {form.footer_show_contact && form.company_email && (
            <div>
              <span style={{ color: form.primary_color, fontWeight: 600 }}>Contact:</span>{" "}
              {form.company_email} {form.company_phone && `· ${form.company_phone}`}
            </div>
          )}
          {form.footer_show_tax_id && (form.company_vat_number || form.company_tax_id) && (
            <div>
              <span style={{ color: form.primary_color, fontWeight: 600 }}>Tax:</span>{" "}
              {form.company_vat_number ? `VAT ${form.company_vat_number}` : ""}
              {form.company_tax_id && ` · ID ${form.company_tax_id}`}
            </div>
          )}
          {form.footer_text && (
            <div style={{ fontStyle: "italic", marginTop: 4 }}>{form.footer_text}</div>
          )}
        </div>
        {form.footer_show_page_number && (
          <div style={{ textAlign: "right", color: form.accent_color, fontWeight: 600 }}>Page 1</div>
        )}
      </div>

      {/* Watermark */}
      {form.watermark_enabled && form.watermark_text && (
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none"
          style={{
            opacity: form.watermark_opacity,
            transform: `rotate(${form.watermark_rotation}deg)`,
            color: form.watermark_color,
            fontSize: 80,
            fontWeight: 800,
            letterSpacing: 4,
          }}
        >
          {form.watermark_text}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Seal editor with placement preview
// ============================================================

function SealEditorDialog({
  open, onOpenChange, seal, tenantQuery, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  seal: TenantSeal | null;
  tenantQuery: string;
  onSaved: () => void;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [form, setForm] = useState<SealFormState>(defaultSeal());
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
// eslint-disable-next-line react-hooks/set-state-in-effect
      setForm(seal ? { ...seal } : defaultSeal());
    }
  }, [open, seal]);

  function set<K extends keyof SealFormState>(k: K, v: SealFormState[K]) {
    setForm((p) => ({ ...p, [k]: v }));
  }

  async function handleImageUpload(file: File) {
    if (file.size > MAX_LOGO_UPLOAD_SIZE) { // AUDIT18: server contract is 2MB (lib/upload/constants); a local 1.5MB constant made valid uploads fail client-side
      toast.error(t("doc-image-too-large-toast"));
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      const format = file.type.includes("png") ? "png" : file.type.includes("svg") ? "svg" : "jpg";
      set("image_url", dataUrl);
      set("image_format", format as TenantSeal["image_format"]);
      toast.success(t("doc-seal-image-uploaded-toast"));
    } catch {
      toast.error(t("doc-failed-read-image-toast"));
    }
  }

  async function handleSave() {
    if (!form.name?.trim()) {
      toast.error(t("doc-seal-name-required-toast"));
      return;
    }
    if (!form.image_url) {
      toast.error(t("doc-upload-seal-image-toast"));
      return;
    }
    setSaving(true);
    try {
      const method = seal ? "PUT" : "POST";
      const url = seal ? api(`/api/seals/${seal.id}`) : api(`/api/seals${tenantQuery}`);
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error("Save failed");
      toast.success(seal ? t("doc-seal-updated-toast") : t("doc-seal-created-toast"));
      onSaved();
    } catch {
      toast.error(t("doc-failed-save-seal-toast"));
    } finally {
      setSaving(false);
    }
  }

  const applyToTypes = parseApplyToTypes(form.apply_to_types);
  function toggleApplyTo(type: string) {
    const next = applyToTypes.includes(type)
      ? applyToTypes.filter((tp) => tp !== type)
      : [...applyToTypes, type];
    set("apply_to_types", serializeApplyToTypes(next));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="full" className="p-0 gap-0">
        <DialogHeader className="px-5 py-4 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2">
            <Stamp className="size-5 text-primary" />
            {seal ? t("doc-edit-seal-title") : t("doc-new-seal-title")}
          </DialogTitle>
          <DialogDescription>
            {t("doc-seal-editor-desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 min-h-0">
          {/* Left: form */}
          <div className="border-r border-border/60 min-h-0 flex flex-col">
            <div className="custom-scroll flex-1 overflow-y-auto">
              <div className="p-5">
                <Accordion type="multiple" defaultValue={["basics", "image"]} className="w-full">
                  <AccordionItem value="basics">
                    <AccordionTrigger><SectionLabel icon={FileText} label={t("doc-section-basics")} /></AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-3">
                        <Field label={t("doc-seal-name")}>
                          <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder={t("doc-seal-name-placeholder")} />
                        </Field>
                        <Field label={t("doc-default-seal")}>
                          <div className="flex items-center gap-2">
                            <Switch checked={form.is_default} onCheckedChange={(v) => set("is_default", v)} aria-label={t("doc-default-seal")} />
                            <span className="text-sm text-muted-foreground">{t("doc-use-default-seal")}</span>
                          </div>
                        </Field>
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="image">
                    <AccordionTrigger><SectionLabel icon={ImageIcon} label={t("doc-section-seal-image")} /></AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-3">
                        <Field label={t("doc-section-seal-image")}>
                          <div className="flex items-center gap-3">
                            <div className="size-24 rounded-lg border border-border/60 bg-card flex items-center justify-center overflow-hidden shrink-0">
                              {form.image_url ? (
                                <img src={form.image_url} alt="Seal" className="size-full object-contain" />
                              ) : (
                                <Stamp className="size-8 text-muted-foreground" />
                              )}
                            </div>
                            <input
                              ref={fileInputRef}
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) handleImageUpload(f);
                                e.target.value = "";
                              }}
                            />
                            <div className="flex flex-col gap-1">
                              <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                                <Upload className="size-3.5 mr-1" /> {t("upload")}
                              </Button>
                              {form.image_url && (
                                <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => set("image_url", "")}>
                                  <X className="size-3.5 mr-1" /> {t("remove")}
                                </Button>
                              )}
                              <p className="text-xs text-muted-foreground max-w-[180px]">
                                {t("doc-png-transparency-hint")}
                              </p>
                            </div>
                          </div>
                        </Field>
                        <div className="grid grid-cols-2 gap-3">
                          <Field label={t("doc-width-mm")}><NumberInput value={form.image_width_mm} onChange={(v) => set("image_width_mm", v)} min={5} max={120} /></Field>
                          <Field label={t("doc-height-mm")}><NumberInput value={form.image_height_mm} onChange={(v) => set("image_height_mm", v)} min={5} max={120} /></Field>
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="placement">
                    <AccordionTrigger><SectionLabel icon={MapPin} label={t("doc-section-placement")} /></AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-3">
                        <Field label={t("doc-position-on-page")}>
                          <Select value={form.position} onValueChange={(v) => set("position", v as TenantSeal["position"])}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {SEAL_POSITIONS.map((p) => (
                                <SelectItem key={p.value} value={p.value}>{t(p.label)}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </Field>
                        <div className="grid grid-cols-2 gap-3">
                          <Field label={t("doc-offset-x-mm")}><NumberInput value={form.offset_x_mm} onChange={(v) => set("offset_x_mm", v)} min={-100} max={100} /></Field>
                          <Field label={t("doc-offset-y-mm")}><NumberInput value={form.offset_y_mm} onChange={(v) => set("offset_y_mm", v)} min={-100} max={100} /></Field>
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="appearance">
                    <AccordionTrigger><SectionLabel icon={Droplet} label={t("doc-section-appearance")} /></AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-3">
                        <Field label={t("doc-opacity-pct").replace("{n}", String(Math.round(form.opacity * 100)))}>
                          <Slider value={[form.opacity]} min={0.05} max={1} step={0.05} onValueChange={(v) => set("opacity", v[0])} />
                        </Field>
                        <Field label={t("doc-rotation-deg").replace("{n}", String(form.rotation_deg))}>
                          <Slider value={[form.rotation_deg]} min={-180} max={180} step={1} onValueChange={(v) => set("rotation_deg", v[0])} />
                        </Field>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <RotateCw className="size-3.5" />
                          {t("doc-rotation-label")} <span className="tabular">{form.rotation_deg}°</span>
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="apply">
                    <AccordionTrigger><SectionLabel icon={ShieldCheck} label={t("doc-section-apply-types")} /></AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-3">
                        <p className="text-xs text-muted-foreground">
                          {t("doc-apply-types-desc")}
                        </p>
                        <div className="grid grid-cols-2 gap-2">
                          {SEAL_DOC_TYPES.map((dt) => (
                            <label
                              key={dt.value}
                              className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 cursor-pointer hover:bg-accent/40 transition-colors"
                            >
                              <Checkbox
                                checked={applyToTypes.includes(dt.value)}
                                onCheckedChange={() => toggleApplyTo(dt.value)}
                              />
                              <span className="text-sm">{t(dt.label)}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="signature">
                    <AccordionTrigger><SectionLabel icon={Pen} label={t("doc-section-signature-line")} /></AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-3">
                        <Field label={t("doc-enabled")}>
                          <div className="flex items-center gap-2">
                            <Switch checked={form.signature_enabled} onCheckedChange={(v) => set("signature_enabled", v)} aria-label={t("doc-enabled")} />
                            <span className="text-sm text-muted-foreground">{t("doc-signature-line-desc")}</span>
                          </div>
                        </Field>
                        {form.signature_enabled && (
                          <div className="grid grid-cols-2 gap-3">
                            <Field label={t("doc-label")}><Input value={form.signature_label ?? ""} onChange={(e) => set("signature_label", e.target.value)} placeholder={t("doc-authorized-signature")} /></Field>
                            <Field label={t("doc-name")}><Input value={form.signature_name ?? ""} onChange={(e) => set("signature_name", e.target.value)} placeholder="Vladimir, Director" /></Field>
                          </div>
                        )}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </div>
            </div>
          </div>

          {/* Right: live preview */}
          <div className="bg-muted/30 min-h-0 flex flex-col">
            <div className="px-5 py-3 border-b border-border/60 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Eye className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">{t("doc-placement-preview")}</span>
              </div>
              <Badge variant="outline" className="text-xs capitalize">{form.position.replace(/-/g, " ")}</Badge>
            </div>
            <div className="custom-scroll flex-1 overflow-y-auto">
              <div className="p-6 flex justify-center">
                <SealPreview form={form} />
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="px-5 py-4 border-t border-border/60 bg-card">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button onClick={handleSave} disabled={saving}>
            <Save className="size-4 mr-1" /> {t("doc-save-seal")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// Seal placement preview
// ============================================================

function SealPreview({ form }: { form: SealFormState }) {
  const pageWidthPx = 480;
  const pageHeightPx = Math.round(pageWidthPx * 1.414);
  const mmToPx = (mm: number) => (mm / 210) * pageWidthPx;

  // Position the seal absolutely based on `position` + offsets
  const sealWidth = mmToPx(form.image_width_mm);
  const sealHeight = mmToPx(form.image_height_mm);
  const offsetX = mmToPx(form.offset_x_mm);
  const offsetY = mmToPx(form.offset_y_mm);
  const margin = 16;

  const posStyle: React.CSSProperties = {
    position: "absolute",
    width: sealWidth,
    height: sealHeight,
    opacity: form.opacity,
    transform: `rotate(${form.rotation_deg}deg)`,
  };

  if (form.position === "bottom-right") {
    Object.assign(posStyle, { bottom: margin + offsetY, right: margin - offsetX });
  } else if (form.position === "bottom-left") {
    Object.assign(posStyle, { bottom: margin + offsetY, left: margin + offsetX });
  } else if (form.position === "bottom-center") {
    Object.assign(posStyle, { bottom: margin + offsetY, left: "50%", marginLeft: -sealWidth / 2 + offsetX });
  } else if (form.position === "top-right") {
    Object.assign(posStyle, { top: margin - offsetY, right: margin - offsetX });
  } else if (form.position === "top-left") {
    Object.assign(posStyle, { top: margin - offsetY, left: margin + offsetX });
  } else if (form.position === "top-center") {
    Object.assign(posStyle, { top: margin - offsetY, left: "50%", marginLeft: -sealWidth / 2 + offsetX });
  }

  return (
    <div
      className="bg-white shadow-soft-lg rounded-sm mx-auto relative overflow-hidden"
      style={{
        width: pageWidthPx,
        height: pageHeightPx,
        padding: margin,
      }}
    >
      {/* Outline placeholder for the page */}
      <div className="w-full h-full rounded-sm border border-dashed border-border/60 flex flex-col items-center justify-center text-muted-foreground">
        <FileText className="size-10 mb-2 opacity-30" />
        <p className="text-xs">A4 page outline</p>
        <p className="text-xs mt-1 opacity-70">Seal is positioned relative to page edges</p>
      </div>

      {/* Seal */}
      {form.image_url && (
        <div style={posStyle}>
          <img src={form.image_url} alt="Seal" className="w-full h-full object-contain" />
        </div>
      )}

      {/* Signature line beside seal */}
      {form.signature_enabled && (
        <div
          style={{
            position: "absolute",
            ...(form.position.startsWith("bottom")
              ? { bottom: margin + offsetY + 4 }
              : { top: margin - offsetY + sealHeight + 4 }),
            ...(form.position.endsWith("right")
              ? { right: margin - offsetX + sealWidth + 8 }
              : form.position.endsWith("left")
                ? { left: margin + offsetX + sealWidth + 8 }
                : { left: "50%", marginLeft: sealWidth / 2 + 8 }),
            minWidth: 120,
          }}
        >
          <div style={{ borderTop: "1px solid #475569", width: 100 }} />
          <div style={{ fontSize: 8, color: "#475569", marginTop: 2 }}>
            {form.signature_label || "Signature"}
          </div>
          {form.signature_name && (
            <div style={{ fontSize: 9, color: "#0f172a", fontWeight: 600, marginTop: 1 }}>
              {form.signature_name}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// audit24 — Template editor STUDIO (3-pane redesign)
// ============================================================
// Replaces the old 3-tab dialog (Form / Styling / Visual) whose
// options were scattered across tabs, accordions and sub-tabs.
//
//   ┌─────────────┬──────────────────────┬──────────────────┐
//   │ section nav │ settings (scrolls)   │ live preview     │
//   └─────────────┴──────────────────────┴──────────────────┘
//
// Design goals (user feedback: "ništa se ne može skrolirati, sve je
// nabacano, ne zna se šta koja opcija radi, preview je loš"):
//   1. every pane scrolls on its own — NATIVE overflow-y-auto +
//      custom-scroll (the old nested Radix ScrollArea chain broke
//      wheel scrolling)
//   2. ONE place per setting — 9 clearly-labelled sections replace
//      tab → accordion → sub-tab digging
//   3. every section opens with a plain-language intro
//   4. the preview pane is always visible on desktop: instant
//      Draft preview OR the REAL PDF rendered inline (no nested
//      dialog), with regenerate + "form changed" staleness hint
//   5. collapsible preview pane; on mobile the preview becomes a
//      full-screen overlay via the Eye button in the top bar

// Section rail — `labelKey` resolves through t() at render time.
const EDITOR_SECTIONS: { id: string; icon: any; labelKey: string }[] = [
  { id: "basics", icon: FileText, labelKey: "doc-section-basics" },
  // audit33: the memorandum frame is LOCKED from document templates — one
  // read-only section replaces the old page/header/footer editors.
  { id: "memorandum", icon: Lock, labelKey: "doc-section-memorandum-frame" },
  { id: "body", icon: Type, labelKey: "doc-editor-nav-body" },
  { id: "styling", icon: Palette, labelKey: "doc-tab-styling" },
  { id: "layout", icon: Grid3x3, labelKey: "doc-editor-nav-layout" },
  { id: "banks", icon: Building2, labelKey: "doc-section-bank-accounts" },
  { id: "variables", icon: Braces, labelKey: "doc-section-available-variables" },
];

// ── Draft preview ──────────────────────────────────────────────
// A4/Letter-proportioned approximation rendered straight from the
// CURRENT form state — instant, no server round-trip. For the
// pixel-true output use the "Real PDF" tab in the preview pane.
function TemplateMiniPreview({ form, memoSettings, tenant, letterhead }: {
  form: TemplateFormState;
  memoSettings: MemorandumSettings | null;
  tenant: Tenant | null;
  letterhead: TenantLetterhead | null;
}) {
  const t = useT();

  // audit33: page geometry comes from the memorandum (the locked frame),
  // NOT the template's legacy page_* fields.
  const memo = memoSettings;
  const pageW = memo?.page_size === "Letter" ? 216 : 210;
  const pageH = memo?.page_size === "Letter" ? 279 : 297;
  const width = 420; // px — the preview pane is ~380-520 wide
  const scale = width / pageW;
  // audit27: the page grows with the content — a fixed height clipped the
  // reordered/hidden sections and looked nothing like the real PDF.
  // 1pt = 25.4/72 mm → px (never below ~3px so lines stay visible)
  const ptToPx = (pt: number) => Math.max(3, Math.round(pt * 0.3528 * scale));

  // audit33: footer segments survive only as small note lines in the memo
  // footer's center zone (disclaimers); header segments are gone entirely.
  const footerSegs = form.footer_enabled
    ? resolvePreviewSegments(form.footer_content || DEFAULT_FOOTER_CONTENT_JSON)
    : [];

  // audit23: custom watermark (style_json.watermark) — same parser the PDF
  // renderer uses, rendered as a rotated overlay like the real output.
  const wm = parseStyleConfig(form.style_json).watermark;

  // audit27: layout_json — same order/visibility semantics as the PDF
  // renderer (templates.tsx → orderedBody). The draft preview now follows
  // the Sections & order tab exactly: hidden sections vanish and the order
  // matches the generated document.
  const layoutFields = readTemplateLayout(form.layout_json)?.fields ?? [];
  const isLoi = form.type === "loi";
  const hidden = (type: string) => {
    if (layoutFields.length === 0) return false;
    const f = layoutFields.find((x) => x.type === type);
    return f ? !f.visible : false;
  };
  const orderY = (type: string): number => {
    const f = layoutFields.find((x) => x.type === type);
    return f ? f.y : (CANONICAL_ORDER as readonly string[]).indexOf(type) * 10;
  };
  const overlays = layoutFields.filter(
    (f) => f.visible && (f.type === "custom_text" || f.type === "custom_image"),
  );

  // ── Section blocks (each gated + ordered like the PDF) ──────────────
  const S = {
    parties: (
      <div key="parties" className="mb-2 grid grid-cols-2 gap-3">
        {!hidden("from_box") && (
          <div className="min-w-0">
            <div className="text-[8px] font-bold uppercase tracking-wide text-slate-400">
              {PREVIEW_PLACEHOLDER_DATA.company_name}
            </div>
            <div className="text-slate-500 leading-tight" style={{ fontSize: ptToPx(8) }}>
              {PREVIEW_PLACEHOLDER_DATA.company_city}, {PREVIEW_PLACEHOLDER_DATA.company_country}
            </div>
          </div>
        )}
        {!hidden("to_box") && (
          <div className="min-w-0 text-right">
            <div className="truncate font-semibold" style={{ fontSize: ptToPx(10) }}>
              {PREVIEW_PLACEHOLDER_DATA.partner_name}
            </div>
            <div className="text-slate-500 leading-tight" style={{ fontSize: ptToPx(8) }}>
              {PREVIEW_PLACEHOLDER_DATA.partner_address}
            </div>
          </div>
        )}
      </div>
    ),
    doc_title: (
      <div key="doc_title" className="mb-2">
        <div
          className="mb-1 font-bold uppercase tracking-wide"
          style={{ color: form.primary_color || "#0f766e", fontSize: ptToPx(15) }}
        >
          {t(TYPE_LABEL_KEYS[form.type])} · {PREVIEW_PLACEHOLDER_DATA.doc_number}
        </div>
        <div className="text-slate-500" style={{ fontSize: ptToPx(8) }}>
          {PREVIEW_PLACEHOLDER_DATA.doc_date} · {t("doc-var-valid-until")}: {PREVIEW_PLACEHOLDER_DATA.valid_until}
        </div>
      </div>
    ),
    trade_terms: (
      <div key="trade_terms" className="mb-2 grid grid-cols-3 gap-2" style={{ fontSize: ptToPx(8) }}>
        {[
          ["Incoterm", "EXW · Hamburg"],
          ["Payment", "Net 30"],
          ["Origin", "EU"],
        ].map(([k, v]) => (
          <div key={k} className="rounded-sm border border-slate-200 px-1.5 py-1">
            <div className="text-slate-400">{k}</div>
            <div className="font-semibold text-slate-600">{v}</div>
          </div>
        ))}
      </div>
    ),
    line_items_table: (
      <div
        key="line_items_table"
        className="overflow-hidden rounded-sm border"
        style={{ borderColor: form.table_border_color || "#e2e8f0" }}
      >
        <div
          className="grid grid-cols-[1fr_54px_70px_84px] px-2 py-1 font-semibold"
          style={{
            background: form.table_header_bg || "#0f766e",
            color: form.table_header_color || "#ffffff",
            fontSize: ptToPx(9),
          }}
        >
          <span className="truncate">{t("misc-product")}</span>
          <span className="text-right">{t("misc-qty")}</span>
          <span className="text-right">{t("misc-price")}</span>
          <span className="text-right">{t("misc-total")}</span>
        </div>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="grid grid-cols-[1fr_54px_70px_84px] items-center px-2 py-1.5"
            style={{ background: form.table_stripe && i % 2 === 1 ? "#f1f5f9" : "#ffffff" }}
          >
            <span className="h-2 rounded-sm bg-slate-200" style={{ width: `${58 - i * 9}%` }} />
            <span className="h-2 justify-self-end rounded-sm bg-slate-200" style={{ width: "60%" }} />
            <span className="h-2 justify-self-end rounded-sm bg-slate-200" style={{ width: "72%" }} />
            <span className="h-2 justify-self-end rounded-sm bg-slate-200" style={{ width: "86%" }} />
          </div>
        ))}
      </div>
    ),
    specifications: (
      <div key="specifications" className="mb-2" style={{ fontSize: ptToPx(8) }}>
        <div className="mb-1 font-semibold text-slate-600">{t("misc-tve-specifications")}</div>
        <div className="grid grid-cols-2 gap-x-3 text-slate-500">
          <span>Moisture: ≤14%</span>
          <span>Foreign matter: ≤2%</span>
          <span>Broken: ≤5%</span>
          <span>Packing: 50kg PP bags</span>
        </div>
      </div>
    ),
    totals: (
      <div
        key="totals"
        className="mt-2 flex w-[46%] flex-col items-end self-end"
        style={{ fontSize: ptToPx(8.5) }}
      >
        <div className="flex w-full justify-between text-slate-500">
          <span>{t("doc-var-total")}</span>
          <span className="tabular">{PREVIEW_PLACEHOLDER_DATA.total}</span>
        </div>
        <div
          className="flex w-full justify-between border-t pt-0.5 font-bold"
          style={{ borderColor: form.table_border_color || "#e2e8f0", color: form.primary_color }}
        >
          <span>{t("misc-total")}</span>
          <span className="tabular">{PREVIEW_PLACEHOLDER_DATA.total}</span>
        </div>
      </div>
    ),
    amount_in_words: (
      <p key="amount_in_words" className="mt-1 text-slate-500 italic" style={{ fontSize: ptToPx(8) }}>
        {t("misc-tve-amount-words")}: Forty-two thousand one hundred ninety-six US dollars only.
      </p>
    ),
    offer_text: (
      <p key="offer_text" className="mt-2 leading-snug text-slate-500" style={{ fontSize: ptToPx(8) }}>
        {isLoi
          ? "Dear partner, we hereby express our firm intention to purchase the goods under the terms stated in this Letter of Intent…"
          : t("doc-preview-body-placeholder")}
      </p>
    ),
    bank_details: (
      <p key="bank_details" className="mt-2 text-slate-500" style={{ fontSize: ptToPx(8) }}>
        {t("misc-tve-bank-label")}: {PREVIEW_PLACEHOLDER_DATA.company_name} Bank · IBAN AE11 0200 0000 1234 5678 901
      </p>
    ),
    signatures: (
      <div key="signatures" className="mt-4 grid grid-cols-2 gap-8" style={{ fontSize: ptToPx(8) }}>
        {[
          t("misc-tve-seller-signature"),
          t("misc-tve-buyer-signature"),
        ].map((label) => (
          <div key={label} className="flex flex-col items-center">
            <div className="w-full border-t border-slate-400" />
            <div className="mt-0.5 text-slate-400">{label}</div>
          </div>
        ))}
      </div>
    ),
  };

  // Sections the doc type actually uses (LOI vs offer/invoice/proforma) —
  // mirrors the PDF generator's section list.
  const sectionKeys = isLoi
    ? ["doc_title", "parties", "offer_text", "specifications", "trade_terms", "signatures"]
    : ["doc_title", "parties", "trade_terms", "line_items_table", "specifications",
       "totals", "amount_in_words", "offer_text", "bank_details", "signatures"];

  const orderedSections = sectionKeys
    .filter((k) => !hidden(k))
    .sort((a, b) => orderY(a) - orderY(b))
    .map((k) => (S as Record<string, React.ReactNode>)[k])
    .filter(Boolean);

  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className="relative flex flex-col rounded-sm border border-border bg-white text-slate-800 shadow-sm"
        style={{
          width,
          minHeight: Math.round(pageH * scale * 0.9),
          padding: `${(memo?.margin_top_mm ?? 20) * scale}px ${(memo?.margin_right_mm ?? 15) * scale}px ${(memo?.margin_bottom_mm ?? 20) * scale}px ${(memo?.margin_left_mm ?? 15) * scale}px`,
          fontFamily: form.body_font_family || undefined,
          fontSize: ptToPx(form.body_font_size ?? 11),
        }}
      >
        {/* audit23: custom watermark overlay (rotated, low opacity) */}
        {wm.enabled && wm.text.trim() && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-0 right-0 select-none text-center font-bold"
            style={{
              top: "38%",
              fontSize: Math.max(12, ptToPx(wm.fontSize)),
              color: wm.color,
              opacity: wm.opacity,
              transform: `rotate(${wm.rotation}deg)`,
              whiteSpace: "nowrap",
            }}
          >
            {wm.text}
          </span>
        )}
        {/* audit33: HEADER — the LOCKED memorandum frame: company name
            left + logo right (same base on every document). */}
        {memo?.header_enabled !== false && (
          <div
            className="mb-3 flex items-center justify-between gap-3 border-b pb-2"
            style={{
              minHeight: (memo?.header_height_mm ?? 30) * scale,
              borderBottomWidth: memo?.header_border_enabled !== false ? Math.max(1, (memo?.header_border_width ?? 2) * 0.6) : 0,
              borderBottomColor: memo?.header_border_color || form.primary_color || "#0d9488",
              backgroundColor: memo?.header_bg_color || "#ffffff",
            }}
          >
            <div className={cn("min-w-0", (memo?.logo_side ?? "right") === "left" ? "order-2 text-right" : "")}>
              <div
                className="truncate"
                style={{
                  fontSize: ptToPx(memo?.header_left_font_size ?? 14),
                  fontWeight: memo?.header_left_font_bold === false ? 400 : 700,
                  color: memo?.header_left_font_color || form.primary_color || "#0d9488",
                }}
              >
                {letterhead?.company_legal_name || letterhead?.company_name || tenant?.legal_name || tenant?.name || "Company"}
              </div>
              {memo?.header_show_subtitle ? (
                <div className="text-slate-500" style={{ fontSize: ptToPx(7.5) }}>
                  {[letterhead?.company_city || tenant?.city, letterhead?.company_country || tenant?.country].filter(Boolean).join(", ")}
                </div>
              ) : null}
            </div>
            {memo?.logo_enabled !== false && (letterhead?.logo_url || tenant?.logo_url) ? (
               
              <img
                src={(letterhead?.logo_url || tenant?.logo_url)!}
                alt=""
                className={cn("shrink-0", (memo?.logo_side ?? "right") === "left" ? "order-1" : "")}
                style={{
                  maxWidth: (memo?.logo_max_width_mm ?? 50) * scale,
                  maxHeight: (memo?.logo_max_height_mm ?? 20) * scale,
                  objectFit: memo?.logo_fit_mode === "cover" || memo?.logo_fit_mode === "fill" ? memo.logo_fit_mode : "contain",
                }}
              />
            ) : null}
          </div>
        )}

        {/* audit27: body sections — ordered + gated exactly like the PDF */}
        {orderedSections}

        {/* audit27: custom overlays from layout_json (absolute, every page) */}
        {overlays.map((f) => {
          const text =
            typeof f.props?.text === "string"
              ? f.props.text
              : typeof f.props?.content === "string"
                ? f.props.content
                : "";
          if (f.type === "custom_text" && text.trim()) {
            return (
              <div
                key={f.id}
                className="absolute rounded-sm border border-dashed border-teal-400 bg-teal-50/30 px-1 text-slate-600"
                style={{
                  left: f.x * scale,
                  top: f.y * scale,
                  width: f.width * scale,
                  fontSize: ptToPx(10),
                }}
              >
                {text}
              </div>
            );
          }
          if (f.type === "custom_image") {
            const src = typeof f.props?.src === "string" ? f.props.src : (f.props?.imageUrl as string | undefined);
            if (src) {
              return (
                 
                <img
                  key={f.id}
                  src={src}
                  alt="Placed block"
                  className="absolute rounded-sm border border-dashed border-teal-400"
                  style={{ left: f.x * scale, top: f.y * scale, width: f.width * scale, height: f.height * scale, objectFit: "contain" }}
                />
              );
            }
          }
          return null;
        })}

        {/* audit33: FOOTER — the LOCKED memorandum frame: company address
            left + QR center + page number right. */}
        {memo?.footer_enabled !== false && (() => {
          const lPct = Math.max(15, Math.min(60, memo?.footer_left_width_pct ?? 30));
          const cPct = Math.max(15, Math.min(60, memo?.footer_center_width_pct ?? 40));
          const rPct = Math.max(15, Math.min(60, memo?.footer_right_width_pct ?? 30));
          const sum = lPct + cPct + rPct;
          const qrHere = (zone: string) => memo?.qr_enabled !== false && (memo?.qr_position || "center") === zone;
          const addr: string[] = memo?.footer_address_source === "custom"
            ? String(memo?.footer_address_custom || "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 4)
            : [
              tenant?.address_line || letterhead?.company_address_line || "",
              [tenant?.city || letterhead?.company_city, tenant?.country || letterhead?.company_country].filter(Boolean).join(", "),
            ].filter(Boolean);
          return (
            <div
              className="mt-auto flex items-start gap-2 border-t pt-1.5"
              style={{
                minHeight: (memo?.footer_height_mm ?? 25) * scale,
                borderTopWidth: memo?.footer_border_enabled !== false ? 1 : 0,
                borderTopColor: memo?.footer_border_color || "#cccccc",
                backgroundColor: memo?.footer_bg_color || "#ffffff",
              }}
            >
              <div style={{ width: `${(lPct / sum) * 100}%` }} className="flex min-w-0 flex-col">
                {qrHere("left") ? <div className="mb-1 flex size-9 items-center justify-center rounded border border-dashed text-muted-foreground"><QrCode className="size-4" /></div> : null}
                {memo?.footer_left_enabled !== false && addr.map((l, i) => (
                  <div key={i} className="truncate" style={{ fontSize: ptToPx(memo?.footer_left_font_size ?? 8), color: memo?.footer_left_font_color || "#666", lineHeight: 1.3 }}>
                    {l}
                  </div>
                ))}
              </div>
              <div style={{ width: `${(cPct / sum) * 100}%` }} className="flex min-w-0 flex-col items-center">
                {qrHere("center") ? <div className="flex size-9 items-center justify-center rounded border border-dashed text-muted-foreground"><QrCode className="size-4" /></div> : null}
                {footerSegs.slice(0, 2).map((seg) => (
                  <div key={seg.id} className="max-w-full truncate text-center" style={{ fontSize: ptToPx(memo?.footer_center_font_size ?? 7), color: memo?.footer_center_font_color || "#888", lineHeight: 1.3 }}>
                    {seg.text || "\u00A0"}
                  </div>
                ))}
              </div>
              <div style={{ width: `${(rPct / sum) * 100}%` }} className="flex min-w-0 flex-col items-end">
                {qrHere("right") ? <div className="mb-1 flex size-9 items-center justify-center rounded border border-dashed text-muted-foreground"><QrCode className="size-4" /></div> : null}
                {memo?.page_number_enabled !== false ? (
                  <div style={{ fontSize: ptToPx(memo?.footer_right_font_size ?? 8), color: memo?.footer_right_font_color || "#666" }}>
                    Page 1 of 2
                  </div>
                ) : null}
              </div>
            </div>
          );
        })()}
      </div>
      <p className="max-w-[400px] text-center text-xs text-muted-foreground">
        {t("doc-preview-note")}
      </p>
    </div>
  );
}

// ── Section intro — icon + title + plain-language description ──
function SectionIntro({
  icon: Icon, title, description, id,
}: {
  icon: any; title: string; description: string; id: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="size-5" />
      </div>
      <div className="min-w-0 pt-0.5">
        <h3 id={id} className="text-base font-semibold leading-tight">{title}</h3>
        <p className="mt-0.5 text-sm leading-snug text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

// ── Preview pane — Draft (instant) | Real PDF (server-rendered) ──
// Shared by the desktop side pane and the mobile full-screen overlay.
function PreviewPane({
  mode, onModeChange, onRegenerate, previewing, previewUrl, docNumber, stale,
  form, badges, onCollapse, memoSettings, tenant, letterhead,
}: {
  mode: "draft" | "pdf";
  onModeChange: (m: "draft" | "pdf") => void;
  onRegenerate: () => void;
  previewing: boolean;
  previewUrl: string | null;
  docNumber: string;
  stale: boolean;
  form: TemplateFormState;
  badges?: React.ReactNode;
  onCollapse?: () => void;
  memoSettings?: MemorandumSettings | null;
  tenant?: Tenant | null;
  letterhead?: TenantLetterhead | null;
}) {
  const t = useT();
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* Mode tabs + actions */}
      <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-2">
        <Tabs value={mode} onValueChange={(v) => onModeChange(v as "draft" | "pdf")}>
          <TabsList className="h-8">
            <TabsTrigger value="draft" className="gap-1.5 px-3 text-xs">
              <Eye className="size-3.5" /> {t("doc-editor-preview-tab-draft")}
            </TabsTrigger>
            <TabsTrigger value="pdf" className="gap-1.5 px-3 text-xs">
              <FileSearch className="size-3.5" /> {t("doc-editor-preview-tab-pdf")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="ml-auto flex items-center gap-1">
          {mode === "pdf" && previewUrl && (
            <Button variant="ghost" size="sm" className="size-8 p-0" asChild title={t("doc-open-new-tab")}>
              <a href={previewUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-4" />
              </a>
            </Button>
          )}
          {mode === "pdf" && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 px-2"
              onClick={onRegenerate}
              disabled={previewing}
              title={t("doc-editor-preview-regenerate")}
            >
              {previewing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              <span className="hidden xl:inline">{t("doc-editor-preview-regenerate")}</span>
            </Button>
          )}
          {onCollapse && (
            <Button
              variant="ghost"
              size="sm"
              className="hidden size-8 p-0 lg:inline-flex"
              onClick={onCollapse}
              title={t("doc-close")}
            >
              <PanelRightClose className="size-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Context badges (draft mode) / doc info + staleness (pdf mode) */}
      {mode === "draft" && badges ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-1.5">{badges}</div>
      ) : null}
      {mode === "pdf" && stale && previewUrl && (
        <div className="flex items-center gap-1.5 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400">
          <TriangleAlert className="size-3.5 shrink-0" />
          {t("doc-editor-preview-stale")}
        </div>
      )}
      {mode === "pdf" && previewUrl && docNumber && (
        <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
          <FileText className="size-3.5 shrink-0" />
          <span className="truncate">{docNumber} · {t("doc-editor-preview-pdf-hint")}</span>
        </div>
      )}

      {/* Body */}
      {mode === "draft" ? (
        <div className="custom-scroll flex min-h-0 flex-1 justify-center overflow-y-auto p-4">
          <TemplateMiniPreview form={form} memoSettings={memoSettings ?? null} tenant={tenant ?? null} letterhead={letterhead ?? null} />
        </div>
      ) : (
        <div className="relative min-h-0 flex-1 bg-muted/30">
          {previewUrl ? (
            <iframe
              src={previewUrl}
              title={t("doc-preview-pdf")}
              className="absolute inset-0 size-full border-0"
            />
          ) : previewing ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
              <Loader2 className="size-6 animate-spin" />
              <p className="text-sm">{t("doc-preview-generating")}</p>
            </div>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
              <FileSearch className="size-8 text-muted-foreground/60" />
              <p className="max-w-[280px] text-sm text-muted-foreground">
                {t("doc-editor-pdf-empty")}
              </p>
              <Button size="sm" variant="outline" onClick={onRegenerate} disabled={previewing}>
                <FileSearch className="size-4" /> {t("doc-editor-pdf-empty-cta")}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TemplateEditorDialog({
  open, onOpenChange, template, draft, tenantQuery, tenant, letterheads, seals, memoSettings, onOpenMemorandumStudio, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  template: DocumentTemplate | null;
  /**
   * Optional initial form values for a brand-new template created from a
   * starter (e.g. "Professional Offer Template"). Only consulted when
   * `template` is null. Ignored when editing an existing template.
   */
  draft?: TemplateFormState | null;
  tenantQuery: string;
  tenant: Tenant | null;
  letterheads: TenantLetterhead[];
  seals: TenantSeal[];
  /** audit33: the LOCKED memorandum frame (memo owns header/footer/page). */
  memoSettings: MemorandumSettings | null;
  /** Closes the dialog and opens the Memorandum studio tab. */
  onOpenMemorandumStudio: () => void;
  onSaved: () => void;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [form, setForm] = useState<TemplateFormState>(defaultTemplate());
  const [saving, setSaving] = useState(false);

  // ── audit24: studio session state ────────────────────────────────────
  // Active section, which sections have been visited (lazy-mount so the
  // visual editor / segment studios mount only when first opened, but
  // then keep their local state), preview mode + collapse + mobile overlay.
  const [section, setSection] = useState<string>("basics");
  const [mountedSections, setMountedSections] = useState<string[]>(["basics"]);
  const [previewMode, setPreviewMode] = useState<"draft" | "pdf">("draft");
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const [mobilePreview, setMobilePreview] = useState(false);

  // ── audit23: live PDF preview state ───────────────────────────────────
  // The preview renders the CURRENT (unsaved) form on the tenant's most
  // recent real document — same generator as the download routes, via the
  // templateOverride option — inline in the preview pane (audit24: no
  // more nested dialog).
  const [previewing, setPreviewing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewDocNumber, setPreviewDocNumber] = useState<string>("");

  // audit21 — session-local “table header customised?” flag.
  // While the user has NOT explicitly edited the Table styling header
  // colour in THIS editing session, changing the primary (brand) colour
  // keeps table_header_bg in lockstep. Once they customise it, the two
  // decouple for the rest of the session. This resolves the top user
  // complaint “template colour edits never show up in the document” —
  // previously the table header kept its old absolute colour while only
  // the header rule/grand-total re-branded, looking exactly like the edit
  // was ignored.
  const tableHeaderTouched = useRef(false);

  // audit24: dirty / PDF-staleness tracking. Both the load snapshot and the
  // PDF-generation snapshot are STATE (the repo's react-hooks/refs rule
  // forbids reading refs during render) — updated only in the open effect
  // and the preview event handler, then compared against the memoised form
  // signature at render time.
  const [snapshot, setSnapshot] = useState<string>(""); // form signature at load (dialog open)
  const [pdfSnapshot, setPdfSnapshot] = useState<string>(""); // form signature when the PDF was generated
  const formSig = useMemo(() => JSON.stringify(form), [form]);
  const dirty = formSig !== snapshot;
  const pdfStale = !!previewUrl && formSig !== pdfSnapshot;

  useEffect(() => {
    if (open) {
      // Edit-existing takes priority, then starter draft, then blank default.
      const base = template ? { ...template } : draft ? { ...draft } : defaultTemplate();
      // Hydrate QR placement fields from footer_content._qrConfig (they're
      // not real DB columns — see writeQrConfig / parseQrConfig above).
      const qr = parseQrConfig(base.footer_content);
      const initial = {
        ...base,
        qr_position: base.qr_position ?? qr.position,
        qr_size_mm: base.qr_size_mm ?? qr.size,
        qr_opacity: base.qr_opacity ?? qr.opacity,
      };
      /* eslint-disable react-hooks/set-state-in-effect */
      setForm(initial);
      // audit24: fresh studio session per open.
      setSection("basics");
      setMountedSections(["basics"]);
      setPreviewMode("draft");
      setPreviewCollapsed(false);
      setMobilePreview(false);
      setSnapshot(JSON.stringify(initial));
      setPdfSnapshot("");
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [open, template, draft]);

  function set<K extends keyof TemplateFormState>(k: K, v: TemplateFormState[K]) {
    setForm((p) => ({ ...p, [k]: v }));
  }

  // audit24: section navigation — lazy-mounts a section the first time it
  // is opened, then keeps it mounted (hidden) so its local state survives.
  function goToSection(id: string) {
    setSection(id);
    setMountedSections((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }

  async function handleSave() {
    if (!form.name?.trim()) {
      toast.error(t("doc-template-name-required-toast"));
      return;
    }
    setSaving(true);
    try {
      const method = template ? "PUT" : "POST";
      // Always include ?tenant_id= for super-admin so the backend can resolve
      // the tenant scope (POST uses resolveTenantId, PUT just ignores it but
      // it's safer to keep the URL consistent). For PUT we read it from the
      // existing template row; for POST we use tenantQuery (already built).
      const saveUrl = template
        ? `/api/document-templates/${template.id}${template.tenant_id ? `?tenant_id=${encodeURIComponent(template.tenant_id)}` : tenantQuery}`
        : `/api/document-templates${tenantQuery}`;
      const url = api(saveUrl);

      // Build the payload that goes to the DB. Strip:
      //   • id, tenant_id, created_by, created_at, updated_at, letterhead, seal
      //     — these come back from the GET (join) response but aren't writable
      //     via the form (DB-managed or join results).
      //   • qr_position / qr_size_mm / qr_opacity — NOT real DB columns.
      //     They get serialized into footer_content._qrConfig instead so the
      //     PDF renderer can read them back out without a schema migration.
      const {
        qr_position: _qp,
        qr_size_mm: _qs,
        qr_opacity: _qo,
        ...writable
      } = form;
      const payload: TemplateFormState = {
        ...writable,
        footer_content: writeQrConfig(form.footer_content, {
          position: form.qr_position ?? "footer-right",
          size: form.qr_size_mm ?? 15,
          opacity: form.qr_opacity ?? 1,
        }),
      };

      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
      toast.success(template ? t("doc-template-updated-toast") : t("doc-template-created-toast"));
      onSaved();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : t("doc-failed-save-template-toast");
      toast.error(message || t("doc-failed-save-template-toast"));
    } finally {
      setSaving(false);
    }
  }

  const linkedLetterhead = letterheads.find((l) => l.id === form.letterhead_id) || null;
  const linkedSeal = seals.find((s) => s.id === form.seal_id) || null;
  // audit33: logo for the memo frame preview — the linked letterhead's logo
  // wins over the tenant logo (same precedence as the PDF generator).
  const linkedLogoUrl = linkedLetterhead?.logo_url || tenant?.logo_url || null;
  // audit22: real substitution data for the Segment Studio previews.
  const studioPreviewData = buildStudioPreviewData(tenant, linkedLetterhead);

  // ── audit23: live PDF preview ─────────────────────────────────────────
  // Maps the template's type onto the document family the preview renders.
  // contract/generic templates have no documents of their own — an offer is
  // the closest stand-in (the generic look applies to future doc types).
  const previewDocType: "offer" | "invoice" | "proforma" | "loi" =
    form.type === "invoice" ? "invoice"
    : form.type === "proforma" ? "proforma"
    : form.type === "loi" ? "loi"
    : "offer";

  // Revoke the blob when the EDITOR closes (unmount) so we never leak it.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  async function handlePreview() {
    if (previewing) return;
    setPreviewing(true);
    try {
      // Same payload semantics as handleSave — QR placement merged into
      // footer_content._qrConfig, unwritable keys stripped — so what is
      // previewed is EXACTLY what would be saved.
      const {
        qr_position: _qp,
        qr_size_mm: _qs,
        qr_opacity: _qo,
        ...writable
      } = form;
      const payload: TemplateFormState = {
        ...writable,
        footer_content: writeQrConfig(form.footer_content, {
          position: form.qr_position ?? "footer-right",
          size: form.qr_size_mm ?? 15,
          opacity: form.qr_opacity ?? 1,
        }),
      };

      const r = await fetch(api(`/api/document-templates/preview${tenantQuery}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docType: previewDocType, template: payload }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        if ((err as { error?: string }).error === "NO_DOCUMENT") {
          toast.error(t("doc-preview-no-doc"));
        } else {
          toast.error((err as { error?: string }).error || t("doc-preview-failed"));
        }
        return;
      }
      const blob = await r.blob();
      if (!blob || blob.type !== "application/pdf" || blob.size < 500) {
        toast.error(t("doc-preview-failed"));
        return;
      }
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewDocNumber(r.headers.get("X-Preview-Doc-Number") || "");
      setPreviewUrl(URL.createObjectURL(blob));
      setPdfSnapshot(JSON.stringify(form));
    } catch {
      toast.error(t("doc-preview-failed"));
    } finally {
      setPreviewing(false);
    }
  }

  // audit24: switching to the PDF tab auto-generates the first render —
  // one click, no empty pane hunting for the button.
  function handleModeSwitch(m: "draft" | "pdf") {
    setPreviewMode(m);
    if (m === "pdf" && !previewUrl && !previewing) {
      void handlePreview();
    }
  }

  const previewBadges = (
    <>
      {linkedLetterhead && (
        <Badge variant="outline" className="text-xs">
          <Building2 className="size-3" /> <span className="max-w-[120px] truncate">{linkedLetterhead.name}</span>
        </Badge>
      )}
      {linkedSeal && form.seal_enabled && (
        <Badge variant="outline" className="text-xs">
          <Stamp className="size-3" /> <span className="max-w-[120px] truncate">{linkedSeal.name}</span>
        </Badge>
      )}
      <Badge variant="outline" className="text-xs">{form.page_size}</Badge>
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="full"
        showCloseButton={false}
        className="h-[95vh] gap-0 p-0 sm:max-w-[min(96vw,1680px)]"
      >
        {/* ── Top bar: identity + actions ── */}
        <div className="flex items-center gap-3 border-b border-border/60 px-4 py-3 sm:px-5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <LayoutTemplate className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-base leading-tight">
              {template ? t("doc-edit-template") : t("doc-new-template-title")}
              {form.name ? `: ${form.name}` : ""}
            </DialogTitle>
            <DialogDescription className="sr-only">{t("doc-template-editor-desc")}</DialogDescription>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <Badge variant="outline" className={cn("text-xs", TYPE_BADGE[form.type])}>
                {t(TYPE_LABEL_KEYS[form.type])}
              </Badge>
              <span className="tabular">{form.page_size}</span>
              {dirty && (
                <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                  <span className="size-1.5 rounded-full bg-amber-500" />
                  {t("doc-editor-unsaved-changes")}
                </span>
              )}
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {/* Mobile: open the full-screen preview overlay */}
            <Button
              variant="outline"
              size="sm"
              className="size-9 p-0 lg:hidden"
              onClick={() => setMobilePreview(true)}
              title={t("doc-editor-preview-toggle")}
              aria-label={t("doc-editor-preview-toggle")}
            >
              <Eye className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="hidden sm:inline-flex"
              onClick={() => onOpenChange(false)}
            >
              {t("cancel")}
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              <span className="ml-1.5 hidden sm:inline">{t("doc-save-template")}</span>
              <span className="sr-only sm:hidden">{t("doc-save-template")}</span>
            </Button>
          </div>
        </div>

        {/* ── Body: section nav | settings | live preview ── */}
        <div
          className={cn(
            "relative flex min-h-0 flex-1 flex-col lg:grid lg:grid-rows-1",
            previewCollapsed
              ? "lg:grid-cols-[216px_minmax(0,1fr)_44px]"
              : "lg:grid-cols-[216px_minmax(0,1fr)_clamp(380px,30vw,520px)]",
          )}
        >
          {/* Section rail — vertical on desktop, horizontal pills on mobile */}
          <nav
            aria-label={t("doc-template-editor-desc")}
            className="custom-scroll flex shrink-0 gap-1 overflow-x-auto border-b border-border/60 bg-muted/20 p-2 lg:flex-col lg:overflow-x-hidden lg:overflow-y-auto lg:border-b-0 lg:border-r lg:border-border/60 lg:p-2.5"
          >
            {EDITOR_SECTIONS.map((s) => {
              const active = section === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => goToSection(s.id)}
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "flex shrink-0 items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
                    active
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  <s.icon className="size-4 shrink-0" />
                  <span>{t(s.labelKey)}</span>
                </button>
              );
            })}
          </nav>

          {/* Settings — one section at a time, natively scrollable */}
          <div className="custom-scroll min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-5 sm:px-6">

              {/* ── Basics ── */}
              {mountedSections.includes("basics") && (
              <section className={cn("space-y-4", section !== "basics" && "hidden")} aria-labelledby="tpl-sec-basics">
                <SectionIntro
                  icon={FileText}
                  id="tpl-sec-basics"
                  title={t("doc-section-basics")}
                  description={t("doc-editor-intro-basics")}
                />
                <Card className="border-border/60">
                  <CardContent className="space-y-3 p-4">
                    <Field label={t("doc-template-name")}>
                      <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder={t("doc-template-name-placeholder")} />
                    </Field>
                    <Field label={t("type")}>
                      <Select value={form.type} onValueChange={(v) => set("type", v as TemplateType)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="offer">{t("doc-type-offer")}</SelectItem>
                          <SelectItem value="invoice">{t("doc-type-invoice")}</SelectItem>
                          <SelectItem value="proforma">{t("doc-type-proforma")}</SelectItem>
                          <SelectItem value="contract">{t("doc-type-contract")}</SelectItem>
                          <SelectItem value="loi">{t("doc-type-loi")}</SelectItem>
                          <SelectItem value="generic">{t("doc-type-generic")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label={t("doc-default-template")}>
                      <div className="flex items-center gap-2">
                        <Switch checked={form.is_default} onCheckedChange={(v) => set("is_default", v)} aria-label={t("doc-default-template")} />
                        <span className="text-sm text-muted-foreground">{t("doc-use-default-for-type")}</span>
                      </div>
                    </Field>
                  </CardContent>
                </Card>

                <Card className="border-border/60">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm">{t("doc-section-linked-memorandum-seal")}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <Field label={t("doc-letterhead-memorandum")}>
                      <Select
                        value={form.letterhead_id ?? "__none__"}
                        onValueChange={(v) => set("letterhead_id", v === "__none__" ? null : v)}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">{t("doc-use-tenant-default")}</SelectItem>
                          {letterheads.map((l) => (
                            <SelectItem key={l.id} value={l.id}>
                              {l.name}{l.is_default ? ` ${t("doc-default-suffix")}` : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label={t("doc-seal-zigled")}>
                      <Select
                        value={form.seal_id ?? "__none__"}
                        onValueChange={(v) => set("seal_id", v === "__none__" ? null : v)}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">{t("doc-no-seal-option")}</SelectItem>
                          {seals.map((s) => (
                            <SelectItem key={s.id} value={s.id}>
                              {s.name}{s.is_default ? ` ${t("doc-default-suffix")}` : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label={t("doc-stamp-seal-template")}>
                      <div className="flex items-center gap-2">
                        <Switch checked={form.seal_enabled} onCheckedChange={(v) => set("seal_enabled", v)} aria-label={t("doc-stamp-seal-template")} />
                        <span className="text-sm text-muted-foreground">
                          {form.seal_id ? t("doc-apply-selected-seal") : t("doc-select-seal-first")}
                        </span>
                      </div>
                    </Field>
                  </CardContent>
                </Card>
              </section>
              )}

              {/* ── Memorandum (locked frame) ── */}
              {mountedSections.includes("memorandum") && (
              <section className={cn("space-y-4", section !== "memorandum" && "hidden")} aria-labelledby="tpl-sec-memo">
                <SectionIntro
                  icon={Lock}
                  id="tpl-sec-memo"
                  title={t("doc-memo-locked-title")}
                  description={t("doc-memo-locked-desc")}
                />
                <Card className="border-border/60 bg-muted/20">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-sm">
                      <Lock className="size-4 text-muted-foreground" />
                      {t("doc-memo-locked-frame-preview")}
                    </CardTitle>
                    <CardDescription className="text-xs">{t("memo-studio-desc")}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {/* Compact frame preview — the memorandum as saved. */}
                    <div className="rounded-lg border border-dashed border-border bg-white p-4">
                      <div className="flex items-center justify-between gap-4 border-b pb-2" style={{ borderColor: (memoSettings?.header_border_color || memoSettings?.primary_color || "#0d9488"), borderBottomWidth: (memoSettings?.header_border_width ?? 2) }}>
                        <div className="min-w-0">
                          <div
                            className="truncate font-bold"
                            style={{
                              color: memoSettings?.header_left_font_color || memoSettings?.primary_color || "#0d9488",
                              fontSize: (memoSettings?.header_left_font_size ?? 14) * 0.9,
                            }}
                          >
                            {tenant?.legal_name || tenant?.name || "Company"}
                          </div>
                          {memoSettings?.header_show_subtitle && (tenant?.city || tenant?.country) ? (
                            <div className="text-xs text-muted-foreground">
                              {[tenant?.city, tenant?.country].filter(Boolean).join(", ")}
                            </div>
                          ) : null}
                        </div>
                        {linkedLogoUrl ? (
                           
                          <img src={linkedLogoUrl} alt="" className="shrink-0" style={{ maxWidth: 96, maxHeight: 36, objectFit: "contain" }} />
                        ) : (
                          <div className="flex h-9 w-24 items-center justify-center rounded border border-dashed text-[10px] text-muted-foreground">
                            {t("memo-logo")}
                          </div>
                        )}
                      </div>
                      <div className="py-6 text-center text-xs text-muted-foreground">
                        {t("memo-preview-body-note")}
                      </div>
                      <div className="flex items-start justify-between gap-3 border-t pt-2" style={{ borderColor: memoSettings?.footer_border_color || "#cccccc" }}>
                        <div className="min-w-0 flex-1 text-[10px] leading-snug" style={{ color: memoSettings?.footer_left_font_color || "#666" }}>
                          {(tenant?.address_line || tenant?.city || tenant?.country) ? (
                            <>
                              <div className="truncate">{tenant?.address_line}</div>
                              <div className="truncate">{[tenant?.city, tenant?.country].filter(Boolean).join(", ")}</div>
                            </>
                          ) : (
                            <span className="opacity-60">{t("memo-footer-left")}</span>
                          )}
                        </div>
                        <div className="flex size-8 shrink-0 items-center justify-center rounded border border-dashed text-muted-foreground">
                          {memoSettings?.qr_enabled !== false && (memoSettings?.qr_position || "center") !== "none" ? (
                            <QrCode className="size-5" />
                          ) : (
                            <span className="text-[8px]">QR off</span>
                          )}
                        </div>
                        <div className="min-w-0 flex-1 text-right text-[10px]" style={{ color: memoSettings?.footer_right_font_color || "#666" }}>
                          {memoSettings?.page_number_enabled !== false ? "Page 1 of 2" : "—"}
                        </div>
                      </div>
                    </div>
                    <Button variant="outline" className="w-full" onClick={onOpenMemorandumStudio}>
                      <Building2 className="size-4" />
                      <span className="ml-1.5">{t("doc-memo-locked-open")}</span>
                    </Button>
                  </CardContent>
                </Card>
              </section>
              )}

              {/* ── Body & tables ── */}
              {mountedSections.includes("body") && (
              <section className={cn("space-y-4", section !== "body" && "hidden")} aria-labelledby="tpl-sec-body">
                <SectionIntro
                  icon={Type}
                  id="tpl-sec-body"
                  title={t("doc-editor-nav-body")}
                  description={t("doc-editor-intro-body")}
                />
                <Card className="border-border/60">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm">{t("doc-section-body-styling")}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {/* Font family — the three PDF-embedded families the
                        renderer actually resolves (mapFont: NotoSans /
                        Times-Roman / Courier). The Select guarantees the
                        chosen family is the one that renders in the PDF. */}
                    <Field label={t("doc-font-family")}>
                      <Select
                        value={normalizePdfFontFamily(form.body_font_family)}
                        onValueChange={(v) => set("body_font_family", v)}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="NotoSans">{t("doc-font-sans")}</SelectItem>
                          <SelectItem value="Times-Roman">{t("doc-font-serif")}</SelectItem>
                          <SelectItem value="Courier">{t("doc-font-mono")}</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground mt-1">{t("doc-font-family-hint")}</p>
                    </Field>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label={t("doc-font-size-px")}><NumberInput value={form.body_font_size} onChange={(v) => set("body_font_size", v)} min={7} max={24} /></Field>
                      <Field label={t("doc-line-height")}><NumberInput value={form.body_line_height} onChange={(v) => set("body_line_height", v)} min={1} max={2.5} step={0.1} /></Field>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <ColorField label={t("doc-primary-color")} value={form.primary_color} onChange={(v) => {
                      // audit21 — "template edits never apply" fix (partial application):
                      // changing the primary colour previously left table_header_bg
                      // on its old absolute colour, so the saved document only
                      // partially re-branded (header line changed, table headers
                      // stayed the old colour) and looked like the edit was ignored.
                      // Unless the table header colour was customised in THIS
                      // session (tableHeaderTouched), it now follows the primary
                      // colour change so the whole document re-brands together.
                      setForm((p) => ({
                        ...p,
                        primary_color: v,
                        ...(!tableHeaderTouched.current ? { table_header_bg: v } : {}),
                      }));
                    }} />
                      <ColorField label={t("doc-accent-color")} value={form.accent_color} onChange={(v) => set("accent_color", v)} />
                    </div>
                  </CardContent>
                </Card>

                <Card className="border-border/60">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm">{t("doc-section-table-styling")}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <ColorField label={t("doc-header-background")} value={form.table_header_bg} onChange={(v) => { tableHeaderTouched.current = true; set("table_header_bg", v); }} />
                    <ColorField label={t("doc-header-text-color")} value={form.table_header_color} onChange={(v) => set("table_header_color", v)} />
                    <ColorField label={t("doc-border-color")} value={form.table_border_color} onChange={(v) => set("table_border_color", v)} />
                    <Field label={t("doc-striped-rows")}>
                      <div className="flex items-center gap-2">
                        <Switch checked={form.table_stripe} onCheckedChange={(v) => set("table_stripe", v)} aria-label={t("doc-striped-rows")} />
                        <span className="text-sm text-muted-foreground">{t("doc-alternate-row-bg")}</span>
                      </div>
                    </Field>
                  </CardContent>
                </Card>
              </section>
              )}

              {/* ── Advanced styling (TemplateStylePanel) ── */}
              {mountedSections.includes("styling") && (
              <section className={cn("space-y-4", section !== "styling" && "hidden")} aria-labelledby="tpl-sec-styling">
                <SectionIntro
                  icon={Palette}
                  id="tpl-sec-styling"
                  title={t("doc-tab-styling")}
                  description={t("doc-editor-intro-styling")}
                />
                <TemplateStylePanel
                  styleJson={form.style_json}
                  onChange={(v) => set("style_json", v)}
                  primaryColor={form.primary_color}
                />
              </section>
              )}

              {/* ── Layout designer (TemplateVisualEditor) ── */}
              {mountedSections.includes("layout") && (
              <section className={cn("space-y-4", section !== "layout" && "hidden")} aria-labelledby="tpl-sec-layout">
                <SectionIntro
                  icon={Grid3x3}
                  id="tpl-sec-layout"
                  title={t("doc-editor-nav-layout")}
                  description={t("doc-editor-intro-layout")}
                />
                {/* Fixed-height container: the visual editor manages its own
                    internal scrolling (canvas, fields, properties panes). */}
                <div className="h-[min(76vh,840px)] overflow-hidden rounded-lg border border-border/60">
                  <TemplateVisualEditor
                    template={form}
                    onChange={(updates) => setForm((p) => ({ ...p, ...updates }))}
                    pageSize={form.page_size === "Letter" ? "Letter" : "A4"}
                    letterhead={linkedLetterhead}
                  />
                </div>
              </section>
              )}

              {/* ── Bank accounts ── */}
              {mountedSections.includes("banks") && (
              <section className={cn("space-y-4", section !== "banks" && "hidden")} aria-labelledby="tpl-sec-banks">
                <SectionIntro
                  icon={Building2}
                  id="tpl-sec-banks"
                  title={t("doc-section-bank-accounts")}
                  description={t("doc-editor-intro-banks")}
                />
                <Card className="border-border/60">
                  <CardContent className="space-y-3 p-4">
                    <p className="text-xs text-muted-foreground">
                      {t("doc-bank-accounts-desc")}
                    </p>
                    <BankAccountSelector
                      accounts={tenant?.bank_accounts ?? null}
                      selected={form.selected_bank_accounts ?? null}
                      onChange={(sel) => set("selected_bank_accounts", sel)}
                    />
                  </CardContent>
                </Card>
              </section>
              )}

              {/* ── Variables (help) ── */}
              {mountedSections.includes("variables") && (
              <section className={cn("space-y-4", section !== "variables" && "hidden")} aria-labelledby="tpl-sec-vars">
                <SectionIntro
                  icon={Braces}
                  id="tpl-sec-vars"
                  title={t("doc-section-available-variables")}
                  description={t("doc-editor-intro-variables")}
                />
                <Card className="border-border/60">
                  <CardContent className="space-y-3 p-4">
                    <p className="text-xs text-muted-foreground">
                      {t("doc-variables-hint")}
                    </p>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {AVAILABLE_VARIABLES.map((v) => (
                        <button
                          key={v.token}
                          type="button"
                          onClick={() => {
                            // audit24: click-to-copy — pro touch for the
                            // palette (clipboard may be unavailable on
                            // non-secure origins; degrade silently).
                            try {
                              void navigator.clipboard?.writeText(v.token);
                              toast.success(`${v.token} · ${t("doc-var-copied")}`);
                            } catch {
                              // ignore
                            }
                          }}
                          className="group flex flex-col items-start gap-0.5 rounded-md border border-border/60 bg-card px-2.5 py-2 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"
                          title={t(v.label)}
                        >
                          <code className="font-mono text-xs text-primary">{v.token}</code>
                          <span className="truncate text-[11px] text-muted-foreground">{t(v.label)}</span>
                        </button>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </section>
              )}

            </div>
          </div>

          {/* ── Preview pane (desktop) ── */}
          <aside className="hidden min-h-0 flex-col border-l border-border/60 bg-muted/20 lg:flex">
            {previewCollapsed ? (
              <button
                type="button"
                onClick={() => setPreviewCollapsed(false)}
                className="flex h-full w-11 flex-col items-center gap-2 py-3 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title={t("doc-editor-preview-toggle")}
                aria-label={t("doc-editor-preview-toggle")}
              >
                <PanelRightOpen className="size-4 shrink-0" />
                <span className="mt-1 text-[10px] font-medium tracking-wide [writing-mode:vertical-rl]">
                  {t("doc-editor-preview-toggle")}
                </span>
              </button>
            ) : (
              <PreviewPane
                memoSettings={memoSettings}
                tenant={tenant}
                letterhead={linkedLetterhead}
                mode={previewMode}
                onModeChange={handleModeSwitch}
                onRegenerate={handlePreview}
                previewing={previewing}
                previewUrl={previewUrl}
                docNumber={previewDocNumber}
                stale={pdfStale}
                form={form}
                badges={previewBadges}
                onCollapse={() => setPreviewCollapsed(true)}
              />
            )}
          </aside>

          {/* ── Preview overlay (mobile) ── */}
          {mobilePreview && (
            <div className="absolute inset-0 z-10 flex min-h-0 flex-1 flex-col bg-background lg:hidden">
              <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5">
                <span className="text-sm font-medium">{t("doc-editor-preview-toggle")}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-8 p-0"
                  onClick={() => setMobilePreview(false)}
                  title={t("doc-close")}
                  aria-label={t("doc-close")}
                >
                  <X className="size-4" />
                </Button>
              </div>
              <div className="flex min-h-0 flex-1 flex-col">
                <PreviewPane
                  memoSettings={memoSettings}
                  tenant={tenant}
                  letterhead={linkedLetterhead}
                  mode={previewMode}
                  onModeChange={handleModeSwitch}
                  onRegenerate={handlePreview}
                  previewing={previewing}
                  previewUrl={previewUrl}
                  docNumber={previewDocNumber}
                  stale={pdfStale}
                  form={form}
                  badges={previewBadges}
                />
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}


// ============================================================
// Shared form building blocks
// ============================================================

function SectionLabel({ icon: Icon, label }: { icon: any; label: string }) {
  return (
    <span className="flex items-center gap-2">
      <Icon className="size-4 text-primary" />
      <span className="text-sm font-medium">{label}</span>
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function MarginInput({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground uppercase tracking-wide">{label}</Label>
      <Input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        className="h-8 text-sm tabular"
        min={0}
        max={60}
      />
    </div>
  );
}

function NumberInput({
  value, onChange, min, max, step,
}: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number;
}) {
  return (
    <Input
      type="number"
      value={value}
      onChange={(e) => onChange(Number(e.target.value) || 0)}
      className="h-8 text-sm tabular"
      min={min}
      max={max}
      step={step}
    />
  );
}

function ToggleField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5">
      <Switch checked={checked} onCheckedChange={onChange} className="scale-90" aria-label={label} />
      <span className="text-xs">{label}</span>
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value || "#000000"}
          onChange={(e) => onChange(e.target.value)}
          className="size-8 rounded-md border border-border/60 cursor-pointer bg-card p-0.5"
        />
        <Input
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 font-mono text-xs flex-1"
        />
      </div>
    </div>
  );
}
