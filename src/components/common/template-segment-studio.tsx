"use client";

/**
 * TemplateSegmentStudio (audit22 "UI-A") — Word-grade header/footer editor.
 *
 * Replaces the old TemplateContentEditor for header/footer_content editing.
 * Three-pane layout:
 *
 *   LEFT   — segment list (add text / spacer, reorder, duplicate, delete)
 *   CENTER — WYSIWYG paper preview. Every paragraph is rendered through the
 *            SAME normalizeSegment() the react-pdf renderer uses
 *            (src/lib/utils/content-config.ts), so preview == PDF by
 *            construction. Unreplaced {tokens} are highlighted in amber.
 *   RIGHT  — properties inspector with Text / Spacing / Style tabs.
 *
 * Serialization contract (unchanged from the old editor):
 *   JSON.stringify({ segments, ...(_qrConfig if present) })
 * The reserved `_qrConfig` sub-key (footer QR placement) is extracted on
 * parse and re-emitted on every change so it is never lost.
 */

import * as React from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronDown,
  ChevronUp,
  Copy,
  GripVertical,
  Italic,
  Plus,
  RotateCcw,
  SquareDashed,
  Strikethrough,
  Trash2,
  Type,
  Underline,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/lib/i18n/store";
import {
  DEFAULT_FOOTER_CONTENT_JSON,
  DEFAULT_HEADER_CONTENT_JSON,
  SEGMENT_FONTS,
  newSegmentId,
  normalizeSegment,
  parseContentConfig,
  substitutePlaceholders,
  type ContentSegment,
  type NormalizedSegment,
  type PlaceholderData,
  type SegmentBorder,
} from "@/lib/utils/content-config";

// ── Unit conversion (browser preview only) ──────────────────────────────────
const PT_TO_PX = 1.333; // 1pt  = 1.333 CSS px (96/72)
const MM_TO_PX = 3.78; //  1mm  ≈ 3.78 CSS px (96/25.4)

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const TOKEN_RE = /\{[a-zA-Z0-9_]+\}/;

