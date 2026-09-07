"use client";

/**
 * TemplateBlocksEditor — the Document Studio "Body Blocks" section
 * (audit35, ported from the sandbox studio into the production editor).
 *
 * A template's body can be AUTHORED as a list of blocks (heading, rich
 * paragraph, list, info fields, line-item table, quote, divider, spacer,
 * page break, image, signature). NULL content = the classic fixed-section
 * flow — existing templates keep working untouched.
 *
 * The frame (page/header/footer/QR) is deliberately NOT editable here:
 * it is memorandum-owned and locked (audit33/35).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Plus, Trash2, Copy, ChevronUp, ChevronDown, ChevronRight, Bold, Italic,
  Underline, Strikethrough, Eraser, Variable, ImagePlus, Table2, Rows3, Layers,
  Type, Heading1, List, Quote, Minus, Space, ArrowDownToLine as PageBreakIcon,
  PenLine, Settings2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/store";
import { toast } from "sonner";
import {
  normalizeBlocks, sanitizeRichHtml, htmlToRuns, starterBlocks,
  BLOCK_TYPES, findVariablesInBlocks,
  type BlocksContent, type DocBlock, type DocBlockType, type BlockAlign,
} from "@/lib/utils/doc-blocks";

// The live document variables the renderer resolves ({company_name}, …).
export const BLOCK_VARIABLES: { token: string; label: string }[] = [
  { token: "{doc_number}", label: "doc-var-doc-num" },
  { token: "{doc_date}", label: "doc-var-doc-date" },
  { token: "{valid_until}", label: "doc-var-valid-until" },
  { token: "{due_date}", label: "doc-var-due-date" },
  { token: "{partner_name}", label: "doc-var-partner-name" },
  { token: "{partner_address}", label: "doc-var-partner-address" },
  { token: "{partner_city}", label: "doc-var-partner-city" },
  { token: "{partner_country}", label: "doc-var-partner-country" },
  { token: "{company_name}", label: "doc-var-company-name" },
  { token: "{company_legal_name}", label: "doc-var-legal-name" },
  { token: "{company_address}", label: "doc-var-address" },
  { token: "{company_city}", label: "doc-var-city" },
  { token: "{company_country}", label: "doc-var-country" },
  { token: "{company_reg}", label: "doc-var-reg" },
  { token: "{company_vat}", label: "doc-var-vat" },
  { token: "{company_phone}", label: "doc-var-phone" },
  { token: "{company_email}", label: "doc-var-email" },
  { token: "{company_website}", label: "doc-var-website" },
  { token: "{bank_name}", label: "doc-var-bank" },
  { token: "{bank_iban}", label: "doc-var-iban" },
  { token: "{bank_swift}", label: "doc-var-swift" },
  { token: "{total}", label: "doc-var-total" },
  { token: "{currency}", label: "doc-var-currency" },
];

const BLOCK_ICON: Record<DocBlockType, any> = {
  heading: Heading1, paragraph: Type, list: List, fields: Rows3,
  table: Table2, quote: Quote, divider: Minus, spacer: Space,
  pagebreak: PageBreakIcon, image: ImagePlus, signature: PenLine,
};

function newBlockId(): string {
  return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function emptyBlock(type: DocBlockType): DocBlock {
  switch (type) {
    case "heading":
      return { id: newBlockId(), type, level: 1, html: "Heading", align: "left", scale: 150, spacing: 4 };
    case "paragraph":
      return { id: newBlockId(), type, html: "Paragraph text…", align: "left", scale: 100, lineHeight: 1.5, spacing: 4 };
    case "list":
      return { id: newBlockId(), type, ordered: true, marker: "decimal", items: ["First item", "Second item"], align: "left", spacing: 4 };
    case "fields":
      return { id: newBlockId(), type, items: [{ label: "Date", value: "{doc_date}" }, { label: "Client", value: "{partner_name}" }], labelWidth: 28, borders: true, striped: false, spacing: 4 };
    case "table":
      return { id: newBlockId(), type, source: "custom", columns: ["Column A", "Column B", "Column C"], rows: [["", "", ""], ["", "", ""]], widths: [34, 33, 33], headerRow: true, zebra: true, borders: "all", align: "left", showTotals: false, spacing: 4 };
    case "quote":
      return { id: newBlockId(), type, html: "Highlighted clause / terms…", background: true, spacing: 4 };
    case "divider":
      return { id: newBlockId(), type, style: "solid", thickness: 1, width: 100, spacing: 4 };
    case "spacer":
      return { id: newBlockId(), type, height: 12 };
    case "pagebreak":
      return { id: newBlockId(), type };
    case "image":
      return { id: newBlockId(), type, src: "", width: 60, align: "center", caption: "", rounded: false, spacing: 4 };
    case "signature":
      return { id: newBlockId(), type, parties: [{ name: "{company_name}", role: "Seller", label: "Authorised signature" }, { name: "{partner_name}", role: "Buyer", label: "Accepted & agreed" }], layout: "row", withDate: true, spacing: 4 };
  }
}

// ── Rich text editing (contentEditable, strict allowlist) ─────────────────
//
// document.execCommand with styleWithCSS produces <span style="color:…"> —
// exactly the subset sanitizeRichHtml keeps. The editor never trusts the
// DOM: every commit runs through sanitizeRichHtml before onChange.

interface RichEditProps {
  html: string;
  onChange: (html: string) => void;
  minHeight?: number;
  className?: string;
  registerFocus?: (el: HTMLDivElement | null) => void;
}

function RichEdit({ html, onChange, minHeight = 64, className, registerFocus }: RichEditProps) {
  const ref = useRef<HTMLDivElement>(null);
  const lastEmitted = useRef(html);

  // Uncontrolled: seed innerHTML only when the incoming html differs from
  // what we last emitted (external change: block switch / restore).
  useEffect(() => {
    if (ref.current && html !== lastEmitted.current) {
      ref.current.innerHTML = sanitizeRichHtml(html);
      lastEmitted.current = html;
    }
  }, [html]);

  const commit = () => {
    if (!ref.current) return;
    const clean = sanitizeRichHtml(ref.current.innerHTML);
    lastEmitted.current = clean;
    onChange(clean);
    // Re-normalize the DOM if execCommand produced something outside the
    // subset (font tags etc.) — the visual then matches what will render.
    if (ref.current.innerHTML !== clean) ref.current.innerHTML = clean;
  };

  return (
    <div className={cn("rounded-md border border-border/60 bg-background focus-within:border-primary/50", className)}>
      <div
        ref={(el) => { ref.current = el; registerFocus?.(el); }}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        tabIndex={0}
        onInput={commit}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Escape") (e.currentTarget as HTMLDivElement).blur(); }}
        onPaste={(e) => {
          // Plain-text paste only — no foreign HTML ever enters the model.
          e.preventDefault();
          const text = e.clipboardData.getData("text/plain");
          document.execCommand("insertText", false, text);
        }}
        className="prose-sm min-w-0 px-3 py-2 text-sm leading-relaxed outline-none [&_b]:font-bold [&_i]:italic [&_s]:line-through [&_u]:underline"
        style={{ minHeight }}
        dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(html) }}
      />
    </div>
  );
}

function RichToolbar({ target }: { target: "rich" }) {
  const t = useT();
  const exec = (cmd: string, arg?: string) => {
    document.execCommand("styleWithCSS", false, "true");
    document.execCommand(cmd, false, arg);
  };
  const btn = (icon: any, cmd: string, labelKey: string, arg?: string) => {
    const Icon = icon;
    return (
      <Button
        key={cmd + (arg ?? "")}
        type="button"
        variant="ghost"
        size="sm"
        className="size-7 p-0"
        title={t(labelKey)}
        aria-label={t(labelKey)}
        onMouseDown={(e) => e.preventDefault()} // keep the selection in the editor
        onClick={() => exec(cmd, arg)}
      >
        <Icon className="size-3.5" />
      </Button>
    );
  };
  return (
    <div className="flex flex-wrap items-center gap-0.5 rounded-md border border-border/60 bg-muted/30 p-1">
      {target === "rich" && (
        <>
          {btn(Bold, "bold", "docb-rich-bold")}
          {btn(Italic, "italic", "docb-rich-italic")}
          {btn(Underline, "underline", "docb-rich-underline")}
          {btn(Strikethrough, "strikeThrough", "docb-rich-strike")}
          <span className="mx-1 h-4 w-px bg-border" />
          <label className="flex size-7 cursor-pointer items-center justify-center" title={t("docb-rich-color")} aria-label={t("docb-rich-color")}>
            <span className="size-3.5 rounded-[3px] border border-border bg-gradient-to-br from-rose-500 via-amber-500 to-emerald-600" />
            <input type="color" className="sr-only" onChange={(e) => exec("foreColor", e.target.value)} />
          </label>
          <label className="flex size-7 cursor-pointer items-center justify-center" title={t("docb-rich-highlight")} aria-label={t("docb-rich-highlight")}>
            <span className="size-3.5 rounded-[3px] border border-amber-300 bg-amber-200" />
            <input type="color" className="sr-only" onChange={(e) => exec("hiliteColor", e.target.value)} />
          </label>
          <span className="mx-1 h-4 w-px bg-border" />
          {btn(Eraser, "removeFormat", "docb-rich-clear")}
        </>
      )}
    </div>
  );
}

// ── Small field helpers (local to this module) ────────────────────────────

function F({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1", className)}>
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function Num({ value, onChange, min, max, step = 1, suffix }: { value: number; onChange: (v: number) => void; min: number; max: number; step?: number; suffix?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="number"
        value={value}
        min={min} max={max} step={step}
        onChange={(e) => onChange(Number(e.target.value) || min)}
        className="h-8 text-sm tabular"
      />
      {suffix && <span className="text-[11px] text-muted-foreground">{suffix}</span>}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5">
      <Switch checked={checked} onCheckedChange={onChange} className="scale-90" aria-label={label} />
      <span className="text-xs">{label}</span>
    </label>
  );
}

function ColorIn({ value, onChange }: { value?: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="color"
        value={value || "#000000"}
        onChange={(e) => onChange(e.target.value)}
        className="size-8 shrink-0 cursor-pointer rounded-md border border-border/60 bg-card p-0.5"
        aria-label="color"
      />
      <Input value={value || ""} onChange={(e) => onChange(e.target.value)} className="h-8 font-mono text-xs" placeholder="#0f766e" />
    </div>
  );
}

const ALIGNS: { v: BlockAlign; label: string }[] = [
  { v: "left", label: "docb-align-left" },
  { v: "center", label: "docb-align-center" },
  { v: "right", label: "docb-align-right" },
  { v: "justify", label: "docb-align-justify" },
];

function AlignPicker({ value, onChange, allowJustify = true }: { value: BlockAlign; onChange: (v: BlockAlign) => void; allowJustify?: boolean }) {
  const t = useT();
  const opts = allowJustify ? ALIGNS : ALIGNS.filter((a) => a.v !== "justify");
  return (
    <div className="flex gap-1">
      {opts.map((a) => (
        <Button
          key={a.v}
          type="button"
          variant={value === a.v ? "secondary" : "ghost"}
          size="sm"
          className="h-8 px-2 text-xs"
          onClick={() => onChange(a.v)}
          title={t(a.label)}
          aria-label={t(a.label)}
          aria-pressed={value === a.v}
        >
          {a.v === "left" ? "⬅" : a.v === "center" ? "↔" : a.v === "right" ? "➡" : "≡"}
        </Button>
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────

export function TemplateBlocksEditor({
  value, onChange, docType, tenantId, templateId, primaryColor,
}: {
  value: unknown;
  onChange: (v: BlocksContent | null) => void;
  docType: string;
  tenantId: string | null;
  templateId: string | null;
  primaryColor: string;
}) {
  const t = useT();
  const content = useMemo(() => normalizeBlocks(value), [value]);
  const blocks = content?.blocks ?? null;
  const [expanded, setExpanded] = useState<string | null>(null);
  const richFocus = useRef<HTMLDivElement | null>(null);

  const usedVariables = useMemo(() => (blocks ? findVariablesInBlocks(blocks) : []), [blocks]);

  const update = (next: DocBlock[]) => {
    if (next.length === 0) { onChange(null); return; }
    onChange({ version: 1, blocks: next });
  };
  const setBlock = (id: string, patch: Partial<DocBlock>) => {
    update((blocks as DocBlock[]).map((b) => (b.id === id ? ({ ...b, ...patch } as DocBlock) : b)));
  };
  const removeBlock = (id: string) => update((blocks as DocBlock[]).filter((b) => b.id !== id));
  const duplicateBlock = (id: string) => {
    const i = (blocks as DocBlock[]).findIndex((b) => b.id === id);
    if (i < 0) return;
    const copy = { ...(blocks as DocBlock[])[i], id: newBlockId() };
    const next = [...(blocks as DocBlock[])];
    next.splice(i + 1, 0, copy);
    update(next);
  };
  const move = (id: string, dir: -1 | 1) => {
    const i = (blocks as DocBlock[]).findIndex((b) => b.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= (blocks as DocBlock[]).length) return;
    const next = [...(blocks as DocBlock[])];
    [next[i], next[j]] = [next[j], next[i]];
    update(next);
  };
  const insert = (type: DocBlockType) => {
    const b = emptyBlock(type);
    update(blocks ? [...blocks, b] : [b]);
    setExpanded(b.id);
  };

  const insertVariable = (token: string) => {
    const el = richFocus.current;
    if (el) {
      el.focus();
      document.execCommand("insertText", false, token);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      toast.info(t("docb-variable-focus-hint"));
    }
  };

  // ── Empty state: classic body → convert CTA ──
  if (!blocks) {
    return (
      <Card className="border-border/60">
        <CardContent className="space-y-4 p-6">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Layers className="size-5" />
            </div>
            <div className="space-y-1">
              <h3 className="text-sm font-semibold">{t("docb-empty-title")}</h3>
              <p className="text-sm text-muted-foreground">{t("docb-empty-desc")}</p>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button onClick={() => onChange(starterBlocks(docType))}>
              <Layers className="size-4" />
              <span className="ml-1.5">{t("docb-convert")}</span>
            </Button>
            <div className="flex items-center justify-center rounded-md border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
              {t("docb-keep-classic")}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ── Block list ──
  return (
    <div className="space-y-3">
      {/* Header row: stats + convert-off */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="gap-1 text-xs">
          <Layers className="size-3" />
          {t("docb-blocks-count")} · {blocks.length}
        </Badge>
        {usedVariables.length > 0 && (
          <Badge variant="outline" className="gap-1 text-xs">
            <Variable className="size-3" />
            {t("docb-variables-used")} · {usedVariables.length}
          </Badge>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-8 text-xs text-muted-foreground"
          onClick={() => { if (window.confirm(t("docb-clear-confirm"))) onChange(null); }}
        >
          <Trash2 className="size-3.5" />
          <span className="ml-1">{t("docb-back-to-classic")}</span>
        </Button>
      </div>

      {/* Blocks */}
      <div className="space-y-2">
        {blocks.map((b, i) => {
          const Icon = BLOCK_ICON[b.type];
          const open = expanded === b.id;
          const label = t(`doc-block-type-${b.type}`);
          return (
            <div key={b.id} className="rounded-lg border border-border/60 bg-card">
              <div className="flex items-center gap-2 px-3 py-2">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
                  <Icon className="size-4" />
                </span>
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => setExpanded(open ? null : b.id)}
                  aria-expanded={open}
                >
                  <span className="truncate text-sm font-medium">{label}</span>
                  <span className="hidden truncate text-xs text-muted-foreground sm:block">
                    {blockSummary(b)}
                  </span>
                </button>
                <span className="flex items-center gap-0.5">
                  <Button variant="ghost" size="sm" className="size-7 p-0" disabled={i === 0} onClick={() => move(b.id, -1)} title={t("docb-move-up")} aria-label={t("docb-move-up")}>
                    <ChevronUp className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" className="size-7 p-0" disabled={i === blocks.length - 1} onClick={() => move(b.id, 1)} title={t("docb-move-down")} aria-label={t("docb-move-down")}>
                    <ChevronDown className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" className="size-7 p-0" onClick={() => duplicateBlock(b.id)} title={t("docb-duplicate")} aria-label={t("docb-duplicate")}>
                    <Copy className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" className="size-7 p-0 text-destructive" onClick={() => removeBlock(b.id)} title={t("docb-remove")} aria-label={t("docb-remove")}>
                    <Trash2 className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" className="size-7 p-0" onClick={() => setExpanded(open ? null : b.id)} title={t("docb-settings")} aria-label={t("docb-settings")} aria-expanded={open}>
                    <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
                  </Button>
                </span>
              </div>
              {open && (
                <div className="space-y-3 border-t border-border/60 px-3 py-3">
                  <BlockFields block={b} onChange={(patch) => setBlock(b.id, patch)} primaryColor={primaryColor} richRegister={(el) => { richFocus.current = el; }} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add block + variables */}
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-9">
              <Plus className="size-4" />
              <span className="ml-1">{t("docb-add-block")}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 w-52 overflow-y-auto">
            {BLOCK_TYPES.map((bt) => {
              const Icon = BLOCK_ICON[bt.type];
              return (
                <DropdownMenuItem key={bt.type} onClick={() => insert(bt.type)}>
                  <Icon className="size-4" />
                  <span>{t(bt.labelKey)}</span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-9 text-muted-foreground">
              <Variable className="size-4" />
              <span className="ml-1">{t("docb-insert-variable")}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
            {BLOCK_VARIABLES.map((v) => (
              <DropdownMenuItem key={v.token} onClick={() => insertVariable(v.token)} className="font-mono text-xs">
                {v.token}
                <span className="ml-auto font-sans text-[10px] text-muted-foreground">{t(v.label)}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="text-[11px] text-muted-foreground">{t("docb-variables-hint")}</span>
      </div>

      {tenantId && templateId && (
        <p className="text-[11px] text-muted-foreground">
          <Settings2 className="mr-1 inline size-3" />
          {t("docb-frame-note")}
        </p>
      )}
    </div>
  );
}

function blockSummary(b: DocBlock): string {
  switch (b.type) {
    case "heading": return htmlToTextSafe(b.html).slice(0, 60);
    case "paragraph": return htmlToTextSafe(b.html).slice(0, 60);
    case "list": return `${b.items.length} items`;
    case "fields": return `${b.items.length} fields`;
    case "table": return b.source === "items" ? "Line items + totals" : `${b.columns.length} × ${b.rows.length}`;
    case "quote": return htmlToTextSafe(b.html).slice(0, 60);
    case "divider": return b.style;
    case "spacer": return `${b.height} mm`;
    case "pagebreak": return "—";
    case "image": return b.caption || "image";
    case "signature": return `${b.parties.length} parties`;
    default: return "";
  }
}

function htmlToTextSafe(html: string): string {
  try {
    return htmlToRuns(html).map((r) => r.text).join("").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

// ── Per-block settings fields ─────────────────────────────────────────────

function BlockFields({
  block: b, onChange, primaryColor, richRegister,
}: {
  block: DocBlock;
  onChange: (patch: Partial<DocBlock>) => void;
  primaryColor: string;
  richRegister: (el: HTMLDivElement | null) => void;
}) {
  const t = useT();

  switch (b.type) {
    case "heading":
      return (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <RichToolbar target="rich" />
            <AlignPicker value={b.align} onChange={(v) => onChange({ align: v })} allowJustify={false} />
          </div>
          <RichEdit html={b.html} onChange={(html) => onChange({ html })} registerFocus={richRegister} minHeight={44} />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <F label={t("docb-level")}>
              <Select value={String(b.level)} onValueChange={(v) => onChange({ level: Number(v) as 1 | 2 | 3 })}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">H1</SelectItem>
                  <SelectItem value="2">H2</SelectItem>
                  <SelectItem value="3">H3</SelectItem>
                </SelectContent>
              </Select>
            </F>
            <F label={t("docb-scale")}>
              <Num value={b.scale ?? 140} onChange={(v) => onChange({ scale: v })} min={80} max={200} suffix="%" />
            </F>
            <F label={t("docb-color")}>
              <ColorIn value={b.color} onChange={(v) => onChange({ color: v })} />
            </F>
            <F label={t("docb-spacing")}>
              <Num value={b.spacing ?? 4} onChange={(v) => onChange({ spacing: v })} min={0} max={20} suffix="mm" />
            </F>
          </div>
          <Toggle label={t("docb-uppercase")} checked={!!b.uppercase} onChange={(v) => onChange({ uppercase: v })} />
        </div>
      );

    case "paragraph":
      return (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <RichToolbar target="rich" />
            <AlignPicker value={b.align} onChange={(v) => onChange({ align: v })} />
          </div>
          <RichEdit html={b.html} onChange={(html) => onChange({ html })} registerFocus={richRegister} />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <F label={t("docb-scale")}>
              <Num value={b.scale ?? 100} onChange={(v) => onChange({ scale: v })} min={70} max={160} suffix="%" />
            </F>
            <F label={t("docb-line-height")}>
              <Num value={b.lineHeight ?? 1.5} onChange={(v) => onChange({ lineHeight: v })} min={1} max={2.2} step={0.1} />
            </F>
            <F label={t("docb-color")}>
              <ColorIn value={b.color} onChange={(v) => onChange({ color: v })} />
            </F>
            <F label={t("docb-spacing")}>
              <Num value={b.spacing ?? 4} onChange={(v) => onChange({ spacing: v })} min={0} max={20} suffix="mm" />
            </F>
          </div>
        </div>
      );

    case "list":
      return (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Toggle label={t("docb-ordered")} checked={b.ordered} onChange={(v) => onChange({ ordered: v })} />
            <F label={t("docb-marker")} className="min-w-36">
              <Select value={b.marker} onValueChange={(v) => onChange({ marker: v as typeof b.marker })}>
                <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["decimal", "lower-alpha", "upper-alpha", "lower-roman", "upper-roman", "disc"].map((m) => (
                    <SelectItem key={m} value={m}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </F>
            <AlignPicker value={b.align} onChange={(v) => onChange({ align: v })} allowJustify={false} />
          </div>
          <div className="space-y-2">
            {b.items.map((it, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <span className="w-5 shrink-0 text-right text-xs text-muted-foreground tabular">{i + 1}.</span>
                <Input
                  value={it}
                  onChange={(e) => onChange({ items: b.items.map((x, j) => (j === i ? e.target.value : x)) })}
                  className="h-8 text-sm"
                  placeholder={t("docb-item")}
                />
                <Button variant="ghost" size="sm" className="size-7 shrink-0 p-0 text-destructive" onClick={() => onChange({ items: b.items.filter((_, j) => j !== i) })} aria-label={t("docb-remove")}>
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" className="h-8" onClick={() => onChange({ items: [...b.items, ""] })}>
              <Plus className="size-3.5" />
              <span className="ml-1">{t("docb-add-item")}</span>
            </Button>
          </div>
        </div>
      );

    case "fields":
      return (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_1.4fr_auto]">
            {b.items.map((f, i) => (
              <div key={i} className="contents">
                <Input
                  value={f.label}
                  onChange={(e) => onChange({ items: b.items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })}
                  className="h-8 text-sm" placeholder={t("docb-label")}
                />
                <Input
                  value={f.value}
                  onChange={(e) => onChange({ items: b.items.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
                  className="h-8 font-mono text-xs" placeholder="{doc_date}"
                />
                <Button variant="ghost" size="sm" className="size-7 p-0 text-destructive" onClick={() => onChange({ items: b.items.filter((_, j) => j !== i) })} aria-label={t("docb-remove")}>
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" className="h-8" onClick={() => onChange({ items: [...b.items, { label: "", value: "" }] })}>
              <Plus className="size-3.5" />
              <span className="ml-1">{t("docb-add-field")}</span>
            </Button>
            <F label={t("docb-label-width")} className="w-32">
              <Num value={b.labelWidth} onChange={(v) => onChange({ labelWidth: v })} min={20} max={50} suffix="%" />
            </F>
            <Toggle label={t("docb-borders")} checked={b.borders} onChange={(v) => onChange({ borders: v })} />
            <Toggle label={t("docb-striped")} checked={b.striped} onChange={(v) => onChange({ striped: v })} />
          </div>
        </div>
      );

    case "table":
      return (
        <div className="space-y-3">
          <F label={t("docb-source")}>
            <Select value={b.source} onValueChange={(v) => onChange({ source: v as "custom" | "items" })}>
              <SelectTrigger className="h-8 w-72"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="items">{t("docb-source-items")}</SelectItem>
                <SelectItem value="custom">{t("docb-source-custom")}</SelectItem>
              </SelectContent>
            </Select>
          </F>
          {b.source === "items" ? (
            <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
              {t("docb-items-note")}
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <div className="grid gap-1.5 sm:grid-cols-12">
                  {b.columns.map((c, i) => (
                    <div key={i} className="contents">
                      <Input
                        value={c}
                        onChange={(e) => onChange({ columns: b.columns.map((x, j) => (j === i ? e.target.value : x)) })}
                        className="h-8 text-xs sm:col-span-4" placeholder={`${t("docb-column")} ${i + 1}`}
                      />
                      <Input
                        type="number"
                        value={b.widths[i] ?? 25}
                        min={4} max={60}
                        onChange={(e) => {
                          const w = [...b.widths];
                          w[i] = Number(e.target.value) || 10;
                          onChange({ widths: w });
                        }}
                        className="h-8 text-xs tabular sm:col-span-2"
                        aria-label={`${t("docb-widths")} ${i + 1}`}
                      />
                    </div>
                  ))}
                </div>
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onChange({ columns: [...b.columns, t("docb-column")], widths: [...b.widths, 10] })}>
                  <Plus className="size-3" /> {t("docb-add-column")}
                </Button>
              </div>
              <div className="space-y-1.5">
                {b.rows.map((row, r) => (
                  <div key={r} className="flex items-center gap-1.5">
                    <div className="grid flex-1 gap-1.5" style={{ gridTemplateColumns: `repeat(${b.columns.length}, minmax(0, 1fr))` }}>
                      {b.columns.map((_, c) => (
                        <Input
                          key={c}
                          value={row[c] ?? ""}
                          onChange={(e) => onChange({ rows: b.rows.map((x, j) => (j === r ? x.map((y, k) => (k === c ? e.target.value : y)) : x)) })}
                          className="h-8 font-mono text-xs"
                          placeholder="{partner_name}"
                        />
                      ))}
                    </div>
                    <Button variant="ghost" size="sm" className="size-7 shrink-0 p-0 text-destructive" onClick={() => onChange({ rows: b.rows.filter((_, j) => j !== r) })} aria-label={t("docb-remove")}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))}
                <Button variant="outline" size="sm" className="h-8" onClick={() => onChange({ rows: [...b.rows, b.columns.map(() => "")] })}>
                  <Plus className="size-3.5" />
                  <span className="ml-1">{t("docb-add-row")}</span>
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Toggle label={t("docb-header-row")} checked={b.headerRow} onChange={(v) => onChange({ headerRow: v })} />
                <Toggle label={t("docb-zebra")} checked={b.zebra} onChange={(v) => onChange({ zebra: v })} />
                <F label={t("docb-borders")}>
                  <Select value={b.borders} onValueChange={(v) => onChange({ borders: v as "all" | "horizontal" | "none" })}>
                    <SelectTrigger className="h-8 w-32"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">all</SelectItem>
                      <SelectItem value="horizontal">horizontal</SelectItem>
                      <SelectItem value="none">none</SelectItem>
                    </SelectContent>
                  </Select>
                </F>
                <AlignPicker value={b.align} onChange={(v) => onChange({ align: v })} allowJustify={false} />
              </div>
            </>
          )}
          <Toggle label={t("docb-show-totals")} checked={b.showTotals !== false} onChange={(v) => onChange({ showTotals: v })} />
        </div>
      );

    case "quote":
      return (
        <div className="space-y-3">
          <RichToolbar target="rich" />
          <RichEdit html={b.html} onChange={(html) => onChange({ html })} registerFocus={richRegister} />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <F label={t("docb-accent")}>
              <ColorIn value={b.accent} onChange={(v) => onChange({ accent: v })} />
            </F>
            <F label={t("docb-spacing")}>
              <Num value={b.spacing ?? 4} onChange={(v) => onChange({ spacing: v })} min={0} max={20} suffix="mm" />
            </F>
            <div className="flex items-end">
              <Toggle label={t("docb-background")} checked={b.background} onChange={(v) => onChange({ background: v })} />
            </div>
          </div>
        </div>
      );

    case "divider":
      return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <F label={t("docb-style")}>
            <Select value={b.style} onValueChange={(v) => onChange({ style: v as "solid" | "dashed" | "dotted" })}>
              <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="solid">solid</SelectItem>
                <SelectItem value="dashed">dashed</SelectItem>
                <SelectItem value="dotted">dotted</SelectItem>
              </SelectContent>
            </Select>
          </F>
          <F label={t("docb-thickness")}>
            <Num value={b.thickness} onChange={(v) => onChange({ thickness: v })} min={0.5} max={4} step={0.5} suffix="pt" />
          </F>
          <F label={t("docb-width")}>
            <Num value={b.width} onChange={(v) => onChange({ width: v })} min={20} max={100} suffix="%" />
          </F>
          <F label={t("docb-color")}>
            <ColorIn value={b.color} onChange={(v) => onChange({ color: v })} />
          </F>
        </div>
      );

    case "spacer":
      return (
        <F label={t("docb-height")}>
          <Num value={b.height} onChange={(v) => onChange({ height: v })} min={2} max={80} suffix="mm" />
        </F>
      );

    case "pagebreak":
      return (
        <p className="text-xs text-muted-foreground">{t("docb-pagebreak-note")}</p>
      );

    case "image": {
      const onFile = async (file: File | undefined) => {
        if (!file) return;
        if (file.size > 1.5 * 1024 * 1024) {
          toast.error(t("docb-image-too-large"));
          return;
        }
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result));
          fr.onerror = () => reject(new Error("read failed"));
          fr.readAsDataURL(file);
        });
        onChange({ src: dataUrl });
      };
      return (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm hover:bg-accent">
              <ImagePlus className="size-4" />
              <span>{t("docb-upload-image")}</span>
              <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} />
            </label>
            {b.src ? (
              <img src={b.src} alt="" className="h-12 w-12 rounded-md border border-border/60 object-contain" />
            ) : (
              <span className="text-xs text-muted-foreground">{t("docb-no-image")}</span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <F label={t("docb-width")}>
              <Num value={b.width} onChange={(v) => onChange({ width: v })} min={10} max={100} suffix="%" />
            </F>
            <F label={t("docb-align")}>
              <Select value={b.align as string} onValueChange={(v) => onChange({ align: v as "left" | "center" | "right" })}>
                <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="left">left</SelectItem>
                  <SelectItem value="center">center</SelectItem>
                  <SelectItem value="right">right</SelectItem>
                </SelectContent>
              </Select>
            </F>
            <F label={t("docb-caption")}>
              <Input value={b.caption ?? ""} onChange={(e) => onChange({ caption: e.target.value })} className="h-8 text-xs" />
            </F>
            <div className="flex items-end">
              <Toggle label={t("docb-rounded")} checked={b.rounded} onChange={(v) => onChange({ rounded: v })} />
            </div>
          </div>
        </div>
      );
    }

    case "signature":
      return (
        <div className="space-y-3">
          <div className="space-y-1.5">
            {b.parties.map((p, i) => (
              <div key={i} className="grid gap-1.5 sm:grid-cols-[1.2fr_0.8fr_1.2fr_auto]">
                <Input value={p.name} onChange={(e) => onChange({ parties: b.parties.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} className="h-8 text-sm" placeholder="{company_name}" />
                <Input value={p.role} onChange={(e) => onChange({ parties: b.parties.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)) })} className="h-8 text-xs" placeholder={t("docb-party-role")} />
                <Input value={p.label} onChange={(e) => onChange({ parties: b.parties.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} className="h-8 text-xs" placeholder={t("docb-party-label")} />
                <Button variant="ghost" size="sm" className="size-7 p-0 text-destructive" onClick={() => onChange({ parties: b.parties.filter((_, j) => j !== i) })} aria-label={t("docb-remove")}>
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" className="h-8" onClick={() => onChange({ parties: [...b.parties, { name: "", role: "", label: "" }] })}>
              <Plus className="size-3.5" />
              <span className="ml-1">{t("docb-add-party")}</span>
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <F label={t("docb-layout")}>
              <Select value={b.layout} onValueChange={(v) => onChange({ layout: v as "row" | "column" })}>
                <SelectTrigger className="h-8 w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="row">{t("docb-layout-row")}</SelectItem>
                  <SelectItem value="column">{t("docb-layout-column")}</SelectItem>
                </SelectContent>
              </Select>
            </F>
            <Toggle label={t("docb-with-date")} checked={b.withDate} onChange={(v) => onChange({ withDate: v })} />
            <F label={t("docb-spacing")}>
              <Num value={b.spacing ?? 4} onChange={(v) => onChange({ spacing: v })} min={0} max={20} suffix="mm" />
            </F>
          </div>
        </div>
      );

    default:
      return null;
  }
}

// ── Client-side draft preview (used by TemplateMiniPreview) ────────────────

/** Render a block list as scaled HTML — the draft preview of the authored
 *  body. Mirrors the react-pdf renderer's layout semantics (spacing, fonts,
 *  colors, table/fields rows) at browser scale. */
export function BlocksHtmlPreview({
  blocks, scale, primaryColor, resolveVariable,
}: {
  blocks: DocBlock[];
  scale: number; // px per mm
  primaryColor: string;
  resolveVariable: (token: string) => string;
}) {
  const mm = (v: number) => Math.max(1, Math.round(v * scale));
  const blockSpacing = (b: DocBlock): number =>
    b.type === "spacer" || b.type === "pagebreak" ? 0 : ((b as { spacing?: number }).spacing ?? 0);
  const runs = (html: string) =>
    htmlToRuns(html).map((r, i) => (
      <span
        key={i}
        style={{
          fontWeight: r.bold ? 700 : undefined,
          fontStyle: r.italic ? "italic" : undefined,
          textDecoration: r.underline ? "underline" : r.strike ? "line-through" : undefined,
          color: r.color || undefined,
          backgroundColor: r.highlight || undefined,
        }}
      >
        {r.text.replace(/\{([a-z0-9_]+)\}/gi, (m, tk) => resolveVariable(tk) || m)}
      </span>
    ));

  return (
    <div className="flex w-full flex-col" style={{ fontSize: 11 }}>
      {blocks.map((b) => {
        const mb = mm(blockSpacing(b));
        switch (b.type) {
          case "heading": {
            const h = b.level === 1 ? 1.5 : b.level === 2 ? 1.2 : 1;
            return (
              <div key={b.id} style={{ marginBottom: mb, marginTop: 2, color: b.color || primaryColor, fontWeight: 700, fontSize: `${11 * (b.scale ?? 140) / 100 * h}pt`, textAlign: b.align === "justify" ? "left" : b.align, textTransform: b.uppercase ? "uppercase" : undefined, letterSpacing: 0.3, width: "100%" }}>
                {runs(b.html)}
              </div>
            );
          }
          case "paragraph":
            return (
              <div key={b.id} style={{ marginBottom: mb, width: "100%", fontSize: `${11 * (b.scale ?? 100) / 100}pt`, lineHeight: b.lineHeight ?? 1.5, textAlign: b.align, color: "#1a1a1a" }}>
                {runs(b.html)}
              </div>
            );
          case "list":
            return (
              <div key={b.id} style={{ marginBottom: mb, width: "100%", color: "#1a1a1a" }}>
                {b.items.map((it, i) => (
                  <div key={i} style={{ display: "flex", gap: 4, marginBottom: 2 }}>
                    <span style={{ color: primaryColor, minWidth: 14 }}>{b.ordered ? `${i + 1}.` : "•"}</span>
                    <span style={{ flex: 1 }}>{runs(it)}</span>
                  </div>
                ))}
              </div>
            );
          case "fields":
            return (
              <div key={b.id} style={{ marginBottom: mb, width: "100%", border: b.borders ? "1px solid #e5e7eb" : undefined, borderRadius: 3, overflow: "hidden" }}>
                {b.items.filter((f) => f.label || f.value).map((f, i) => (
                  <div key={i} style={{ display: "flex", padding: "3px 6px", background: b.striped && i % 2 ? "#f8fafc" : undefined, borderBottom: b.borders && i < b.items.length - 1 ? "1px solid #f1f5f9" : undefined, color: "#1a1a1a" }}>
                    <span style={{ width: `${b.labelWidth}%`, opacity: 0.75, fontSize: "9.5pt" }}>{f.label.replace(/\{([a-z0-9_]+)\}/gi, (m, tk) => resolveVariable(tk) || m)}</span>
                    <span style={{ flex: 1, paddingLeft: 8, fontSize: "9.5pt" }}>{runs(f.value)}</span>
                  </div>
                ))}
              </div>
            );
          case "table":
            return (
              <div key={b.id} style={{ marginBottom: mb, width: "100%" }}>
                {b.source === "items" ? (
                  <>
                    <div style={{ display: "flex", background: primaryColor, color: "#fff", padding: "4px 6px", fontWeight: 600, fontSize: "8.5pt" }}>
                      <span style={{ flex: "0 0 24px" }}>#</span>
                      <span style={{ flex: 3 }}>Description</span>
                      <span style={{ flex: 1, textAlign: "right" }}>Qty</span>
                      <span style={{ flex: 1.2, textAlign: "right" }}>Unit price</span>
                      <span style={{ flex: 1.1, textAlign: "right" }}>Total</span>
                    </div>
                    <div style={{ padding: "5px 6px", fontSize: "8.5pt", color: "#6b7280", fontStyle: "italic" }}>
                      Line items of the generated document render here (live data)
                    </div>
                  </>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "9pt" }}>
                    {b.headerRow && (
                      <thead>
                        <tr style={{ background: primaryColor, color: "#fff" }}>
                          {b.columns.map((c, i) => (
                            <th key={i} style={{ textAlign: "left", padding: "4px 6px", fontWeight: 600, fontSize: "8.5pt", width: b.widths[i] ? `${b.widths[i]}%` : undefined }}>
                              {c.replace(/\{([a-z0-9_]+)\}/gi, (m, tk) => resolveVariable(tk) || m)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                    )}
                    <tbody>
                      {b.rows.map((row, r) => (
                        <tr key={r} style={{ background: b.zebra && r % 2 ? "#f8fafc" : undefined }}>
                          {b.columns.map((_, c) => (
                            <td key={c} style={{ padding: "3px 6px", borderBottom: b.borders !== "none" ? "1px solid #f1f5f9" : undefined, color: "#1a1a1a", textAlign: (b.align === "right" ? "right" : "left") as "right" | "left" }}>
                              {runs(row[c] ?? "")}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          case "quote":
            return (
              <div key={b.id} style={{ marginBottom: mb, width: "100%", borderLeft: `3px solid ${b.accent || primaryColor}`, background: b.background ? "#f8fafc" : undefined, padding: "6px 10px", borderRadius: 2, color: "#1a1a1a", fontSize: "10pt" }}>
                {runs(b.html)}
              </div>
            );
          case "divider":
            return (
              <div key={b.id} style={{ marginBottom: mb, marginTop: 2, width: `${b.width}%`, alignSelf: b.width >= 100 ? "stretch" : "center", borderBottom: `${Math.max(1, b.thickness)}px ${b.style} ${b.color || "#e5e7eb"}` }} />
            );
          case "spacer":
            return <div key={b.id} style={{ height: mm(b.height) }} />;
          case "pagebreak":
            return (
              <div key={b.id} className="my-2 flex items-center gap-2" style={{ color: "#9ca3af" }}>
                <span style={{ flex: 1, borderTop: "1px dashed #d1d5db" }} />
                <span style={{ fontSize: 8, letterSpacing: 1 }}>PAGE BREAK</span>
                <span style={{ flex: 1, borderTop: "1px dashed #d1d5db" }} />
              </div>
            );
          case "image":
            return (
              <div key={b.id} style={{ marginBottom: mb, width: "100%", textAlign: b.align === "center" ? "center" : b.align === "right" ? "right" : "left" }}>
                {b.src ? (
                  <img src={b.src} alt="" style={{ width: `${b.width}%`, borderRadius: b.rounded ? 6 : 0 }} />
                ) : (
                  <span className="text-[10px] text-muted-foreground">[ {b.caption || "image"} ]</span>
                )}
                {b.caption && b.src ? <div style={{ fontSize: 8, color: "#6b7280", marginTop: 3, textAlign: "center" }}>{b.caption}</div> : null}
              </div>
            );
          case "signature":
            return (
              <div key={b.id} style={{ marginTop: 10, marginBottom: mb, width: "100%", display: "flex", flexDirection: b.layout === "column" ? "column" : "row", flexWrap: "wrap", gap: 18 }}>
                {b.parties.map((p, i) => (
                  <div key={i} style={{ flex: b.layout === "column" ? "none" : 1, minWidth: 140 }}>
                    <div style={{ fontSize: "8pt", color: "#6b7280" }}>{p.role || p.name}</div>
                    <div style={{ fontWeight: 600, marginBottom: 16, color: "#1a1a1a" }}>{p.name}</div>
                    <div style={{ borderBottom: "1px solid #9ca3af", marginBottom: 3 }} />
                    <div style={{ fontSize: "7.5pt", color: "#6b7280" }}>{p.label}</div>
                    {b.withDate ? <div style={{ fontSize: "7.5pt", color: "#6b7280", marginTop: 2 }}>Date: ____________</div> : null}
                  </div>
                ))}
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
