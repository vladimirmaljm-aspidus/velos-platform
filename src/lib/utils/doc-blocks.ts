/**
 * VELOS Document Studio — block body model (audit35 "docstudio sync").
 * ----------------------------------------------------------------------------
 * Ported from the sandbox Document Template Studio into the production
 * platform: a template can now carry an authored BODY (a list of blocks —
 * headings, rich paragraphs, lists, info fields, tables, quotes, dividers,
 * spacers, page breaks, images, signature blocks) instead of the fixed
 * section flow. The FRAME (page setup + header + footer + QR + page number)
 * stays 100% memorandum-owned — blocks never touch it.
 *
 * This module is the single source of truth shared by:
 *   • the editor UI (src/components/common/template-blocks-editor.tsx)
 *   • the API payload sanitizer (src/lib/api/template-payload.ts)
 *   • the react-pdf renderer (src/lib/pdf/templates.tsx)
 *   • the browser live preview (TemplateMiniPreview)
 *
 * It is PURE TypeScript — no react-pdf, no DOM, no browser APIs — so it is
 * safe to import from both client and server code.
 */

// ── Block types ───────────────────────────────────────────────────────────

export type BlockAlign = "left" | "center" | "right" | "justify";

export interface BlockBase {
  id: string;
  type: string;
}

export interface HeadingBlock extends BlockBase {
  type: "heading";
  level: 1 | 2 | 3;
  html: string;
  align: BlockAlign;
  color?: string;
  /** percent scale of the body font, 80–200 */
  scale?: number;
  /** space after the block, mm, 0–20 */
  spacing?: number;
  uppercase?: boolean;
}

export interface ParagraphBlock extends BlockBase {
  type: "paragraph";
  html: string;
  align: BlockAlign;
  scale?: number;
  color?: string;
  lineHeight?: number;
  spacing?: number;
}

export interface ListBlock extends BlockBase {
  type: "list";
  ordered: boolean;
  marker: "decimal" | "lower-alpha" | "upper-alpha" | "lower-roman" | "upper-roman" | "disc" | "square";
  /** rich HTML per item (sanitized) */
  items: string[];
  align: BlockAlign;
  spacing?: number;
}

export interface FieldsBlock extends BlockBase {
  type: "fields";
  items: { label: string; value: string }[];
  /** label column width, percent 20–50 */
  labelWidth: number;
  borders: boolean;
  striped: boolean;
  spacing?: number;
}

export interface TableBlock extends BlockBase {
  type: "table";
  /** "custom" = static columns/rows authored in the editor;
   *  "items"  = the document's line items + totals (live data at render). */
  source: "custom" | "items";
  columns: string[];
  rows: string[][];
  /** percent per column (custom source only) */
  widths: number[];
  headerRow: boolean;
  zebra: boolean;
  borders: "all" | "horizontal" | "none";
  align: BlockAlign;
  showTotals?: boolean;
  spacing?: number;
}

export interface QuoteBlock extends BlockBase {
  type: "quote";
  html: string;
  accent?: string;
  background: boolean;
  spacing?: number;
}

export interface DividerBlock extends BlockBase {
  type: "divider";
  style: "solid" | "dashed" | "dotted";
  /** pt, 0.5–4 */
  thickness: number;
  color?: string;
  /** percent of content width, 20–100 */
  width: number;
  spacing?: number;
}

export interface SpacerBlock extends BlockBase {
  type: "spacer";
  /** mm, 2–80 */
  height: number;
}

export interface PageBreakBlock extends BlockBase {
  type: "pagebreak";
}

export interface ImageBlock extends BlockBase {
  type: "image";
  /** data: URL only (server-side rendering must never fetch remote URLs) */
  src: string;
  /** percent of content width, 10–100 */
  width: number;
  align: Omit<BlockAlign, "justify">;
  caption?: string;
  rounded: boolean;
  spacing?: number;
}

export interface SignatureBlock extends BlockBase {
  type: "signature";
  parties: { name: string; role: string; label: string }[];
  layout: "row" | "column";
  withDate: boolean;
  spacing?: number;
}

