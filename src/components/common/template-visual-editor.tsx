"use client";

/**
 * TemplateVisualEditor — "Sections & order" (audit33/v1 redesign)
 * ----------------------------------------------------------------
 * User complaint: "sve je zgusnuto i stisnuto, ništa se ne može videti
 * i uređivati" — the old 3-pane editor (cramped section list + canvas +
 * properties) was replaced by a SPACIOUS single-column editor:
 *
 *   • One clear column: header → locked memorandum strip (header zone) →
 *     the reorderable DOCUMENT FLOW (generous cards) → collapsible
 *     CUSTOM OVERLAYS panel → locked memorandum strip (footer zone).
 *   • Each flow section is a full card (min-h 72px): grip drag handle
 *     (dnd-kit sortable), icon, name, "Order N" badge, eye visibility
 *     toggle and ↑/↓ buttons — everything visible at a glance, nothing
 *     hidden behind a selection/properties pane.
 *   • Header/footer/logo frame is OWNED BY THE MEMORANDUM (audit33):
 *     shown as muted, non-editable strips that communicate the page
 *     frame. Only the `logo` eye-toggle remains editable (the PDF still
 *     honours it).
 *
 * Data model (UNCHANGED — the PDF renderer depends on it):
 *   • layout_json = { fields: [{ id, type, label?, x, y, width, height,
 *     visible, locked, props? }] }
 *   • Body sections: `y` is the sort key (reindexed 10/20/30… after any
 *     reorder); `visible` gates the PDF render.
 *   • custom_text / custom_image overlays: absolute x/y/width/height in
 *     mm, stamped on every page.
 *   • `logo` field's visible flag gates the rendered logo.
 */

