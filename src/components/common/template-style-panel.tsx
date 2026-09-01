"use client";

/**
 * TemplateStylePanel (audit22 "UI-B") — document body & table styling panel
 * for the Template Studio.
 *
 * Edits the document_templates.style_json object (migration 082): document
 * title treatment, the line-items TABLE STUDIO (header row, cells, grid,
 * live column-width editor), party boxes, totals block, notice box and body
 * colours. Everything the user changes here is read back by the PDF renderer
 * through parseStyleConfig() (src/lib/utils/style-config.ts) — the shared
 * engine, so the panel is WYSIWYG by construction.
 *
 * Raw-partial model (IMPORTANT — mirrors how the renderer degrades):
 *   - `styleJson` (unknown) → local `raw` state holds ONLY the keys the user
 *     actually touched (initial value: the incoming object, else {}).
 *   - Controls DISPLAY values from parseStyleConfig(raw) — untouched keys
 *     show the engine defaults, exactly like the PDF treats missing keys.
 *   - Every edit writes the touched path into a clone of raw and emits the
 *     clone via onChange (NOT normalized). Setting a value back to the
 *     DEFAULT deletes the key instead, and emptied parent objects are
 *     pruned — the stored JSON stays minimal ({} once everything is back to
 *     default). The X buttons unset the key outright.
 *   - Echo guard: the last emitted object lives in a ref; prop changes that
 *     deep-equal it never re-initialise the local state, so the panel never
 *     fights its own emissions.
 *
 * Column-width editor: every edit renormalizes the 7 widths to sum ~100
 * (k = 100/sum, rounded to 0.1 — the same scaling parseStyleConfig applies)
 * and emits the renormalized set. The "Σ" badge shows the raw stored sum and
 * turns amber when it drifts off 100 (rounding residue or hand-edited JSON).
 */

import * as React from "react";
import {
  Building2,
  FileText,
  Info,
  Palette,
  Sigma,
  Table as TableIcon,
  Type,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useT } from "@/lib/i18n/store";
import {
  DEFAULT_STYLE_CONFIG,
  DEFAULT_TABLE_COLUMN_WIDTHS,
  TABLE_COLUMN_KEYS,
  parseStyleConfig,
} from "@/lib/utils/style-config";

// ── Unit conversion + shared constants ───────────────────────────────────────

const PT_TO_PX = 1.333; // 1pt  = 1.333 CSS px (96/72) — browser preview only
const MM_TO_PX = 3.78; //  1mm  ≈ 3.78 CSS px (96/25.4)
/** Title mini-preview scale — the paper strip is ~75% of the real title. */
const PREVIEW_SCALE = 0.75;

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** i18n keys for the 7 column-width rows, in TABLE_COLUMN_KEYS order. */
const COLUMN_LABEL_KEYS: Record<string, string> = {
  rowNum: "tstyle-col-rownum",
  description: "tstyle-col-desc",
  hsCode: "tstyle-col-hs",
  origin: "tstyle-col-origin",
  quantity: "tstyle-col-qty",
  unitPrice: "tstyle-col-price",
  total: "tstyle-col-total",
};

/**
 * Distinct muted tones for the 7 column-width bar segments (same order as
 * TABLE_COLUMN_KEYS) — fixed tailwind classes, no dynamic style objects.
 */
const COLUMN_SEGMENT_COLORS = [
  "bg-teal-500/70",
  "bg-amber-500/70",
  "bg-rose-500/70",
  "bg-violet-500/70",
  "bg-cyan-500/70",
  "bg-orange-500/70",
  "bg-emerald-500/70",
] as const;