export type DocBlock =
  | HeadingBlock
  | ParagraphBlock
  | ListBlock
  | FieldsBlock
  | TableBlock
  | QuoteBlock
  | DividerBlock
  | SpacerBlock
  | PageBreakBlock
  | ImageBlock
  | SignatureBlock;

export type DocBlockType = DocBlock["type"];

/** The `document_templates.content_json` column shape. */
export interface BlocksContent {
  version: 1;
  blocks: DocBlock[];
}

export const BLOCK_TYPES: { type: DocBlockType; labelKey: string }[] = [
  { type: "heading", labelKey: "doc-block-type-heading" },
  { type: "paragraph", labelKey: "doc-block-type-paragraph" },
  { type: "list", labelKey: "doc-block-type-list" },
  { type: "fields", labelKey: "doc-block-type-fields" },
  { type: "table", labelKey: "doc-block-type-table" },
  { type: "quote", labelKey: "doc-block-type-quote" },
  { type: "divider", labelKey: "doc-block-type-divider" },
  { type: "spacer", labelKey: "doc-block-type-spacer" },
  { type: "pagebreak", labelKey: "doc-block-type-pagebreak" },
  { type: "image", labelKey: "doc-block-type-image" },
  { type: "signature", labelKey: "doc-block-type-signature" },
];

// ── Rich text (HTML subset) → runs ────────────────────────────────────────
//
// The editor edits rich text as HTML in a contentEditable. Only a strict
// allowlist survives sanitization:
//   tags:     b, strong, i, em, u, s, strike, br, span
//   attrs:    none, except span style="color:#hex; background-color:#hex"
// Everything else is stripped server-side (normalizeBlocks) AND client-side
// (sanitizeRichHtml) — a block's html can never smuggle markup, scripts or
// remote resources into the PDF or another user's browser.

export interface RichRun {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color?: string; // hex
  highlight?: string; // hex bg
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&nbsp;": " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

interface TagStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color?: string;
  highlight?: string;
}

const STYLE_TAG_EFFECT: Record<string, Partial<TagStyle>> = {
  b: { bold: true },
  strong: { bold: true },
  i: { italic: true },
  em: { italic: true },
  u: { underline: true },
  s: { strike: true },
  strike: { strike: true },
};

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function parseSpanStyle(style: string | undefined, into: TagStyle): void {
  if (!style) return;
  for (const decl of style.split(";")) {
    const [rawProp, ...rest] = decl.split(":");
    const prop = (rawProp || "").trim().toLowerCase();
    const val = rest.join(":").trim();
    if (!prop || !val) continue;
    if (prop === "color" && HEX_RE.test(val)) into.color = val.toLowerCase();
    if ((prop === "background-color" || prop === "backgroundcolor") && HEX_RE.test(val)) into.highlight = val.toLowerCase();
  }
}

/**
 * Parse the allowlisted HTML subset into styled runs. Unknown tags are
 * transparent (their text survives, their formatting does not); `<br>`
 * becomes "\n" inside the following run. Server-safe: no DOM, no regex
 * lookaheads on untrusted structure — a single left-to-right scan.
 */