/** Expand a 3-digit hex to 6 digits — <input type="color"> only accepts #rrggbb. */
function expandHex(hex: string): string {
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`.toLowerCase();
  }
  return hex.toLowerCase();
}

/** Font families exposed by the Select (values are react-pdf family names). */
type SegmentFontValue = (typeof SEGMENT_FONTS)[number]["value"];

// ── Public API ──────────────────────────────────────────────────────────────

export interface SegmentStudioVariable {
  /** Placeholder token without braces, e.g. "company_name". */
  token: string;
  /** i18n key for the chip label. */
  label: string;
}

export interface TemplateSegmentStudioProps {
  /** Raw header_content / footer_content JSON string ("" allowed). */
  contentJson: string;
  /** Emits the FULL new JSON string on every change. */
  onChange: (json: string) => void;
  kind: "header" | "footer";
  /** Variables palette for the token chips — label is an i18n key. */
  variables: SegmentStudioVariable[];
  /** Placeholder data for live preview substitution (sample data OK). */
  previewData?: Record<string, string>;
  /** Body font family from the template for default font resolution. */
  bodyFontFamily?: string;
}

// ── Parse / serialize (same conventions as the old editor + _qrConfig) ──────

/** Reserved footer QR placement config — opaque here, preserved verbatim. */
type QrConfig = Record<string, unknown>;

interface StudioParseResult {
  segments: ContentSegment[];
  qr: QrConfig | null;
}

function parseStudio(contentJson: string): StudioParseResult {
  if (!contentJson) return { segments: [], qr: null };
  try {
    const parsed: unknown = JSON.parse(contentJson);
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { segments?: unknown }).segments)
    ) {
      const obj = parsed as { segments: ContentSegment[]; _qrConfig?: unknown };
      const qr =
        obj._qrConfig && typeof obj._qrConfig === "object"
          ? (obj._qrConfig as QrConfig)
          : null;
      return { segments: obj.segments, qr };
    }
  } catch {
    // Not valid JSON — fall through, parseContentConfig wraps plain text.
  }
  const cfg = parseContentConfig(contentJson);
  return { segments: cfg.segments, qr: null };
}

function serializeStudio(segments: ContentSegment[], qr: QrConfig | null): string {
  return qr
    ? JSON.stringify({ segments, _qrConfig: qr })
    : JSON.stringify({ segments });
}

// ── Preview helpers (mirror the react-pdf SegmentText renderer) ─────────────

/**
 * CSS font stack for a react-pdf family value. Mirrors the PDF renderer's
 * resolution: an explicit Times/Courier segment keeps its family, everything
 * else (incl. unset) resolves through the template body font — sans stacks
 * land on Noto Sans, just like resolveFontFamily() maps them to "NotoSans".
 */
function cssFontStack(family: string, bodyFontFamily?: string): string {
  const effective =
    family === "Times-Roman" || family === "Courier"
      ? family
      : bodyFontFamily ?? "NotoSans";
  if (effective === "Times-Roman" || /times|serif|georgia|garamond/i.test(effective)) {
    return "'Times New Roman', Times, serif";
  }
  if (effective === "Courier" || /courier|mono/i.test(effective)) {
    return "'Courier New', Courier, monospace";
  }
  return "'Noto Sans', sans-serif";
}

/** Paragraph chrome present? (identical predicate to the PDF SegmentText) */
function segmentHasChrome(s: NormalizedSegment): boolean {
  return (
    s.spacingBefore > 0 ||
    s.spacingAfter > 0 ||
    !!s.bgColor ||
    s.paddingY > 0 ||
    s.paddingX > 0 ||
    s.border !== false ||
    s.borderBottom !== false ||
    s.borderRadius > 0
  );
}

/** Substituted preview text with unreplaced {tokens} split into spans. */
function renderPreviewText(text: string, phData: PlaceholderData): React.ReactNode[] {
  const substituted = substitutePlaceholders(text, phData);
  const parts = substituted.split(/(\{[a-zA-Z0-9_]+\})/g);
  return parts.map((part, i) =>
    TOKEN_RE.test(part) ? (
      <span key={i} className="rounded-sm bg-amber-200/60 px-0.5">
        {part}
      </span>
    ) : (
      <React.Fragment key={i}>{part}</React.Fragment>
    ),
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

interface SegmentPreviewParagraphProps {
  seg: ContentSegment;
  selected: boolean;
  phData: PlaceholderData;
  bodyFontFamily?: string;
  spacerLabel: string;
  onSelect: () => void;
}

/**
 * One paragraph inside the paper preview. All values come from
 * normalizeSegment(seg) — the same normalizer the PDF renderer runs —
 * so what the user sees here is what the PDF prints.
 */
function SegmentPreviewParagraph({
  seg,
  selected,
  phData,
  bodyFontFamily,
  spacerLabel,
  onSelect,
}: SegmentPreviewParagraphProps) {
  const s = normalizeSegment(seg);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    }
  };

  // Empty text + no chrome → Word-style spacer paragraph (3mm in the PDF).
  if (!s.text && !segmentHasChrome(s)) {
    return (
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={onSelect}
        onKeyDown={handleKeyDown}
        className={cn(
          "flex cursor-pointer select-none items-center justify-center rounded-[2px] border border-dashed border-border py-1.5 transition-shadow",
          "outline-none focus-visible:ring-2 focus-visible:ring-ring",
          selected ? "ring-1 ring-primary/50" : "hover:ring-1 hover:ring-primary/25",
        )}
        style={{ minHeight: 3 * MM_TO_PX }}
      >
        <span className="sr-only">{spacerLabel}</span>
        <span
          aria-hidden="true"
          className="text-[10px] font-medium leading-none text-muted-foreground/70"
        >
          {spacerLabel}
        </span>
      </div>
    );
  }

  const style: React.CSSProperties = {
    boxSizing: "border-box",
    // Paragraph chrome — only set what the segment carries (same conditionals
    // as the PDF wrapper View, so the base vertical rhythm stays identical).
    ...(s.spacingBefore > 0 ? { marginTop: `${(s.spacingBefore * MM_TO_PX).toFixed(2)}px` } : {}),
    ...(s.spacingAfter > 0 ? { marginBottom: `${(s.spacingAfter * MM_TO_PX).toFixed(2)}px` } : {}),
    ...(s.bgColor ? { backgroundColor: s.bgColor } : {}),
    ...(s.paddingY > 0
      ? {
          paddingTop: `${(s.paddingY * MM_TO_PX).toFixed(2)}px`,
          paddingBottom: `${(s.paddingY * MM_TO_PX).toFixed(2)}px`,
        }
      : {}),
    ...(s.paddingX > 0
      ? {
          paddingLeft: `${(s.paddingX * MM_TO_PX).toFixed(2)}px`,
          paddingRight: `${(s.paddingX * MM_TO_PX).toFixed(2)}px`,
        }
      : {}),
    ...(s.border
      ? {
          border: `${(s.border.width * PT_TO_PX).toFixed(2)}px ${s.border.style} ${s.border.color}`,
        }
      : {}),
    ...(s.borderBottom
      ? {
          borderBottom: `${(s.borderBottom.width * PT_TO_PX).toFixed(2)}px ${s.borderBottom.style} ${s.borderBottom.color}`,
        }
      : {}),
    ...(s.borderRadius > 0 ? { borderRadius: `${(s.borderRadius * PT_TO_PX).toFixed(2)}px` } : {}),
    // Typography (pt → px at 1.333).
    fontFamily: cssFontStack(s.fontFamily, bodyFontFamily),
    fontSize: `${(s.fontSize * PT_TO_PX).toFixed(2)}px`,
    fontWeight: s.bold ? 700 : 400,
    fontStyle: s.italic ? "italic" : "normal",
    ...(s.underline && s.strike
      ? { textDecoration: "underline line-through" }
      : s.underline
        ? { textDecoration: "underline" }
        : s.strike
          ? { textDecoration: "line-through" }
          : {}),
    color: s.color,
    textAlign: s.alignment,
    ...(s.textTransform !== "none" ? { textTransform: s.textTransform } : {}),
    ...(s.letterSpacing !== 0
      ? { letterSpacing: `${(s.letterSpacing * PT_TO_PX).toFixed(2)}px` }
      : {}),
    lineHeight: s.lineHeight,
    ...(s.opacity < 1 ? { opacity: s.opacity } : {}),
    // Empty text WITH chrome still occupies one line of its own height.
    ...(!s.text ? { minHeight: `${(s.fontSize * PT_TO_PX * s.lineHeight).toFixed(2)}px` } : {}),
    overflowWrap: "break-word",
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      className={cn(
        "cursor-pointer select-none whitespace-pre-wrap rounded-[2px] transition-shadow",
        "outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "ring-1 ring-primary/50" : "hover:ring-1 hover:ring-primary/25",
      )}
      style={style}
    >
      {s.text ? renderPreviewText(s.text, phData) : null}
    </div>
  );
}

/** Label + slider + tabular-nums value badge (the Spacing tab workhorse). */
function SliderRow({
  label,
  value,
  min,
  max,
  step,
  unit,
  decimals = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  decimals?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
        <Badge variant="secondary" className="font-normal tabular-nums">
          {value.toFixed(decimals)}
          {unit ? ` ${unit}` : ""}
        </Badge>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        aria-label={label}
        onValueChange={(vals) => {
          const v = vals[0];
          if (typeof v === "number") onChange(v);
        }}
      />
    </div>
  );
}

/** Color swatch input + hex text input side by side, optional clear button. */
function ColorField({
  label,
  value,
  swatchFallback,
  onChange,
  onClear,
  clearLabel,
}: {
  label: string;
  /** Current hex; "" = transparent (bgColor). */
  value: string;
  /** Swatch shown while the draft is not a valid hex (or value is ""). */
  swatchFallback: string;
  onChange: (hex: string) => void;
  onClear?: () => void;
  clearLabel?: string;
}) {
  const [draft, setDraft] = React.useState(value);

  React.useEffect(() => {
    // Sync the draft when the committed value changes externally
    // (segment switch, reset, …). Typing never triggers this — only valid
    // hexes are committed, and those match the draft already.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(value);
  }, [value]);

  const commitValid = (raw: string) => {
    const v = raw.trim();
    setDraft(v);
    if (HEX_RE.test(v)) onChange(v.toLowerCase());
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
        {onClear && clearLabel ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground"
            onClick={onClear}
            title={clearLabel}
          >
            <X className="size-3" aria-hidden="true" />
            {clearLabel}
          </Button>
        ) : null}
      </div>
      <div className="flex items-center gap-1.5">
        <Input
          type="color"
          className="h-9 w-11 shrink-0 cursor-pointer p-1"
          value={HEX_RE.test(draft) ? expandHex(draft) : swatchFallback}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
        />
        <Input
          className="h-9 font-mono text-xs"
          value={draft}
          onChange={(e) => commitValid(e.target.value)}
          onBlur={() => setDraft(value)}
          placeholder="#666666"
          maxLength={7}
          spellCheck={false}
        />
      </div>
    </div>
  );
}

/** B / I / U / S / alignment icon toggle (h-11 touch target, Word-ribbon look). */
function FormatButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant={active ? "default" : "outline"}
      className="h-11 w-full"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
    >
      {children}
    </Button>
  );
}

/** Full-box or bottom-only border editor (enable Switch + color/width/style). */
function BorderEditor({
  title,
  border,
  onChange,
}: {
  title: string;
  border: SegmentBorder | false;
  onChange: (b: SegmentBorder | false) => void;
}) {
  const t = useT();
  const enabled = border !== false;
  const b: SegmentBorder = border || { color: "#d1d5db", width: 0.5, style: "solid" };

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs font-medium">{title}</Label>
        <Switch
          checked={enabled}
          onCheckedChange={(on) => onChange(on ? { ...b } : false)}
          aria-label={title}
        />
      </div>
      {enabled ? (
        <div className="space-y-3">
          <ColorField
            label={t("tstudio-color")}
            value={b.color}
            swatchFallback="#d1d5db"
            onChange={(hex) => onChange({ ...b, color: hex })}
          />
          <SliderRow
            label={t("tstudio-border-width")}
            value={b.width}
            min={0.25}
            max={6}
            step={0.25}
            unit="pt"
            decimals={2}
            onChange={(v) => onChange({ ...b, width: v })}
          />
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">
              {t("tstudio-border-style")}
            </Label>
            <Select
              value={b.style ?? "solid"}
              onValueChange={(v) => onChange({ ...b, style: v as NonNullable<SegmentBorder["style"]> })}
            >
              <SelectTrigger className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="solid">{t("tstudio-solid")}</SelectItem>
                <SelectItem value="dashed">{t("tstudio-dashed")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

interface StudioState {
  segments: ContentSegment[];
  qr: QrConfig | null;
  selectedId: string | null;
}

function initialStudioState(contentJson: string): StudioState {
  const { segments, qr } = parseStudio(contentJson);
  return { segments, qr, selectedId: segments[0]?.id ?? null };
}

export function TemplateSegmentStudio({
  contentJson,
  onChange,
  kind,
  variables,
  previewData,
  bodyFontFamily,
}: TemplateSegmentStudioProps) {
  const t = useT();
  const [state, setState] = React.useState<StudioState>(() => initialStudioState(contentJson));
  const [tab, setTab] = React.useState<string>("text");
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  /** Last JSON this component emitted — guards the parse effect from echoes. */
  const lastEmittedRef = React.useRef<string | null>(null);

  // Re-parse ONLY when the parent swaps the content (different template
  // selected, reset from outside, …). Our own emissions are ignored so the
  // parse never fights the local edits.
  React.useEffect(() => {
    if (contentJson === lastEmittedRef.current) return;
    const parsed = parseStudio(contentJson);
    setState((prev) => ({
      segments: parsed.segments,
      qr: parsed.qr,
      selectedId: parsed.segments.some((seg) => seg.id === prev.selectedId)
        ? prev.selectedId
        : (parsed.segments[0]?.id ?? null),
    }));
  }, [contentJson]);

  // Placeholder data typed for the shared substitution engine. Only string
  // fields are meaningful in the preview; page counters arrive as strings.
  const phData = React.useMemo<PlaceholderData>(() => {
    const out: PlaceholderData = {};
    for (const [key, value] of Object.entries(previewData ?? {})) {
      if (key === "page_number" || key === "total_pages") {
        const n = Number(value);
        if (Number.isFinite(n)) out[key] = n;
      } else if (typeof value === "string") {
        Object.assign(out, { [key]: value });
      }
    }
    return out;
  }, [previewData]);

  const { segments } = state;
  const selected =
    segments.find((seg) => seg.id === state.selectedId) ?? segments[0] ?? null;
  const selectedIndex = selected ? segments.findIndex((seg) => seg.id === selected.id) : -1;
  const s = selected ? normalizeSegment(selected) : null;

  const kindLabel = t(kind === "header" ? "tstudio-header" : "tstudio-footer");

  // ── State mutations (every one re-serializes + emits) ────────────────────

  const commit = (nextSegments: ContentSegment[], nextSelectedId?: string | null) => {
    const json = serializeStudio(nextSegments, state.qr);
    lastEmittedRef.current = json;
    setState({
      segments: nextSegments,
      qr: state.qr,
      selectedId: nextSelectedId === undefined ? state.selectedId : nextSelectedId,
    });
    onChange(json);
  };

  const selectSegment = (id: string) => {
    setState((prev) => (prev.selectedId === id ? prev : { ...prev, selectedId: id }));
  };

  const updateSelected = (partial: Partial<ContentSegment>) => {
    if (!selected) return;
    commit(segments.map((seg) => (seg.id === selected.id ? { ...seg, ...partial } : seg)));
  };

  const addSegment = (focusEditor: boolean) => {
    const seg: ContentSegment = {
      id: newSegmentId(),
      text: "",
      fontSize: kind === "header" ? 12 : 8,
      bold: false,
      italic: false,
      color: "#666666",
      alignment: "left",
    };
    commit([...segments, seg], seg.id);
    if (focusEditor) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  };

  const moveSegment = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= segments.length) return;
    const next = [...segments];
    [next[index], next[target]] = [next[target], next[index]];
    commit(next);
  };

  const duplicateSegment = (index: number) => {
    const copy: ContentSegment = { ...segments[index], id: newSegmentId() };
    commit([...segments.slice(0, index + 1), copy, ...segments.slice(index + 1)], copy.id);
  };

  const removeSegment = (index: number) => {
    const id = segments[index].id;
    const next = segments.filter((_, i) => i !== index);
    const nextSelected =
      state.selectedId === id
        ? (next[Math.min(index, next.length - 1)]?.id ?? null)
        : state.selectedId;
    commit(next, nextSelected);
  };

  const resetToDefault = () => {
    const def = parseContentConfig(
      kind === "header" ? DEFAULT_HEADER_CONTENT_JSON : DEFAULT_FOOTER_CONTENT_JSON,
    );
    // Only the segments are restored — _qrConfig (footer QR placement)
    // survives via state.qr in commit().
    commit(def.segments, def.segments[0]?.id ?? null);
  };

  /** Insert a {token} at the textarea cursor (falls back to append). */
  const insertToken = (token: string) => {
    if (!selected) return;
    const tokenText = `{${token}}`;
    const text = selected.text;
    const el = textareaRef.current;
    if (!el) {
      updateSelected({ text: text + tokenText });
      return;
    }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? start;
    updateSelected({ text: text.slice(0, start) + tokenText + text.slice(end) });
    const caret = start + tokenText.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Type className="size-4" aria-hidden="true" />
        </div>
        <h3 className="truncate text-sm font-semibold leading-none">{t("tstudio-title")}</h3>
        <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
          {kindLabel}
        </Badge>
        <Badge variant="secondary" className="text-[10px] tabular-nums">
          {t("tstudio-segments-count").replace("{n}", String(segments.length))}
        </Badge>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto h-9 gap-1.5 whitespace-nowrap"
          onClick={resetToDefault}
          title={t("tstudio-reset")}
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          {t("tstudio-reset")}
        </Button>
      </div>

      {/* Three-pane body */}
      <div className="grid grid-cols-1 lg:h-[540px] lg:grid-cols-[200px_1fr_300px]">
        {/* ── LEFT: segment list ── */}
        <aside className="flex h-56 flex-col border-b lg:h-full lg:border-b-0 lg:border-r">
          <div className="grid grid-cols-2 gap-1.5 border-b p-2">
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1 px-2 text-xs"
              onClick={() => addSegment(true)}
            >
              <Plus className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{t("tstudio-add-text")}</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1 px-2 text-xs"
              onClick={() => addSegment(false)}
            >
              <SquareDashed className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{t("tstudio-add-spacer")}</span>
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-1.5 p-2">
              {segments.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                  {t("tstudio-empty")}
                </p>
              ) : (
                segments.map((seg, idx) => {
                  const ns = normalizeSegment(seg);
                  const isSelected = selected?.id === seg.id;
                  const isSpacer = !ns.text && !segmentHasChrome(ns);
                  const firstLine = ns.text.split(/\r?\n/, 1)[0] ?? "";
                  return (
                    <div
                      key={seg.id}
                      className={cn(
                        "rounded-lg border p-1.5 transition-colors",
                        isSelected
                          ? "border-primary/40 bg-primary/10"
                          : "border-transparent hover:border-border hover:bg-muted/50",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => selectSegment(seg.id)}
                        aria-pressed={isSelected}
                        className="flex w-full items-center gap-1.5 rounded-md px-1 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <GripVertical
                          className="size-3.5 shrink-0 text-muted-foreground/50"
                          aria-hidden="true"
                        />
                        {isSpacer ? (
                          <span className="min-w-0 flex-1 truncate text-xs italic text-muted-foreground">
                            — {t("tstudio-spacer")} —
                          </span>
                        ) : (
                          <span
                            className="min-w-0 flex-1 truncate"
                            style={{
                              fontSize: `${Math.min(13, Math.max(9, ns.fontSize))}px`,
                              fontWeight: ns.bold ? 700 : 400,
                              fontStyle: ns.italic ? "italic" : "normal",
                              color: ns.color,
                              textDecoration:
                                ns.underline && ns.strike
                                  ? "underline line-through"
                                  : ns.underline
                                    ? "underline"
                                    : ns.strike
                                      ? "line-through"
                                      : undefined,
                            }}
                          >
                            {firstLine || "\u00A0"}
                          </span>
                        )}
                      </button>
                      <div className="mt-1 flex items-center justify-between gap-1">
                        <div className="flex gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-9"
                            disabled={idx === 0}
                            onClick={() => moveSegment(idx, -1)}
                            title={t("tstudio-move-up")}
                            aria-label={t("tstudio-move-up")}
                          >
                            <ChevronUp className="size-4" aria-hidden="true" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-9"
                            disabled={idx === segments.length - 1}
                            onClick={() => moveSegment(idx, 1)}
                            title={t("tstudio-move-down")}
                            aria-label={t("tstudio-move-down")}
                          >
                            <ChevronDown className="size-4" aria-hidden="true" />
                          </Button>
                        </div>
                        <div className="flex gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-9"
                            onClick={() => duplicateSegment(idx)}
                            title={t("tstudio-duplicate")}
                            aria-label={t("tstudio-duplicate")}
                          >
                            <Copy className="size-4" aria-hidden="true" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-9 text-destructive hover:text-destructive"
                            onClick={() => removeSegment(idx)}
                            title={t("tstudio-delete")}
                            aria-label={t("tstudio-delete")}
                          >
                            <Trash2 className="size-4" aria-hidden="true" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </aside>

        {/* ── CENTER: live WYSIWYG preview ── */}
        <section className="flex h-96 flex-col bg-muted/30 lg:h-full">
          <div className="flex items-center border-b px-3 py-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("tstudio-preview")}
            </span>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-4">
              <div className="mx-auto min-h-[380px] w-full max-w-[340px] rounded-lg bg-white p-6 shadow-sm ring-1 ring-black/5">
                {segments.length === 0 ? (
                  <p className="py-16 text-center text-xs text-neutral-400">
                    {t("tstudio-empty")}
                  </p>
                ) : (
                  segments.map((seg) => (
                    <SegmentPreviewParagraph
                      key={seg.id}
                      seg={seg}
                      selected={selected?.id === seg.id}
                      phData={phData}
                      bodyFontFamily={bodyFontFamily}
                      spacerLabel={t("tstudio-spacer")}
                      onSelect={() => selectSegment(seg.id)}
                    />
                  ))
                )}
              </div>
            </div>
          </ScrollArea>
        </section>

        {/* ── RIGHT: properties inspector ── */}
        <aside className="flex h-[30rem] flex-col border-t lg:h-full lg:border-t-0 lg:border-l">
          {selected && s ? (
            <>
              <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                <span className="truncate text-xs font-medium text-muted-foreground">
                  {t("tstudio-selected")}
                </span>
                <Badge variant="secondary" className="tabular-nums text-[10px]">
                  {selectedIndex + 1} / {segments.length}
                </Badge>
              </div>
              <Tabs
                value={tab}
                onValueChange={setTab}
                className="flex min-h-0 flex-1 flex-col gap-0"
              >
                <div className="border-b p-2">
                  <TabsList className="grid w-full grid-cols-3">
                    <TabsTrigger value="text" className="text-xs">
                      {t("tstudio-tab-text")}
                    </TabsTrigger>
                    <TabsTrigger value="spacing" className="text-xs">
                      {t("tstudio-tab-spacing")}
                    </TabsTrigger>
                    <TabsTrigger value="style" className="text-xs">
                      {t("tstudio-tab-style")}
                    </TabsTrigger>
                  </TabsList>
                </div>

                {/* ── Text tab ── */}
                <TabsContent value="text" className="min-h-0 flex-1">
                  <ScrollArea className="h-full">
                    <div className="space-y-4 p-3">
                      <div className="space-y-1.5">
                        <Label
                          htmlFor="tstudio-content-input"
                          className="text-xs font-medium"
                        >
                          {t("tstudio-content")}
                        </Label>
                        <Textarea
                          id="tstudio-content-input"
                          ref={textareaRef}
                          rows={4}
                          className="min-h-[88px] resize-y text-sm"
                          value={selected.text}
                          onChange={(e) => updateSelected({ text: e.target.value })}
                          placeholder="{company_name}"
                        />
                      </div>

                      {variables.length > 0 ? (
                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium text-muted-foreground">
                            {t("tstudio-insert-token")}
                          </Label>
                          <div className="flex flex-wrap gap-1.5">
                            {variables.map((v) => (
                              <button
                                key={v.token}
                                type="button"
                                title={`{${v.token}}`}
                                onClick={() => insertToken(v.token)}
                                className="h-9 rounded-md border bg-background px-2.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                {t(v.label)}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      <Separator />

                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium">{t("tstudio-font")}</Label>
                          <Select
                            value={s.fontFamily}
                            onValueChange={(v) =>
                              updateSelected({ fontFamily: v as SegmentFontValue })
                            }
                          >
                            <SelectTrigger className="h-9 w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {SEGMENT_FONTS.map((f) => (
                                <SelectItem key={f.value} value={f.value}>
                                  {f.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1.5">
                          <Label
                            htmlFor="tstudio-size-input"
                            className="text-xs font-medium"
                          >
                            {t("tstudio-size")}
                          </Label>
                          <Input
                            id="tstudio-size-input"
                            type="number"
                            min={4}
                            max={42}
                            step={0.5}
                            className="h-9 tabular-nums"
                            value={selected.fontSize ?? 9}
                            onChange={(e) => {
                              // Raw commit — normalizeSegment clamps for the
                              // preview AND the PDF (4–42), so junk degrades
                              // safely instead of fighting the keystrokes.
                              if (e.target.value === "") return;
                              const n = Number(e.target.value);
                              if (Number.isFinite(n)) updateSelected({ fontSize: n });
                            }}
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-4 gap-1.5">
                        <FormatButton
                          active={s.bold}
                          label={t("tstudio-bold")}
                          onClick={() => updateSelected({ bold: !s.bold })}
                        >
                          <Bold className="size-4" aria-hidden="true" />
                        </FormatButton>
                        <FormatButton
                          active={s.italic}
                          label={t("tstudio-italic")}
                          onClick={() => updateSelected({ italic: !s.italic })}
                        >
                          <Italic className="size-4" aria-hidden="true" />
                        </FormatButton>
                        <FormatButton
                          active={s.underline}
                          label={t("tstudio-underline")}
                          onClick={() => updateSelected({ underline: !s.underline })}
                        >
                          <Underline className="size-4" aria-hidden="true" />
                        </FormatButton>
                        <FormatButton
                          active={s.strike}
                          label={t("tstudio-strike")}
                          onClick={() => updateSelected({ strike: !s.strike })}
                        >
                          <Strikethrough className="size-4" aria-hidden="true" />
                        </FormatButton>
                      </div>

                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium text-muted-foreground">
                          {t("tstudio-align")}
                        </Label>
                        <div className="grid grid-cols-3 gap-1.5">
                          <FormatButton
                            active={s.alignment === "left"}
                            label={t("tstudio-align-left")}
                            onClick={() => updateSelected({ alignment: "left" })}
                          >
                            <AlignLeft className="size-4" aria-hidden="true" />
                          </FormatButton>
                          <FormatButton
                            active={s.alignment === "center"}
                            label={t("tstudio-align-center")}
                            onClick={() => updateSelected({ alignment: "center" })}
                          >
                            <AlignCenter className="size-4" aria-hidden="true" />
                          </FormatButton>
                          <FormatButton
                            active={s.alignment === "right"}
                            label={t("tstudio-align-right")}
                            onClick={() => updateSelected({ alignment: "right" })}
                          >
                            <AlignRight className="size-4" aria-hidden="true" />
                          </FormatButton>
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium">
                          {t("tstudio-transform")}
                        </Label>
                        <Select
                          value={s.textTransform}
                          onValueChange={(v) =>
                            updateSelected({
                              textTransform: v as NonNullable<ContentSegment["textTransform"]>,
                            })
                          }
                        >
                          <SelectTrigger className="h-9 w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">{t("tstudio-none")}</SelectItem>
                            <SelectItem value="uppercase">{t("tstudio-upper")}</SelectItem>
                            <SelectItem value="lowercase">{t("tstudio-lower")}</SelectItem>
                            <SelectItem value="capitalize">
                              {t("tstudio-capitalize")}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <ColorField
                        label={t("tstudio-color")}
                        value={s.color}
                        swatchFallback="#666666"
                        onChange={(hex) => updateSelected({ color: hex })}
                      />

                      <ColorField
                        label={t("tstudio-bg")}
                        value={s.bgColor}
                        swatchFallback="#ffffff"
                        onChange={(hex) => updateSelected({ bgColor: hex })}
                        onClear={() => updateSelected({ bgColor: "" })}
                        clearLabel={t("tstudio-clear")}
                      />
                    </div>
                  </ScrollArea>
                </TabsContent>

                {/* ── Spacing tab — "razmak između tekstova" ── */}
                <TabsContent value="spacing" className="min-h-0 flex-1">
                  <ScrollArea className="h-full">
                    <div className="space-y-4 p-3">
                      <SliderRow
                        label={t("tstudio-spacing-before")}
                        value={s.spacingBefore}
                        min={0}
                        max={30}
                        step={0.5}
                        unit="mm"
                        onChange={(v) => updateSelected({ spacingBefore: v })}
                      />
                      <SliderRow
                        label={t("tstudio-spacing-after")}
                        value={s.spacingAfter}
                        min={0}
                        max={30}
                        step={0.5}
                        unit="mm"
                        onChange={(v) => updateSelected({ spacingAfter: v })}
                      />
                      <SliderRow
                        label={t("tstudio-line-height")}
                        value={s.lineHeight}
                        min={0.8}
                        max={3}
                        step={0.05}
                        decimals={2}
                        onChange={(v) => updateSelected({ lineHeight: v })}
                      />
                      <SliderRow
                        label={t("tstudio-letter-spacing")}
                        value={s.letterSpacing}
                        min={-1.5}
                        max={5}
                        step={0.1}
                        unit="pt"
                        onChange={(v) => updateSelected({ letterSpacing: v })}
                      />
                      <Separator />
                      <SliderRow
                        label={t("tstudio-pad-x")}
                        value={s.paddingX}
                        min={0}
                        max={10}
                        step={0.5}
                        unit="mm"
                        onChange={(v) => updateSelected({ paddingX: v })}
                      />
                      <SliderRow
                        label={t("tstudio-pad-y")}
                        value={s.paddingY}
                        min={0}
                        max={10}
                        step={0.5}
                        unit="mm"
                        onChange={(v) => updateSelected({ paddingY: v })}
                      />
                      <Separator />
                      <SliderRow
                        label={t("tstudio-opacity")}
                        value={s.opacity}
                        min={0.1}
                        max={1}
                        step={0.05}
                        decimals={2}
                        onChange={(v) => updateSelected({ opacity: v })}
                      />
                    </div>
                  </ScrollArea>
                </TabsContent>

                {/* ── Style tab ── */}
                <TabsContent value="style" className="min-h-0 flex-1">
                  <ScrollArea className="h-full">
                    <div className="space-y-3 p-3">
                      <BorderEditor
                        title={t("tstudio-border")}
                        border={s.border}
                        onChange={(b) => updateSelected({ border: b })}
                      />
                      <BorderEditor
                        title={t("tstudio-border-bottom")}
                        border={s.borderBottom}
                        onChange={(b) => updateSelected({ borderBottom: b })}
                      />
                      <div className="rounded-lg border p-3">
                        <SliderRow
                          label={t("tstudio-radius")}
                          value={s.borderRadius}
                          min={0}
                          max={12}
                          step={0.5}
                          unit="pt"
                          onChange={(v) => updateSelected({ borderRadius: v })}
                        />
                      </div>
                    </div>
                  </ScrollArea>
                </TabsContent>
              </Tabs>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-6">
              <p className="text-center text-xs text-muted-foreground">
                {t("tstudio-no-segment")}
              </p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