/** Expand a 3-digit hex to 6 digits — <input type="color"> needs #rrggbb. */
function expandHex(hex: string): string {
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`.toLowerCase();
  }
  return hex.toLowerCase();
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface TemplateStylePanelProps {
  /** Raw style_json value from the form (unknown — object, null, undefined). */
  styleJson: unknown;
  /** Emit the new raw partial object (NOT normalized) on every change. */
  onChange: (styleJson: unknown) => void;
  /** Optional current primary color (from the template) — shown as a
   *  brand quick-pick swatch on the title colour + table header background. */
  primaryColor?: string;
}

// ── Small deep helpers (raw partial bookkeeping) ─────────────────────────────

/** The partial raw object the panel edits — JSON-safe by construction. */
type RawStyle = Record<string, unknown>;

/** JSON round-trip clone (style_json values are plain JSON from the column). */
function cloneRaw(raw: RawStyle): RawStyle {
  return JSON.parse(JSON.stringify(raw)) as RawStyle;
}

/** Accepts the incoming style_json and normalizes it to a partial object. */
function toRawObject(styleJson: unknown): RawStyle {
  if (styleJson && typeof styleJson === "object" && !Array.isArray(styleJson)) {
    return cloneRaw(styleJson as RawStyle);
  }
  return {};
}

/** Recursive deep-equal for JSON-safe values. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ka = Object.keys(ao);
  if (ka.length !== Object.keys(bo).length) return false;
  return ka.every((k) => deepEqual(ao[k], bo[k]));
}

/** Read a path from a plain object tree (undefined when missing). */
function getPath(obj: unknown, path: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const seg of path) {
    if (cur && typeof cur === "object" && !Array.isArray(cur)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Deep-set into a plain object tree (creates intermediate objects). */
function deepSet(target: RawStyle, path: readonly string[], value: unknown): void {
  let cur: Record<string, unknown> = target;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    const next = cur[seg];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      cur[seg] = {};
    }
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[path[path.length - 1]] = value;
}

/**
 * Deep-delete a path AND prune now-empty parent objects — the stored partial
 * collapses back to {} once every touched key returns to its default.
 */
function deepDelete(target: RawStyle, path: readonly string[]): void {
  const stack: Record<string, unknown>[] = [target];
  for (let i = 0; i < path.length - 1; i++) {
    const next = stack[stack.length - 1][path[i]];
    if (!next || typeof next !== "object" || Array.isArray(next)) return;
    stack.push(next as Record<string, unknown>);
  }
  delete stack[stack.length - 1][path[path.length - 1]];
  for (let i = stack.length - 1; i >= 1; i--) {
    if (Object.keys(stack[i]).length === 0) {
      delete stack[i - 1][path[i - 1]];
    } else {
      break;
    }
  }
}

function clampNum(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * Renormalize a full 7-width set to sum ~100 (k = 100/sum, rounded to 0.1) —
 * the same scaling parseStyleConfig() applies on read, done at edit time so
 * the emitted raw object always lays out like the renderer will.
 */
function renormalizeWidths(widths: Record<string, number>): Record<string, number> {
  const total = TABLE_COLUMN_KEYS.reduce(
    (acc, key) => acc + (widths[key] ?? DEFAULT_TABLE_COLUMN_WIDTHS[key] ?? 0),
    0,
  );
  if (total > 0 && Math.abs(total - 100) > 1e-9) {
    const k = 100 / total;
    const out: Record<string, number> = {};
    for (const key of TABLE_COLUMN_KEYS) {
      out[key] = Math.round((widths[key] ?? DEFAULT_TABLE_COLUMN_WIDTHS[key]) * k * 10) / 10;
    }
    return out;
  }
  return { ...widths };
}

/** Sum of the STORED widths (missing keys count as defaults) — pre-parse. */
function rawWidthSum(raw: RawStyle): number {
  const stored = getPath(raw, ["table", "columnWidths"]) as
    | Record<string, unknown>
    | undefined;
  return TABLE_COLUMN_KEYS.reduce((acc, key) => {
    const v = stored?.[key];
    const n = typeof v === "number" ? v : Number(v);
    return acc + (Number.isFinite(n) ? n : DEFAULT_TABLE_COLUMN_WIDTHS[key]);
  }, 0);
}

// ── Reusable compact controls (panel-internal) ───────────────────────────────

interface ColorFieldProps {
  label: string;
  /** Current hex — always a valid normalized value (from parseStyleConfig). */
  value: string;
  /** Engine default — the X button resets back to it (unsets the raw key). */
  defaultValue: string;
  onChange: (hex: string) => void;
  /** X handler — unsets the raw key; falls back to onChange(defaultValue). */
  onReset?: () => void;
  resetLabel: string;
  invalidLabel: string;
  /** Optional brand quick-pick (the template primary color). */
  suggestion?: string;
  /** Dimmed + non-interactive (e.g. stripe colour while striping is off). */
  disabled?: boolean;
}

/** Color swatch input + hex text input + X reset, with hex validation. */
function ColorField({
  label,
  value,
  defaultValue,
  onChange,
  onReset,
  resetLabel,
  invalidLabel,
  suggestion,
  disabled,
}: ColorFieldProps) {
  const [draft, setDraft] = React.useState(value);

  React.useEffect(() => {
    // Sync the draft when the committed value changes externally (reset,
    // different template, …). Typing never triggers this — only valid hexes
    // are committed and those already match the draft.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(value);
  }, [value]);

  const invalid = draft !== "" && !HEX_RE.test(draft);
  const showReset = value.toLowerCase() !== defaultValue.toLowerCase();
  const showSuggestion =
    !!suggestion &&
    HEX_RE.test(suggestion) &&
    suggestion.toLowerCase() !== value.toLowerCase();

  /** Commit only valid hexes — junk keeps the muted error border, no emit. */
  const commitValid = (raw: string) => {
    const v = raw.trim();
    setDraft(v);
    if (HEX_RE.test(v)) onChange(v.toLowerCase());
  };

  return (
    <div className={cn("space-y-1.5", disabled && "opacity-60")}>
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
        <div className="flex items-center gap-1">
          {showSuggestion ? (
            <button
              type="button"
              className="h-5 w-5 shrink-0 rounded-[4px] border shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{ backgroundColor: suggestion }}
              title={suggestion}
              aria-label={suggestion}
              disabled={disabled}
              onClick={() => onChange((suggestion as string).toLowerCase())}
            />
          ) : null}
          {showReset ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-foreground"
              title={resetLabel}
              aria-label={resetLabel}
              disabled={disabled}
              onClick={() => (onReset ? onReset() : onChange(defaultValue))}
            >
              <X className="size-3" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <Input
          type="color"
          className="h-8 w-10 shrink-0 cursor-pointer rounded border p-1"
          value={HEX_RE.test(draft) ? expandHex(draft) : defaultValue}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
          aria-label={label}
          disabled={disabled}
        />
        <Input
          className={cn(
            "h-8 w-24 font-mono text-xs",
            invalid && "border-destructive/60 focus-visible:ring-destructive/20",
          )}
          value={draft}
          onChange={(e) => commitValid(e.target.value)}
          placeholder={defaultValue}
          maxLength={7}
          spellCheck={false}
          aria-invalid={invalid || undefined}
          disabled={disabled}
        />
      </div>
      {invalid ? (
        <p className="text-[10px] leading-none text-destructive/80">{invalidLabel}</p>
      ) : null}
    </div>
  );
}

interface NumFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
  /** Optional node rendered before the label (column colour dot). */
  labelPrefix?: React.ReactNode;
}

/** Label + number input + unit badge — in-range values emit live, clamps on blur. */
function NumField({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
  labelPrefix,
}: NumFieldProps) {
  const [draft, setDraft] = React.useState(String(value));
  const focusedRef = React.useRef(false);

  React.useEffect(() => {
    // Resync only while unfocused — the column-width editor renormalizes
    // emitted values, and a mid-typing resync would clobber the caret.
    if (!focusedRef.current) setDraft(String(value));
  }, [value]);

  const commitDraft = (raw: string) => {
    setDraft(raw);
    const n = Number(raw);
    if (raw !== "" && Number.isFinite(n) && n >= min && n <= max) onChange(n);
  };

  const handleBlur = () => {
    focusedRef.current = false;
    const n = Number(draft);
    if (draft === "" || !Number.isFinite(n)) {
      setDraft(String(value)); // junk → revert to the committed value
      return;
    }
    const clamped = clampNum(n, min, max); // clamps on blur
    if (clamped !== value) onChange(clamped);
    setDraft(String(clamped));
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        {labelPrefix}
        <Label className="truncate text-xs font-medium text-muted-foreground">
          {label}
        </Label>
      </div>
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          className="h-8 tabular-nums"
          min={min}
          max={max}
          step={step}
          value={draft}
          onFocus={() => {
            focusedRef.current = true;
          }}
          onChange={(e) => commitDraft(e.target.value)}
          onBlur={handleBlur}
          aria-label={label}
        />
        <Badge variant="secondary" className="shrink-0 text-[10px] font-normal tabular-nums">
          {unit}
        </Badge>
      </div>
    </div>
  );
}

interface SliderFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  decimals?: number;
  onChange: (v: number) => void;
}

/** Label row with tabular-nums value badge + Slider. */
function SliderField({
  label,
  value,
  min,
  max,
  step,
  unit,
  decimals = 1,
  onChange,
}: SliderFieldProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
        <Badge variant="secondary" className="font-normal tabular-nums">
          {value.toFixed(decimals)} {unit}
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

/** Switch + label row. */
function ToggleField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

interface SelectOption {
  value: string;
  label: string;
}

/** Label + compact Select (none/uppercase, left/center/right, …). */
function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger size="sm" className="w-full text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value} className="text-xs">
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Small uppercase section label with an optional right slot (Σ badge). */
function SectionHeader({ label, right }: { label: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {right}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function TemplateStylePanel({ styleJson, onChange, primaryColor }: TemplateStylePanelProps) {
  const t = useT();

  // ── Partial raw state + echo guard ──────────────────────────────────────

  const [raw, setRaw] = React.useState<RawStyle>(() => toRawObject(styleJson));
  /** Last object this component emitted — guards the sync effect from echoes. */
  const lastEmittedRef = React.useRef<unknown>(null);

  // Re-parse ONLY when the parent swaps the value (different template,
  // reset from outside, …). Our own emissions (possibly cloned/round-tripped
  // by the parent) are deep-equal and skipped, so parsing never fights edits.
  React.useEffect(() => {
    if (deepEqual(styleJson, lastEmittedRef.current)) return;
    setRaw(toRawObject(styleJson));
  }, [styleJson]);

  /** Display values — fully normalized by the SAME parser the PDF uses. */
  const cfg = React.useMemo(() => parseStyleConfig(raw), [raw]);

  const resetLabel = t("tstyle-reset-field");
  const invalidLabel = t("tstyle-invalid-hex");
  const canSuggest = typeof primaryColor === "string" && HEX_RE.test(primaryColor);

  // ── Mutations (each clones raw, mutates, emits) ──────────────────────────

  const commit = (next: RawStyle) => {
    if (deepEqual(next, raw)) return; // no-op edit — nothing to emit
    lastEmittedRef.current = next;
    setRaw(next);
    onChange(next);
  };

  /**
   * Deep-set a touched path into a clone of raw. When the new value is the
   * DEFAULT at the same path in DEFAULT_STYLE_CONFIG, the key is DELETED
   * instead (the stored partial stays minimal); deepDelete prunes empty
   * parents, so raw collapses back to {} when everything is default again.
   */
  const set = (path: readonly string[], value: unknown) => {
    const next = cloneRaw(raw);
    if (deepEqual(getPath(DEFAULT_STYLE_CONFIG, path), value)) {
      deepDelete(next, path);
    } else {
      deepSet(next, path, value);
    }
    commit(next);
  };

  /** X buttons — remove the touched key (and empty parents) outright. */
  const unset = (path: readonly string[]) => {
    const next = cloneRaw(raw);
    deepDelete(next, path);
    commit(next);
  };

  /**
   * Edit one column width: apply the new value to the current (renormalized)
   * set, renormalize the WHOLE set to ~100 and emit every width — keys that
   * land back on their default are dropped again to keep raw minimal.
   */
  const setColumnWidth = (key: string, v: number) => {
    const nextWidths: Record<string, number> = { ...cfg.table.columnWidths };
    nextWidths[key] = clampNum(v, 3, 60);
    const renorm = renormalizeWidths(nextWidths);

    const next = cloneRaw(raw);
    const stored: Record<string, number> = {};
    for (const colKey of TABLE_COLUMN_KEYS) {
      const w = renorm[colKey];
      if (!deepEqual(DEFAULT_TABLE_COLUMN_WIDTHS[colKey], w)) stored[colKey] = w;
    }
    if (Object.keys(stored).length > 0) {
      deepSet(next, ["table", "columnWidths"], stored);
    } else {
      deepDelete(next, ["table", "columnWidths"]);
    }
    commit(next);
  };

  /** Render helper for the many ColorFields (props are identical modulo path). */
  const renderColor = (
    label: string,
    value: string,
    path: readonly string[],
    opts?: { suggestion?: string; disabled?: boolean },
  ) => (
    <ColorField
      label={label}
      value={value}
      defaultValue={getPath(DEFAULT_STYLE_CONFIG, path) as string}
      suggestion={opts?.suggestion}
      disabled={opts?.disabled}
      onChange={(hex) => set(path, hex)}
      onReset={() => unset(path)}
      resetLabel={resetLabel}
      invalidLabel={invalidLabel}
    />
  );

  // ── Column-width editor derived values ──────────────────────────────────

  const displayWidths = cfg.table.columnWidths;
  const widthSum = rawWidthSum(raw);
  const sumOff = Math.abs(widthSum - 100) > 0.05;

  const sumBadge = (
    <Badge
      variant="secondary"
      aria-label={t("tstyle-sum")}
      title={t("tstyle-sum")}
      className={cn(
        "text-[10px] font-normal tabular-nums",
        sumOff &&
          "border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300",
      )}
    >
      Σ {widthSum.toFixed(1)}%
    </Badge>
  );

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Palette className="size-4" aria-hidden="true" />
        </div>
        <h3 className="truncate text-sm font-semibold leading-none">{t("tstyle-title")}</h3>
      </div>

      <Tabs defaultValue="title" className="gap-0">
        <div className="border-b p-2">
          <TabsList className="grid h-auto w-full grid-cols-3 sm:grid-cols-6">
            <TabsTrigger value="title" className="h-8 gap-1.5 px-1.5 text-xs">
              <Type className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">{t("tstyle-tab-title")}</span>
            </TabsTrigger>
            <TabsTrigger value="table" className="h-8 gap-1.5 px-1.5 text-xs">
              <TableIcon className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">{t("tstyle-tab-table")}</span>
            </TabsTrigger>
            <TabsTrigger value="party" className="h-8 gap-1.5 px-1.5 text-xs">
              <Building2 className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">{t("tstyle-tab-party")}</span>
            </TabsTrigger>
            <TabsTrigger value="totals" className="h-8 gap-1.5 px-1.5 text-xs">
              <Sigma className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">{t("tstyle-tab-totals")}</span>
            </TabsTrigger>
            <TabsTrigger value="notice" className="h-8 gap-1.5 px-1.5 text-xs">
              <Info className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">{t("tstyle-tab-notice")}</span>
            </TabsTrigger>
            <TabsTrigger value="body" className="h-8 gap-1.5 px-1.5 text-xs">
              <FileText className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">{t("tstyle-tab-body")}</span>
            </TabsTrigger>
          </TabsList>
        </div>

        {/* NOTE: tab bodies use the repo-standard "custom-scroll" div
            (max-h + overflow-y-auto + styled thin scrollbar). The Radix
            ScrollArea viewport needs a definite height to scroll — with only
            max-h it clips instead (verified in a headless browser). */}
        {/* ── Title tab ── */}
        <TabsContent value="title" className="mt-0">
          <div className="max-h-[520px] overflow-y-auto custom-scroll">
            <div className="space-y-4 p-4">
              {/* Live mini preview — title styles rendered on a paper strip */}
              <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t("tstyle-preview")}
                </span>
                <div className="rounded-md bg-white p-3 shadow-sm ring-1 ring-black/5">
                  <div
                    style={{
                      // The PDF renders the title with the bold heading font
                      // variant (boldVariant) — mirrored here with weight 700.
                      fontFamily: "'Noto Sans', sans-serif",
                      fontWeight: 700,
                      lineHeight: 1.2,
                      fontSize: `${(cfg.title.fontSize * PREVIEW_SCALE).toFixed(2)}pt`,
                      color: cfg.title.color,
                      letterSpacing: `${(cfg.title.letterSpacing * PREVIEW_SCALE * PT_TO_PX).toFixed(2)}px`,
                      textTransform: cfg.title.transform === "uppercase" ? "uppercase" : "none",
                      textDecoration: cfg.title.underline ? "underline" : "none",
                    }}
                  >
                    PROFORMA INVOICE
                  </div>
                  {cfg.title.showRule ? (
                    <div
                      aria-hidden="true"
                      className="mt-1 h-[1.5px] w-full"
                      style={{ backgroundColor: cfg.title.ruleColor }}
                    />
                  ) : null}
                  <div
                    aria-hidden="true"
                    style={{
                      height: `${(cfg.title.spacingAfter * MM_TO_PX * PREVIEW_SCALE).toFixed(2)}px`,
                    }}
                  />
                </div>
              </div>

              <SliderField
                label={t("tstyle-font-size")}
                value={cfg.title.fontSize}
                min={10}
                max={30}
                step={0.5}
                unit={t("tstyle-pt")}
                onChange={(v) => set(["title", "fontSize"], v)}
              />
              {renderColor(t("tstyle-color"), cfg.title.color, ["title", "color"], {
                suggestion: canSuggest ? primaryColor : undefined,
              })}
              <SliderField
                label={t("tstyle-letter-spacing")}
                value={cfg.title.letterSpacing}
                min={0}
                max={6}
                step={0.1}
                unit={t("tstyle-pt")}
                onChange={(v) => set(["title", "letterSpacing"], v)}
              />
              <SelectField
                label={t("tstyle-transform")}
                value={cfg.title.transform}
                options={[
                  { value: "none", label: t("tstyle-none") },
                  { value: "uppercase", label: t("tstyle-uppercase") },
                ]}
                onChange={(v) => set(["title", "transform"], v)}
              />
              <ToggleField
                label={t("tstyle-underline")}
                checked={cfg.title.underline}
                onChange={(v) => set(["title", "underline"], v)}
              />
              <ToggleField
                label={t("tstyle-show-rule")}
                checked={cfg.title.showRule}
                onChange={(v) => set(["title", "showRule"], v)}
              />
              {cfg.title.showRule
                ? renderColor(t("tstyle-rule-color"), cfg.title.ruleColor, ["title", "ruleColor"])
                : null}
              <SliderField
                label={t("tstyle-spacing-after")}
                value={cfg.title.spacingAfter}
                min={0}
                max={20}
                step={0.5}
                unit={t("tstyle-mm")}
                onChange={(v) => set(["title", "spacingAfter"], v)}
              />
            </div>
          </div>
        </TabsContent>

        {/* ── Table tab (the TABLE STUDIO) ── */}
        <TabsContent value="table" className="mt-0">
          <div className="max-h-[520px] overflow-y-auto custom-scroll">
            <div className="space-y-4 p-4">
              {/* Header row */}
              <section className="space-y-3 rounded-lg border p-3">
                <SectionHeader label={t("tstyle-header-row")} />
                {renderColor(t("tstyle-header-bg"), cfg.table.headerBg, ["table", "headerBg"], {
                  suggestion: canSuggest ? primaryColor : undefined,
                })}
                {renderColor(
                  t("tstyle-header-color"),
                  cfg.table.headerColor,
                  ["table", "headerColor"],
                )}
                <SliderField
                  label={t("tstyle-header-size")}
                  value={cfg.table.headerFontSize}
                  min={6}
                  max={14}
                  step={0.5}
                  unit={t("tstyle-pt")}
                  onChange={(v) => set(["table", "headerFontSize"], v)}
                />
                <ToggleField
                  label={t("tstyle-header-bold")}
                  checked={cfg.table.headerBold}
                  onChange={(v) => set(["table", "headerBold"], v)}
                />
                <SelectField
                  label={t("tstyle-header-transform")}
                  value={cfg.table.headerTransform}
                  options={[
                    { value: "none", label: t("tstyle-none") },
                    { value: "uppercase", label: t("tstyle-uppercase") },
                  ]}
                  onChange={(v) => set(["table", "headerTransform"], v)}
                />
                <SliderField
                  label={t("tstyle-header-padding")}
                  value={cfg.table.headerPaddingY}
                  min={0.5}
                  max={6}
                  step={0.1}
                  unit={t("tstyle-mm")}
                  onChange={(v) => set(["table", "headerPaddingY"], v)}
                />
              </section>

              {/* Body cells */}
              <section className="space-y-3 rounded-lg border p-3">
                <SectionHeader label={t("tstyle-body-cells")} />
                <SliderField
                  label={t("tstyle-cell-size")}
                  value={cfg.table.cellFontSize}
                  min={5}
                  max={13}
                  step={0.5}
                  unit={t("tstyle-pt")}
                  onChange={(v) => set(["table", "cellFontSize"], v)}
                />
                <SliderField
                  label={t("tstyle-cell-padding")}
                  value={cfg.table.cellPaddingY}
                  min={0.5}
                  max={6}
                  step={0.1}
                  unit={t("tstyle-mm")}
                  onChange={(v) => set(["table", "cellPaddingY"], v)}
                />
                <SelectField
                  label={t("tstyle-numeric-align")}
                  value={cfg.table.numericAlign}
                  options={[
                    { value: "left", label: t("tstyle-left") },
                    { value: "center", label: t("tstyle-center") },
                    { value: "right", label: t("tstyle-right") },
                  ]}
                  onChange={(v) => set(["table", "numericAlign"], v)}
                />
              </section>

              {/* Grid */}
              <section className="space-y-3 rounded-lg border p-3">
                <SectionHeader label={t("tstyle-grid")} />
                {renderColor(
                  t("tstyle-border-color"),
                  cfg.table.borderColor,
                  ["table", "borderColor"],
                )}
                <SliderField
                  label={t("tstyle-border-width")}
                  value={cfg.table.borderWidth}
                  min={0}
                  max={3}
                  step={0.25}
                  decimals={2}
                  unit={t("tstyle-pt")}
                  onChange={(v) => set(["table", "borderWidth"], v)}
                />
                <ToggleField
                  label={t("tstyle-stripe")}
                  checked={cfg.table.stripe}
                  onChange={(v) => set(["table", "stripe"], v)}
                />
                {renderColor(
                  t("tstyle-stripe-color"),
                  cfg.table.stripeColor,
                  ["table", "stripeColor"],
                  { disabled: !cfg.table.stripe },
                )}
              </section>

              {/* Column widths — the visual editor */}
              <section className="space-y-3 rounded-lg border p-3">
                <SectionHeader label={t("tstyle-col-widths")} right={sumBadge} />
                <div className="flex h-8 overflow-hidden rounded-md border border-border/60">
                  {TABLE_COLUMN_KEYS.map((key, idx) => {
                    const w = displayWidths[key] ?? 0;
                    return (
                      <div
                        key={key}
                        title={`${t(COLUMN_LABEL_KEYS[key])}: ${w.toFixed(1)}%`}
                        className={cn(
                          "flex h-full min-w-0 items-center justify-center overflow-hidden",
                          COLUMN_SEGMENT_COLORS[idx],
                        )}
                        style={{ flexGrow: w, flexShrink: 1, flexBasis: 0 }}
                      >
                        <span className="truncate px-1 text-[10px] font-semibold tabular-nums text-white">
                          {w.toFixed(1)}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {TABLE_COLUMN_KEYS.map((key, idx) => (
                    <NumField
                      key={key}
                      label={t(COLUMN_LABEL_KEYS[key])}
                      labelPrefix={
                        <span
                          className={cn(
                            "size-2 shrink-0 rounded-[2px]",
                            COLUMN_SEGMENT_COLORS[idx],
                          )}
                          aria-hidden="true"
                        />
                      }
                      value={displayWidths[key]}
                      min={3}
                      max={60}
                      step={0.5}
                      unit="%"
                      onChange={(v) => setColumnWidth(key, v)}
                    />
                  ))}
                </div>
              </section>
            </div>
          </div>
        </TabsContent>

        {/* ── Party boxes tab ── */}
        <TabsContent value="party" className="mt-0">
          <div className="max-h-[520px] overflow-y-auto custom-scroll">
            <div className="space-y-4 p-4">
              {renderColor(t("tstyle-party-border"), cfg.party.borderColor, ["party", "borderColor"])}
              {renderColor(t("tstyle-party-bg"), cfg.party.bgColor, ["party", "bgColor"])}
              {renderColor(t("tstyle-party-label"), cfg.party.labelColor, ["party", "labelColor"])}
              {renderColor(t("tstyle-party-value"), cfg.party.valueColor, ["party", "valueColor"])}
              <SliderField
                label={t("tstyle-party-border-width")}
                value={cfg.party.borderWidth}
                min={0}
                max={3}
                step={0.25}
                decimals={2}
                unit={t("tstyle-pt")}
                onChange={(v) => set(["party", "borderWidth"], v)}
              />
              <SliderField
                label={t("tstyle-party-radius")}
                value={cfg.party.borderRadius}
                min={0}
                max={10}
                step={0.5}
                unit={t("tstyle-pt")}
                onChange={(v) => set(["party", "borderRadius"], v)}
              />
              <SliderField
                label={t("tstyle-party-gap")}
                value={cfg.party.gap}
                min={2}
                max={15}
                step={0.5}
                unit={t("tstyle-mm")}
                onChange={(v) => set(["party", "gap"], v)}
              />
            </div>
          </div>
        </TabsContent>

        {/* ── Totals tab ── */}
        <TabsContent value="totals" className="mt-0">
          <div className="max-h-[520px] overflow-y-auto custom-scroll">
            <div className="space-y-4 p-4">
              {renderColor(t("tstyle-totals-label"), cfg.totals.labelColor, ["totals", "labelColor"])}
              {renderColor(t("tstyle-totals-value"), cfg.totals.valueColor, ["totals", "valueColor"])}
              {renderColor(
                t("tstyle-totals-grand-bg"),
                cfg.totals.grandBgColor,
                ["totals", "grandBgColor"],
              )}
              {renderColor(
                t("tstyle-totals-grand-color"),
                cfg.totals.grandColor,
                ["totals", "grandColor"],
              )}
              <ToggleField
                label={t("tstyle-totals-grand-bold")}
                checked={cfg.totals.grandBold}
                onChange={(v) => set(["totals", "grandBold"], v)}
              />
              <SliderField
                label={t("tstyle-totals-border-width")}
                value={cfg.totals.borderWidth}
                min={0}
                max={3}
                step={0.25}
                decimals={2}
                unit={t("tstyle-pt")}
                onChange={(v) => set(["totals", "borderWidth"], v)}
              />
              {renderColor(
                t("tstyle-totals-border-color"),
                cfg.totals.borderColor,
                ["totals", "borderColor"],
              )}
            </div>
          </div>
        </TabsContent>

        {/* ── Notice tab ── */}
        <TabsContent value="notice" className="mt-0">
          <div className="max-h-[520px] overflow-y-auto custom-scroll">
            <div className="space-y-4 p-4">
              {renderColor(t("tstyle-notice-bg"), cfg.notice.bgColor, ["notice", "bgColor"])}
              {renderColor(t("tstyle-notice-border"), cfg.notice.borderColor, ["notice", "borderColor"])}
              {renderColor(t("tstyle-notice-text"), cfg.notice.textColor, ["notice", "textColor"])}
              <SliderField
                label={t("tstyle-notice-size")}
                value={cfg.notice.fontSize}
                min={5}
                max={12}
                step={0.5}
                unit={t("tstyle-pt")}
                onChange={(v) => set(["notice", "fontSize"], v)}
              />
            </div>
          </div>
        </TabsContent>

        {/* ── Body tab ── */}
        <TabsContent value="body" className="mt-0">
          <div className="max-h-[520px] overflow-y-auto custom-scroll">
            <div className="space-y-4 p-4">
              {renderColor(t("tstyle-body-text"), cfg.body.textColor, ["body", "textColor"])}
              {renderColor(t("tstyle-body-label"), cfg.body.labelColor, ["body", "labelColor"])}
              {renderColor(t("tstyle-body-value"), cfg.body.valueColor, ["body", "valueColor"])}
              <SliderField
                label={t("tstyle-body-section-spacing")}
                value={cfg.body.sectionSpacing}
                min={0}
                max={25}
                step={0.5}
                unit={t("tstyle-mm")}
                onChange={(v) => set(["body", "sectionSpacing"], v)}
              />
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