export function htmlToRuns(html: string): RichRun[] {
  const runs: RichRun[] = [];
  const stack: TagStyle[] = [ { bold: false, italic: false, underline: false, strike: false } ];
  let buf = "";
  let i = 0;

  const flush = () => {
    if (!buf) return;
    const st = stack[stack.length - 1];
    runs.push({ text: buf, bold: st.bold, italic: st.italic, underline: st.underline, strike: st.strike, color: st.color, highlight: st.highlight });
    buf = "";
  };

  while (i < html.length) {
    if (html[i] === "<") {
      const close = html.indexOf(">", i);
      if (close === -1) { buf += "<"; i++; continue; } // stray "<" — literal
      // Only real tag syntax starts a tag: "<" + name + (space | "/" | ">" |
      // end), checked on the UNTRIMMED slice so "a < b" stays literal text
      // and nothing is consumed past the "<" until a valid tag is confirmed.
      const rawUntrimmed = html.slice(i + 1, close);
      if (!/^[a-zA-Z\/][a-zA-Z0-9]*(\s|\/|>|$)/.test(rawUntrimmed)) { buf += "<"; i++; continue; }
      const raw = rawUntrimmed.trim();
      i = close + 1;
      const closing = raw.startsWith("/");
      const name = (closing ? raw.slice(1) : raw).split(/[\s/>]/)[0].toLowerCase();
      if (name === "br" && !closing) {
        buf += "\n";
        continue;
      }
      if (name === "span") {
        flush();
        if (closing) {
          if (stack.length > 1) stack.pop();
        } else {
          const st = { ...stack[stack.length - 1] };
          const styleMatch = /style\s*=\s*"([^"]*)"/i.exec(raw) || /style\s*=\s*'([^']*)'/i.exec(raw);
          parseSpanStyle(styleMatch?.[1], st);
          stack.push(st);
        }
        continue;
      }
      const effect = STYLE_TAG_EFFECT[name];
      if (effect) {
        flush();
        if (closing) {
          if (stack.length > 1) stack.pop();
        } else {
          const st = { ...stack[stack.length - 1], ...effect };
          stack.push(st);
        }
        continue;
      }
      // Unknown tag — transparent: keep scanning (its inner text survives).
      continue;
    }
    const next = html.indexOf("<", i);
    const chunk = html.slice(i, next === -1 ? html.length : next);
    buf += decodeEntities(chunk);
    i = next === -1 ? html.length : next;
  }
  flush();
  // Merge stylistically identical adjacent runs; drop empties; cap length.
  const merged: RichRun[] = [];
  for (const r of runs) {
    const text = r.text.replace(/\u00a0/g, " ");
    if (!text) continue;
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.bold === r.bold && prev.italic === r.italic && prev.underline === r.underline &&
      prev.strike === r.strike && prev.color === r.color && prev.highlight === r.highlight
    ) {
      prev.text += text;
    } else {
      merged.push({ ...r, text });
    }
  }
  return merged;
}

/** Plain text of an allowlisted html string (for lengths, variables scan…). */
export function htmlToText(html: string): string {
  return htmlToRuns(html).map((r) => r.text).join("");
}

/**
 * Client-side sanitizer for the editor's contentEditable output. Strips
 * every tag/attribute outside the allowlist (same rules as htmlToRuns) so
 * the html we round-trip through save/render is always the safe subset.
 */