import * as React from "react";
import {
  Eye,
  EyeOff,
  RotateCcw,
  Type,
  Image as ImageIcon,
  GripVertical,
  Lock,
  ArrowUp,
  ArrowDown,
  Trash2,
  ChevronDown,
  ChevronRight,
  FileText,
  Building2,
  User,
  Scale,
  Table,
  ListChecks,
  Calculator,
  SpellCheck,
  AlignLeft,
  Landmark,
  PenLine,
  type LucideIcon,
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
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import type { DocumentTemplate, TenantLetterhead } from "@/lib/supabase/types";
import { useT } from "@/lib/i18n/store";
import { readTemplateLayout } from "@/lib/pdf/doc-template";

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

/** Icon per flow section (visual identity on the card). */
const SECTION_ICON: Record<string, LucideIcon> = {
  doc_title: FileText,
  from_box: Building2,
  to_box: User,
  trade_terms: Scale,
  line_items_table: Table,
  specifications: ListChecks,
  totals: Calculator,
  amount_in_words: SpellCheck,
  offer_text: AlignLeft,
  bank_details: Landmark,
  signatures: PenLine,
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
// Letterhead preview helpers (memorandum strips)
// ============================================================

function getCompanyName(letterhead: TenantLetterhead | null): string {
  return letterhead?.company_name || letterhead?.company_legal_name || "VELOS Trading";
}

function getLogoUrl(letterhead: TenantLetterhead | null): string | null {
  return letterhead?.logo_url || null;
}

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

// ============================================================
// Sortable flow card (the star of the UI)
// ============================================================

function SortableFlowCard({
  field,
  icon: Icon,
  index,
  total,
  onToggleVisible,
  onMoveUp,
  onMoveDown,
}: {
  field: FieldElement;
  icon: LucideIcon;
  index: number;
  total: number;
  onToggleVisible: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const t = useT();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: field.id,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "rounded-xl border bg-card shadow-xs",
        isDragging && "z-10 border-primary/60 shadow-md ring-2 ring-primary/25",
        field.visible
          ? "border-border/70 hover:border-border"
          : "border-dashed border-border/70 bg-muted/30 opacity-60",
      )}
    >
      <div className="flex min-h-[72px] items-center gap-2 p-4 sm:gap-3">
        {/* Drag surface — grip + icon + name + status (big target, no
            controls inside so dnd-kit never fights the buttons). */}
        <div
          {...attributes}
          {...listeners}
          title={t("misc-tve2-drag-handle")}
          className="flex min-w-0 flex-1 cursor-grab touch-none select-none items-center gap-3 rounded-lg py-1 active:cursor-grabbing"
        >
          <GripVertical className="size-5 shrink-0 text-muted-foreground/50" aria-hidden="true" />
          <span
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40",
              field.visible ? "text-foreground/75" : "text-muted-foreground/60",
            )}
            aria-hidden="true"
          >
            <Icon className="size-5" />
          </span>
          <div className="min-w-0">
            <p
              className={cn(
                "truncate text-sm font-semibold leading-tight",
                !field.visible && "text-muted-foreground",
              )}
            >
              {t(field.label)}
            </p>
            {field.visible ? (
              <p className="mt-1 truncate text-xs leading-tight text-muted-foreground/80">
                {t("misc-tve2-section-visible")}
              </p>
            ) : (
              <Badge
                variant="outline"
                className="mt-1 h-5 border-dashed px-1.5 text-[10px] font-medium text-muted-foreground"
              >
                <EyeOff className="size-3" aria-hidden="true" />
                {t("misc-tve2-section-hidden")}
              </Badge>
            )}
          </div>
        </div>

        {/* Actions — always visible, generous hit areas */}
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge
            variant="secondary"
            title={t("misc-tve2-order-hint")}
            className="h-6 min-w-7 justify-center rounded-full px-2 text-xs font-semibold tabular-nums"
          >
            {index + 1}
          </Badge>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn("size-9 rounded-lg", field.visible ? "text-foreground" : "text-muted-foreground")}
            title={field.visible ? t("misc-tve-hide-field") : t("misc-tve-show-field")}
            aria-label={field.visible ? t("misc-tve-hide-field") : t("misc-tve-show-field")}
            aria-pressed={field.visible}
            onClick={onToggleVisible}
          >
            {field.visible ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 rounded-lg"
            title={t("misc-tve2-move-up")}
            aria-label={t("misc-tve2-move-up")}
            disabled={index <= 0}
            onClick={onMoveUp}
          >
            <ArrowUp className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 rounded-lg"
            title={t("misc-tve2-move-down")}
            aria-label={t("misc-tve2-move-down")}
            disabled={index >= total - 1}
            onClick={onMoveDown}
          >
            <ArrowDown className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Custom overlay card (text / image — absolute placement in mm)
// ============================================================

function OverlayCard({
  field,
  index,
  page,
  onUpdate,
  onUpdateProps,
  onToggleVisible,
  onDelete,
}: {
  field: FieldElement;
  index: number;
  page: { width: number; height: number };
  onUpdate: (updates: Partial<FieldElement>) => void;
  onUpdateProps: (props: Record<string, unknown>) => void;
  onToggleVisible: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const isText = field.type === "custom_text";
  const imageUrl = (field.props?.imageUrl as string) || "";
  const content = (field.props?.content as string) || "";
  const displayName =
    field.label || `${t(isText ? "misc-tve2-custom-text" : "misc-tve2-custom-image")} ${index + 1}`;
  const preview = isText ? content.replace(/\s+/g, " ").trim() : imageUrl;

  /** Clamp a geometry field to sane page bounds (mm). */
  const setGeo = (key: "x" | "y" | "width" | "height", raw: string) => {
    const n = Number(raw);
    const v = Number.isFinite(n) ? n : 0;
    const clamped =
      key === "x" ? Math.max(0, Math.min(page.width, v)) :
      key === "y" ? Math.max(0, Math.min(page.height, v)) :
      key === "width" ? Math.max(10, Math.min(page.width, v)) :
      Math.max(6, Math.min(page.height, v));
    onUpdate({ [key]: Math.round(clamped * 10) / 10 } as Partial<FieldElement>);
  };

  return (
    <div
      className={cn(
        "rounded-xl border bg-card p-4 shadow-xs",
        field.visible ? "border-border/70" : "border-dashed border-border/70 bg-muted/30 opacity-70",
      )}
    >
      {/* Header: icon + name + content preview + visibility + delete */}
      <div className="flex items-center gap-2.5">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40 text-foreground/75"
          aria-hidden="true"
        >
          {isText ? <Type className="size-4" /> : <ImageIcon className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium leading-tight">{displayName}</p>
          <p className="mt-0.5 truncate text-[11px] leading-tight text-muted-foreground/80">
            {preview || t(isText ? "misc-tve2-custom-text" : "misc-tve2-custom-image")}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn("size-8 rounded-lg", field.visible ? "text-foreground" : "text-muted-foreground")}
          title={field.visible ? t("misc-tve-hide-field") : t("misc-tve-show-field")}
          aria-label={field.visible ? t("misc-tve-hide-field") : t("misc-tve-show-field")}
          aria-pressed={field.visible}
          onClick={onToggleVisible}
        >
          {field.visible ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 rounded-lg text-muted-foreground hover:text-destructive"
          title={t("misc-tve2-remove")}
          aria-label={t("misc-tve2-remove")}
          onClick={onDelete}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>

      {/* Content editor */}
      {isText ? (
        <div className="mt-3 space-y-1.5">
          <Label htmlFor={`ov-content-${field.id}`} className="text-xs text-muted-foreground">
            {t("misc-tve2-content")}
          </Label>
          <Textarea
            id={`ov-content-${field.id}`}
            rows={3}
            value={content}
            onChange={(e) => onUpdateProps({ content: e.target.value })}
            className="text-sm"
          />
        </div>
      ) : (
        <div className="mt-3 space-y-1.5">
          <Label htmlFor={`ov-image-${field.id}`} className="text-xs text-muted-foreground">
            {t("misc-tve2-image-url")}
          </Label>
          <Input
            id={`ov-image-${field.id}`}
            value={imageUrl}
            onChange={(e) => onUpdateProps({ imageUrl: e.target.value })}
            placeholder="https://… or /uploads/…"
            className="text-sm"
          />
          {imageUrl ? (
            <div className="flex h-14 items-center justify-center rounded-lg border border-dashed bg-muted/20 p-1.5">
              <img
                src={imageUrl}
                alt={displayName}
                className="h-full max-w-full object-contain"
                draggable={false}
              />
            </div>
          ) : null}
        </div>
      )}

      {/* Geometry — real absolute placement honoured by the PDF */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">{t("misc-tve2-position")}</Label>
          <div className="grid grid-cols-2 gap-2">
            <Input
              type="number"
              min={0}
              max={page.width}
              value={Math.round(field.x)}
              onChange={(e) => setGeo("x", e.target.value)}
              aria-label="X (mm)"
            />
            <Input
              type="number"
              min={0}
              max={page.height}
              value={Math.round(field.y)}
              onChange={(e) => setGeo("y", e.target.value)}
              aria-label="Y (mm)"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">{t("misc-tve2-size")}</Label>
          <div className="grid grid-cols-2 gap-2">
            <Input
              type="number"
              min={10}
              max={page.width}
              value={Math.round(field.width)}
              onChange={(e) => setGeo("width", e.target.value)}
              aria-label={`${t("misc-tve2-size")} — W (mm)`}
            />
            <Input
              type="number"
              min={6}
              max={page.height}
              value={Math.round(field.height)}
              onChange={(e) => setGeo("height", e.target.value)}
              aria-label={`${t("misc-tve2-size")} — H (mm)`}
            />
          </div>
        </div>
      </div>
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
  const [overlaysOpen, setOverlaysOpen] = React.useState(true);

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

  // ── derived state ──────────────────────────────────────────────────
  const effectivePageSize: "A4" | "Letter" =
    pageSize ?? (template.page_size === "Letter" ? "Letter" : "A4");
  const page = PAGE_DIMENSIONS[effectivePageSize];

  // Ordered flow fields (sort by y — the same key the PDF renderer uses).
  const flowFields = React.useMemo(
    () => fields.filter((f) => FLOW_TYPES.has(f.type)).sort((a, b) => a.y - b.y),
    [fields]
  );
  const overlays = fields.filter((f) => f.type === "custom_text" || f.type === "custom_image");
  const logoField = fields.find((f) => f.type === "logo") ?? null;

  const companyName = getCompanyName(letterhead);
  const companyAddress = buildCompanyAddress(letterhead);
  const logoUrl = getLogoUrl(letterhead);

  // ---------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------

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

  /** dnd-kit reorder from the flow cards. */
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
  // Add / delete / reset (custom overlays)
  // ---------------------------------------------------------

  const addCustomText = () => {
    setOverlaysOpen(true);
    setFields((prev) => [
      ...prev,
      {
        id: `custom_text_${Date.now()}`,
        type: "custom_text",
        label: "",
        x: 40, y: 40, width: 90, height: 12,
        visible: true, locked: false,
        props: { content: "" },
      },
    ]);
  };

  const addCustomImage = () => {
    setOverlaysOpen(true);
    setFields((prev) => [
      ...prev,
      {
        id: `custom_image_${Date.now()}`,
        type: "custom_image",
        label: "",
        x: 60, y: 100, width: 50, height: 25,
        visible: true, locked: false,
        props: { imageUrl: null },
      },
    ]);
  };

  const deleteField = (id: string) => {
    setFields((prev) => prev.filter((f) => f.id !== id));
  };

  const resetLayout = () => {
    setFields(defaultFieldsFor(template.type));
  };

  // ---------------------------------------------------------
  // Render
  // ---------------------------------------------------------

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-sm">
      {/* ─── Editor header ─── */}
      <div className="shrink-0 border-b px-4 py-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold leading-tight">{t("misc-tve2-title")}</h3>
            <p className="mt-1 text-xs leading-snug text-muted-foreground">
              {t("misc-tve2-desc")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge
              variant="outline"
              className="hidden text-[10px] font-normal text-muted-foreground sm:inline-flex"
            >
              {effectivePageSize} · {page.width}×{page.height} mm
            </Badge>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={resetLayout}
              title={t("misc-tve-reset-layout")}
            >
              <RotateCcw className="size-3.5" />
              <span className="hidden md:inline">{t("misc-tve-reset-layout")}</span>
            </Button>
          </div>
        </div>
      </div>

      {/* ─── Locked page frame: header zone (owned by the memorandum) ─── */}
      <div className="shrink-0 space-y-1.5 border-b bg-muted/20 px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span
            className="flex size-8 shrink-0 items-center justify-center rounded-md border border-dashed bg-background text-muted-foreground/70"
            aria-hidden="true"
          >
            <Lock className="size-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("misc-tve2-header-zone")}
              </span>
              <Badge
                variant="outline"
                className="h-5 border-dashed px-1.5 text-[10px] font-normal text-muted-foreground"
              >
                {t("misc-tve2-locked-memo")}
              </Badge>
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground/80">
              {companyName}
              {companyAddress ? ` · ${companyAddress}` : ""}
            </p>
          </div>
          {/* Logo preview — the only editable bit (the PDF honours the
              layout_json logo eye-toggle). */}
          <div className="flex shrink-0 items-center gap-2 rounded-md border border-dashed bg-background px-2.5 py-1.5">
            {logoUrl ? (
              <img
                src={logoUrl}
                alt={t("misc-tve2-logo-zone")}
                className="h-6 max-w-24 object-contain"
                draggable={false}
              />
            ) : (
              <ImageIcon className="size-4 shrink-0 text-muted-foreground/50" aria-hidden="true" />
            )}
            <span className="hidden text-[10px] text-muted-foreground/80 lg:inline">
              {t("misc-tve2-logo-zone")}
            </span>
            {logoField ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  "size-7 rounded-md",
                  logoField.visible ? "text-foreground" : "text-muted-foreground",
                )}
                title={logoField.visible ? t("misc-tve-hide-field") : t("misc-tve-show-field")}
                aria-label={logoField.visible ? t("misc-tve-hide-field") : t("misc-tve-show-field")}
                aria-pressed={logoField.visible}
                onClick={() => updateField(logoField.id, { visible: !logoField.visible })}
              >
                {logoField.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
              </Button>
            ) : null}
          </div>
        </div>
        <p className="text-[11px] leading-snug text-muted-foreground/70">
          {t("misc-tve2-locked-memo-desc")}
        </p>
      </div>

      {/* ─── Scrollable controls: flow + overlays ─── */}
      <div className="custom-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-5 p-4">
          {/* Document flow — the star */}
          <section aria-label={t("misc-tve2-flow")}>
            <div className="mb-3 flex items-center gap-2 px-0.5">
              <h4 className="text-sm font-semibold">{t("misc-tve2-flow")}</h4>
              <Badge
                variant="secondary"
                className="h-5 rounded-full px-2 text-[10px] font-medium tabular-nums"
              >
                {flowFields.length}
              </Badge>
            </div>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={flowFields.map((f) => f.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="space-y-3">
                  {flowFields.map((f, i) => (
                    <SortableFlowCard
                      key={f.id}
                      field={f}
                      icon={SECTION_ICON[f.type] ?? FileText}
                      index={i}
                      total={flowFields.length}
                      onToggleVisible={() => updateField(f.id, { visible: !f.visible })}
                      onMoveUp={() => moveFlow(f.id, -1)}
                      onMoveDown={() => moveFlow(f.id, 1)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </section>

          {/* Custom overlays — free absolute placement (every PDF page) */}
          <section aria-label={t("misc-tve2-overlays")}>
            <div className="rounded-xl border bg-card shadow-xs">
              <button
                type="button"
                className="flex w-full items-center gap-2.5 rounded-xl px-4 py-3 text-left transition-colors hover:bg-muted/40"
                onClick={() => setOverlaysOpen((open) => !open)}
                aria-expanded={overlaysOpen}
              >
                {overlaysOpen ? (
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                ) : (
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                )}
                <h4 className="text-sm font-semibold">{t("misc-tve2-overlays")}</h4>
                <Badge
                  variant="secondary"
                  className="h-5 rounded-full px-2 text-[10px] font-medium tabular-nums"
                >
                  {overlays.length}
                </Badge>
              </button>
              {overlaysOpen ? (
                <div className="space-y-3 border-t px-4 py-4">
                  <p className="text-xs leading-snug text-muted-foreground">
                    {t("misc-tve2-overlays-desc")}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={addCustomText}>
                      <Type className="size-3.5" />
                      {t("misc-tve2-add-text")}
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={addCustomImage}>
                      <ImageIcon className="size-3.5" />
                      {t("misc-tve2-add-image")}
                    </Button>
                  </div>
                  {overlays.length === 0 ? (
                    <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-5 text-center text-xs text-muted-foreground">
                      {t("misc-tve2-empty-overlays")}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {overlays.map((f, i) => (
                        <OverlayCard
                          key={f.id}
                          field={f}
                          index={i}
                          page={page}
                          onUpdate={(updates) => updateField(f.id, updates)}
                          onUpdateProps={(props) => updateFieldProps(f.id, props)}
                          onToggleVisible={() => updateField(f.id, { visible: !f.visible })}
                          onDelete={() => deleteField(f.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </div>

      {/* ─── Locked page frame: footer zone (owned by the memorandum) ─── */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t bg-muted/20 px-4 py-3">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-md border border-dashed bg-background text-muted-foreground/70"
          aria-hidden="true"
        >
          <Lock className="size-3.5" />
        </span>
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("misc-tve2-footer-zone")}
        </span>
        <Badge
          variant="outline"
          className="h-5 border-dashed px-1.5 text-[10px] font-normal text-muted-foreground"
        >
          {t("misc-tve2-locked-memo")}
        </Badge>
      </div>
    </div>
  );
}