export function sanitizeRichHtml(html: string): string {
  let out = "";
  let i = 0;
  while (i < html.length) {
    if (html[i] === "<") {
      const close = html.indexOf(">", i);
      if (close === -1) { out += "&lt;"; i++; continue; }
      // Only real tag syntax starts a tag (checked UNTRIMMED — see
      // htmlToRuns): "a < b" stays escaped text.
      const rawUntrimmed = html.slice(i + 1, close);
      if (!/^[a-zA-Z\/][a-zA-Z0-9]*(\s|\/|>|$)/.test(rawUntrimmed)) { out += "&lt;"; i++; continue; }
      const raw = rawUntrimmed.trim();
      i = close + 1;
      const closing = raw.startsWith("/");
      const name = (closing ? raw.slice(1) : raw).split(/[\s/>]/)[0].toLowerCase();
      if (name === "br" && !closing) { out += "<br>"; continue; }
      if (name === "span") {
        if (closing) { out += "</span>"; continue; }
        const styleMatch = /style\s*=\s*"([^"]*)"/i.exec(raw) || /style\s*=\s*'([^']*)'/i.exec(raw);
        const st: TagStyle = { bold: false, italic: false, underline: false, strike: false };
        parseSpanStyle(styleMatch?.[1], st);
        const decls: string[] = [];
        if (st.color) decls.push(`color:${st.color}`);
        if (st.highlight) decls.push(`background-color:${st.highlight}`);
        out += decls.length ? `<span style="${decls.join(";")}">` : "<span>";
        continue;
      }
      const effect = STYLE_TAG_EFFECT[name];
      if (effect) {
        out += closing ? `</${name === "strong" ? "strong" : name === "em" ? "em" : name === "strike" ? "strike" : name}>` : `<${name}>`;
        continue;
      }
      continue; // unknown tag dropped
    }
    const next = html.indexOf("<", i);
    const chunk = html.slice(i, next === -1 ? html.length : next);
    // Re-escape bare text so the stored html is always well-formed.
    out += chunk.replace(/&(?!(amp|lt|gt|quot|#39|#x27|nbsp);)/g, "&amp;").replace(/</g, "&lt;");
    i = next === -1 ? html.length : next;
  }
  return out;
}

// ── Variables ─────────────────────────────────────────────────────────────

const VAR_RE = /\{([a-z0-9_]+)\}/gi;

/** All {tokens} used anywhere in a block list (for required-variable checks). */
export function findVariablesInBlocks(blocks: DocBlock[]): string[] {
  const found = new Set<string>();
  const scan = (s: string) => {
    for (const m of s.matchAll(VAR_RE)) found.add(m[1]);
  };
  for (const b of blocks) {
    switch (b.type) {
      case "heading": case "paragraph": case "quote": scan(b.html); break;
      case "list": b.items.forEach(scan); break;
      case "fields": b.items.forEach((it) => { scan(it.label); scan(it.value); }); break;
      case "table":
        (b.columns || []).forEach(scan);
        (b.rows || []).forEach((r) => (r || []).forEach(scan));
        break;
      case "image": if (b.caption) scan(b.caption); break;
      case "signature": (b.parties || []).forEach((p) => { scan(p.name); scan(p.role); scan(p.label); }); break;
      default: break;
    }
  }
  return [...found];
}

// ── Normalization (the server-side guard) ─────────────────────────────────
//
// normalizeBlocks() is the ONE validation gate for content_json. Both the
// API sanitizer (before save) and the PDF renderer (before render) call it,
// so what is saved is exactly what can render — no drift.

const MAX_BLOCKS = 80;
const MAX_HTML = 8_000;
const MAX_LIST_ITEMS = 60;
const MAX_FIELDS = 30;
const MAX_TABLE_COLS = 12;
const MAX_TABLE_ROWS = 200;
const MAX_SIG_PARTIES = 6;
const MAX_CONTENT_JSON = 96_000; // serialized bytes

function clampNum(v: unknown, min: number, max: number, dflt: number, round = false): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  const c = Math.min(max, Math.max(min, n));
  return round ? Math.round(c) : c;
}

function normAlign(v: unknown, dflt: BlockAlign = "left"): BlockAlign {
  return v === "left" || v === "center" || v === "right" || v === "justify" ? v : dflt;
}

function normHex(v: unknown, dflt?: string): string | undefined {
  return typeof v === "string" && HEX_RE.test(v.trim()) ? v.trim().toLowerCase() : dflt;
}

function normHtml(v: unknown): string {
  // Round-trip through the run parser: this strips EVERYTHING outside the
  // allowlist and re-escapes text — the stored html is always the safe subset.
  if (typeof v !== "string") return "";
  const runs = htmlToRuns(v.slice(0, MAX_HTML * 2));
  let out = "";
  for (const r of runs) {
    const text = r.text.slice(0, MAX_HTML).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>");
    const decls: string[] = [];
    if (r.color) decls.push(`color:${r.color}`);
    if (r.highlight) decls.push(`background-color:${r.highlight}`);
    const style = decls.length ? ` style="${decls.join(";")}"` : "";
    const open = r.bold ? "<b>" : r.italic ? "<i>" : r.underline ? "<u>" : r.strike ? "<s>" : "";
    const close = r.bold ? "</b>" : r.italic ? "</i>" : r.underline ? "</u>" : r.strike ? "</s>" : "";
    out += style ? `${open}<span${style}>${text}</span>${close}` : `${open}${text}${close}`;
  }
  return out.slice(0, MAX_HTML * 2);
}

function normId(v: unknown, i: number): string {
  const s = typeof v === "string" && v.trim() ? v.trim().slice(0, 40) : "";
  return s || `b${i}-${Math.random().toString(36).slice(2, 8)}`;
}

function normBool(v: unknown, dflt = false): boolean {
  return typeof v === "boolean" ? v : dflt;
}

function normText(v: unknown, max = 300): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/**
 * Strictly normalize a raw content_json value.
 *  • null/undefined/""/invalid → null  (no block body — legacy section flow)
 *  • valid      → { version: 1, blocks: DocBlock[] } fully clamped
 * Never throws — junk degrades to null so a bad payload can never poison
 * the renderer.
 */
export function normalizeBlocks(raw: unknown): BlocksContent | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    if (!raw.trim()) return null;
    try { return normalizeBlocks(JSON.parse(raw)); } catch { return null; }
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1 || !Array.isArray(obj.blocks)) return null;
  if (obj.blocks.length === 0) return null;
  if (obj.blocks.length > MAX_BLOCKS) return null;

  const blocks: DocBlock[] = [];
  for (let i = 0; i < obj.blocks.length; i++) {
    const rawB = obj.blocks[i];
    if (!rawB || typeof rawB !== "object") continue;
    const b = rawB as Record<string, unknown>;
    const id = normId(b.id, i);
    const align = normAlign(b.align);
    const spacing = clampNum(b.spacing, 0, 20, 4, true);

    switch (b.type) {
      case "heading":
        blocks.push({
          id, type: "heading",
          level: b.level === 2 ? 2 : b.level === 3 ? 3 : 1,
          html: normHtml(b.html),
          align,
          color: normHex(b.color),
          scale: clampNum(b.scale, 80, 200, 140, true),
          spacing,
          uppercase: normBool(b.uppercase),
        });
        break;
      case "paragraph":
        blocks.push({
          id, type: "paragraph",
          html: normHtml(b.html),
          align,
          scale: clampNum(b.scale, 70, 160, 100, true),
          color: normHex(b.color),
          lineHeight: clampNum(b.lineHeight, 1, 2.2, 1.4),
          spacing,
        });
        break;
      case "list": {
        const items = Array.isArray(b.items)
          ? b.items.slice(0, MAX_LIST_ITEMS).map((it) => normHtml(it)).filter((s) => s !== "")
          : [];
        if (!items.length) break;
        const marker = ["decimal", "lower-alpha", "upper-alpha", "lower-roman", "upper-roman", "disc", "square"].includes(String(b.marker))
          ? (b.marker as ListBlock["marker"]) : "decimal";
        blocks.push({ id, type: "list", ordered: normBool(b.ordered, true), marker, items, align, spacing });
        break;
      }
      case "fields": {
        const items = Array.isArray(b.items)
          ? b.items.slice(0, MAX_FIELDS).map((it) => {
              const f = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
              return { label: normText(f.label, 80), value: normHtml(f.value).slice(0, 600) };
            }).filter((it) => it.label || it.value)
          : [];
        if (!items.length) break;
        blocks.push({
          id, type: "fields", items,
          labelWidth: clampNum(b.labelWidth, 20, 50, 30, true),
          borders: normBool(b.borders, true),
          striped: normBool(b.striped, false),
          spacing,
        });
        break;
      }
      case "table": {
        const source = b.source === "items" ? "items" : "custom";
        const columns = Array.isArray(b.columns) ? b.columns.slice(0, MAX_TABLE_COLS).map((c) => normText(c, 60)) : [];
        const rows = Array.isArray(b.rows)
          ? b.rows.slice(0, MAX_TABLE_ROWS).map((r) => (Array.isArray(r) ? r.slice(0, MAX_TABLE_COLS).map((c) => normHtml(c).slice(0, 600)) : []))
          : [];
        if (source === "custom" && (!columns.length || !rows.length)) break;
        const widths = Array.isArray(b.widths)
          ? b.widths.slice(0, Math.max(columns.length, 1)).map((w) => clampNum(w, 4, 60, 10))
          : [];
        blocks.push({
          id, type: "table", source, columns, rows, widths,
          headerRow: normBool(b.headerRow, true),
          zebra: normBool(b.zebra, true),
          borders: b.borders === "horizontal" || b.borders === "none" ? b.borders : "all",
          align,
          showTotals: normBool(b.showTotals, source === "items"),
          spacing,
        });
        break;
      }
      case "quote":
        blocks.push({
          id, type: "quote",
          html: normHtml(b.html),
          accent: normHex(b.accent),
          background: normBool(b.background, true),
          spacing,
        });
        break;
      case "divider":
        blocks.push({
          id, type: "divider",
          style: b.style === "dashed" || b.style === "dotted" ? b.style : "solid",
          thickness: clampNum(b.thickness, 0.5, 4, 1, true) || 1,
          color: normHex(b.color),
          width: clampNum(b.width, 20, 100, 100, true),
          spacing,
        });
        break;
      case "spacer":
        blocks.push({ id, type: "spacer", height: clampNum(b.height, 2, 80, 12, true) });
        break;
      case "pagebreak":
        blocks.push({ id, type: "pagebreak" });
        break;
      case "image": {
        const src = typeof b.src === "string" && b.src.startsWith("data:image/") ? b.src.slice(0, 512_000) : "";
        if (!src) break;
        blocks.push({
          id, type: "image", src,
          width: clampNum(b.width, 10, 100, 60, true),
          align: b.align === "center" || b.align === "right" ? b.align : "left",
          caption: normText(b.caption, 300),
          rounded: normBool(b.rounded, false),
          spacing,
        });
        break;
      }
      case "signature": {
        const parties = Array.isArray(b.parties)
          ? b.parties.slice(0, MAX_SIG_PARTIES).map((p) => {
              const f = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
              return { name: normText(f.name, 120), role: normText(f.role, 120), label: normText(f.label, 120) };
            }).filter((p) => p.name || p.role || p.label)
          : [];
        if (!parties.length) break;
        blocks.push({
          id, type: "signature", parties,
          layout: b.layout === "column" ? "column" : "row",
          withDate: normBool(b.withDate, true),
          spacing,
        });
        break;
      }
      default:
        break; // unknown block type — dropped
    }
  }

  if (!blocks.length) return null;
  const content: BlocksContent = { version: 1, blocks };
  if (JSON.stringify(content).length > MAX_CONTENT_JSON) return null;
  return content;
}

// ── Starter block skeleton ────────────────────────────────────────────────

/**
 * The one-click professional start: convert a fixed-flow template to blocks
 * with the canonical layout (title → parties → items → totals → terms →
 * signatures) pre-authored with the live document variables. Used by the
 * editor's "Convert body to blocks" action.
 */
export function starterBlocks(docType: string): BlocksContent {
  const isInvoice = docType === "invoice" || docType === "proforma";
  return {
    version: 1,
    blocks: [
      {
        id: "st-title", type: "heading", level: 1, align: "left",
        html: isInvoice ? "INVOICE <b>{doc_number}</b>" : docType === "loi" ? "LETTER OF INTENT <b>{doc_number}</b>" : "OFFER <b>{doc_number}</b>",
        scale: 165, uppercase: false, spacing: 6,
      },
      {
        id: "st-meta", type: "fields", labelWidth: 24, borders: false, striped: false, spacing: 6,
        items: [
          { label: "Date", value: "{doc_date}" },
          { label: isInvoice ? "Due date" : "Valid until", value: isInvoice ? "{due_date}" : "{valid_until}" },
          { label: "Client", value: "<b>{partner_name}</b>" },
          { label: "Currency", value: "{currency}" },
        ],
      },
      {
        id: "st-greeting", type: "paragraph", align: "left", spacing: 6, lineHeight: 1.5,
        html: "Dear Sirs,<br><br>Thank you for your inquiry. We are pleased to submit the following offer / confirmation of terms:",
      },
      {
        id: "st-items", type: "table", source: "items", columns: [], rows: [], widths: [],
        headerRow: true, zebra: true, borders: "all", align: "left", showTotals: true, spacing: 8,
      },
      {
        id: "st-terms", type: "quote", background: true, spacing: 8,
        html: "Terms &amp; conditions: delivery, packing and payment as agreed unless otherwise stated in writing. This document is issued under the company's standard trading conditions.",
      },
      {
        id: "st-sig", type: "signature", layout: "row", withDate: true, spacing: 8,
        parties: [
          { name: "{company_name}", role: "Seller", label: "Authorised signature" },
          { name: "{partner_name}", role: "Buyer", label: "Accepted &amp; agreed" },
        ],
      },
    ],
  };
}
