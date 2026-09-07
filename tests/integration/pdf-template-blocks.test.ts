import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { extractText, getDocumentProxy } from "unpdf";
import { NextRequest } from "next/server";
import type { AuthContext } from "@/lib/api/helpers";

// ─── audit35 "Document Studio" — block bodies, versioning payload, memo lock ─
//
// The docstudio sync ported from the sandbox into the production platform.
// Covers the three production guarantees:
//   1. BLOCK BODIES: normalizeBlocks/htmlToRuns (the shared validation gate),
//      the react-pdf block renderer (frame stays memorandum-owned), variable
//      resolution, junk fallback to the classic fixed flow.
//   2. PAYLOAD: sanitizeTemplatePayload accepts content_json, drops dead
//      frame columns (nothing outside /api/memorandum-settings can write the
//      frame).
//   3. MEMO LOCK: PUT /api/memorandum-settings refuses field writes while
//      locked (423 MEMO_LOCKED), unlock requires the exact phrase, lock
//      action freezes, auto-create starts unlocked (setup mode).

import {
  normalizeBlocks, htmlToRuns, htmlToText, sanitizeRichHtml,
  findVariablesInBlocks, starterBlocks,
} from "@/lib/utils/doc-blocks";
import { sanitizeTemplatePayload, DROPPED_FRAME_COLUMNS } from "@/lib/api/template-payload";
import { buildPdfDocument } from "@/lib/pdf/templates";
import type { DocumentTemplate, Offer, Partner, Tenant } from "@/lib/supabase/types";

// ─── fixtures (mirror pdf-template-studio.test.ts) ─────────────────────────

async function renderAndExtract(element: React.ReactElement) {
  const buf = await renderToBuffer(element as any);
  expect(buf.length).toBeGreaterThan(500);
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: false });
  return { pdf, pages: (text as unknown as string[]).map((p) => String(p)) };
}

const tenant: Tenant = {
  id: "t1",
  name: "Aspidus Trading FZE",
  legal_name: "Aspidus Trading FZE LLC",
  country: "AE",
  currency: "USD",
  registration_number: "REG-778899",
  address_line: "Saif Zone, Block C",
  city: "Sharjah",
  email: "trade@aspidus.example",
  phone: "+971 55 111 2222",
  bank_accounts: JSON.stringify([
    { bankName: "Emirates NBD", currency: "USD", swiftCode: "EBILAEAD", accountNumber: "1234567890" },
  ]),
  bank_name: "Emirates NBD",
  bank_iban: null,
  bank_swift: "EBILAEAD",
  plan: "business",
  status: "active",
} as unknown as Tenant;

const partner: Partner = {
  id: "p1",
  tenant_id: "t1",
  name: "Horn of Africa Import Export PLC",
  address_line: "Bole Road 42",
  city: "Addis Ababa",
  country: "ET",
} as unknown as Partner;

const offer: Offer = {
  id: "o1",
  tenant_id: "t1",
  partner_id: "p1",
  number: "OFF-2026-0001",
  status: "sent",
  currency: "USD",
  subtotal: 38500,
  tax_total: 0,
  total: 38500,
  items: [
    { id: "li1", name: "Premium Arabica Coffee Grade 1", product_name: "Premium Arabica Coffee Grade 1", quantity: 700, unit: "MT", unit_price: 55, total: 38500 },
  ],
  valid_until: "2026-04-01",
  created_at: "2026-03-01T00:00:00Z",
} as unknown as Offer;

function makeTemplate(overrides: Record<string, unknown> = {}): DocumentTemplate {
  return {
    id: "tpl1",
    tenant_id: "t1",
    name: "Studio Offer",
    type: "offer",
    is_default: true,
    footer_content: JSON.stringify({ segments: [{ id: "f1", text: "Confidential", fontSize: 7, color: "#888888" }] }),
    body_font_family: "NotoSans",
    body_font_size: 9,
    body_line_height: 1.4,
    primary_color: "#0f766e",
    accent_color: "#0d9488",
    table_header_bg: "#0f766e",
    table_header_color: "#ffffff",
    table_border_color: "#e2e8f0",
    table_stripe: true,
    letterhead_id: null,
    seal_id: null,
    seal_enabled: false,
    created_by: null,
    created_at: "2026-03-01T00:00:00Z",
    updated_at: "2026-03-01T00:00:00Z",
    ...overrides,
  } as DocumentTemplate;
}

function renderWithTemplate(tpl: DocumentTemplate | null) {
  return React.createElement(buildPdfDocument, {
    doc: offer,
    docType: "offer",
    partner,
    tenant,
    memorandumSettings: null,
    template: tpl,
    qrCodeDataUrl: null,
    logoUrl: null,
  });
}

// ─── 1. doc-blocks — the shared validation gate ────────────────────────────

describe("audit35: doc-blocks — htmlToRuns (strict allowlist parser)", () => {
  it("parses b/i/u/s, nesting and br into styled runs", () => {
    const runs = htmlToRuns("<b>bold</b> plain <i><b>both</b> it</i><u>under</u><s>strike</s>a<br>b");
    expect(runs.find((r) => r.text === "bold")?.bold).toBe(true);
    expect(runs.find((r) => r.text === " plain ")?.bold).toBe(false);
    expect(runs.find((r) => r.text === "both")?.bold).toBe(true);
    expect(runs.find((r) => r.text === "both")?.italic).toBe(true);
    expect(runs.find((r) => r.text === "under")?.underline).toBe(true);
    expect(runs.find((r) => r.text === "strike")?.strike).toBe(true);
    expect(runs.some((r) => r.text.includes("\n"))).toBe(true); // <br> → newline
  });

  it("keeps span colour/highlight styles only for valid hex", () => {
    const runs = htmlToRuns('<span style="color:#b91c1c">red</span><span style="background-color:#fde68a">mark</span><span style="color:junk()">nope</span>');
    expect(runs.find((r) => r.text === "red")?.color).toBe("#b91c1c");
    expect(runs.find((r) => r.text === "mark")?.highlight).toBe("#fde68a");
    expect(runs.find((r) => r.text === "nope")?.color).toBeUndefined();
  });

  it("transparent for unknown tags — text survives, markup does not", () => {
    const runs = htmlToRuns("<script>alert(1)</script>safe<img src=x onerror=1>");
    const all = runs.map((r) => r.text).join("");
    expect(all).toContain("alert(1)");
    expect(all).toContain("safe");
    // The whole model is runs — tags can never reach the PDF or the browser.
    expect(JSON.stringify(runs)).not.toContain("<script");
    expect(JSON.stringify(runs)).not.toContain("onerror");
  });

  it("decodes entities and merges stylistically identical neighbours", () => {
    expect(htmlToText("a &amp; b &lt;c&gt;")).toBe("a & b <c>");
    const runs = htmlToRuns("one<b></b>two");
    expect(runs).toHaveLength(1);
    expect(runs[0].text).toBe("onetwo");
  });

  it("sanitizeRichHtml round-trips only the allowlist and escapes bare text", () => {
    const clean = sanitizeRichHtml('a < b & <b>c</b><span style="color:#111">d</span><script>x</script>');
    expect(clean).toContain("a &lt; b &amp;");
    expect(clean).toContain("<b>c</b>");
    expect(clean).toContain('<span style="color:#111">d</span>');
    expect(clean).not.toContain("<script");
    // Round-trip through the parser: the MARKUP never survives — the
    // script's inner text does, as inert plain text.
    expect(htmlToText(clean)).toBe("a < b & cdx");
  });
});

describe("audit35: doc-blocks — normalizeBlocks (server-side guard)", () => {
  it("null / empty / junk → null (legacy fixed flow)", () => {
    expect(normalizeBlocks(null)).toBeNull();
    expect(normalizeBlocks(undefined)).toBeNull();
    expect(normalizeBlocks("")).toBeNull();
    expect(normalizeBlocks("not json")).toBeNull();
    expect(normalizeBlocks({ version: 2, blocks: [] })).toBeNull();
    expect(normalizeBlocks({ version: 1, blocks: [] })).toBeNull();
    expect(normalizeBlocks([1, 2])).toBeNull();
  });

  it("clamps every numeric and keeps ids stable", () => {
    const c = normalizeBlocks({
      version: 1,
      blocks: [
        { id: "h1", type: "heading", html: "Title", align: "left", scale: 999, spacing: 999 },
        { id: "sp", type: "spacer", height: 500 },
        { id: "pb", type: "pagebreak" },
      ],
    });
    expect(c).not.toBeNull();
    const heading = c!.blocks[0] as any;
    expect(heading.scale).toBe(200);
    expect(heading.spacing).toBe(20);
    expect((c!.blocks[1] as any).height).toBe(80);
    expect(c!.blocks.map((b) => b.id)).toEqual(["h1", "sp", "pb"]);
  });

  it("rejects remote image URLs (data: only — no server-side fetching)", () => {
    const c = normalizeBlocks({
      version: 1,
      blocks: [{ id: "i1", type: "image", src: "https://evil.example/x.png", width: 50, align: "center" }],
    });
    // The image block is dropped (invalid src) → no blocks → null.
    expect(c).toBeNull();
    const ok = normalizeBlocks({
      version: 1,
      blocks: [{ id: "i1", type: "image", src: "data:image/png;base64,AAAA", width: 50, align: "center" }],
    });
    expect((ok!.blocks[0] as any).src.startsWith("data:image/")).toBe(true);
  });

  it("strips unsafe MARKUP from block html (text content survives, tags never do)", () => {
    const c = normalizeBlocks({
      version: 1,
      blocks: [{ id: "p1", type: "paragraph", html: 'hello <script>alert(1)</script><b>world</b><span style="color:#b91c1c">!</span>', align: "left" }],
    });
    const html = (c!.blocks[0] as any).html;
    expect(html).toContain("<b>world</b>");
    // The tag is gone — its body text survives as PLAIN TEXT (inert in PDF
    // and browser; the model only ever produces runs).
    expect(html).not.toContain("<script");
    expect(html).not.toContain("</script>");
    // Round-trips into runs without any markup.
    expect(JSON.stringify(htmlToRuns(html))).not.toContain("script");
  });

  it("finds variables across block types", () => {
    const c = starterBlocks("offer");
    const vars = findVariablesInBlocks(c!.blocks);
    expect(vars).toContain("doc_number");
    expect(vars).toContain("partner_name");
    expect(vars).toContain("company_name");
    expect(vars).toContain("currency");
  });

  it("starterBlocks gives the professional 6-block skeleton", () => {
    const c = starterBlocks("offer");
    expect(c!.blocks.map((b) => b.type)).toEqual(["heading", "fields", "paragraph", "table", "quote", "signature"]);
    expect((c!.blocks[3] as any).source).toBe("items");
  });
});

// ─── 2. payload sanitizer — content_json + frame columns ────────────────────

describe("audit35: sanitizeTemplatePayload — content_json + dead frame columns", () => {
  it("accepts a valid block body (normalized) and keeps footer_content", () => {
    const { sanitized } = sanitizeTemplatePayload({
      name: "X",
      footer_content: "plain",
      content_json: { version: 1, blocks: [{ id: "p", type: "paragraph", html: "hi", align: "left", scale: 999 }] },
    } as any);
    expect(sanitized.footer_content).toBe("plain");
    expect((sanitized.content_json as any).blocks[0].scale).toBe(160); // paragraph clamp 70-160
    expect(sanitized.page_size).toBeUndefined();
  });

  it("drops junk content_json instead of nulling existing content", () => {
    const { sanitized } = sanitizeTemplatePayload({ content_json: { version: 9, blocks: "junk" } } as any);
    expect(sanitized.content_json).toBeUndefined();
  });

  it("honours an explicit null (clears the block body on purpose)", () => {
    const { sanitized } = sanitizeTemplatePayload({ content_json: null } as any);
    expect(sanitized.content_json).toBeNull();
  });

  it("drops every dead frame column — the memo is the only frame writer", () => {
    const payload: Record<string, unknown> = {
      name: "X",
      page_size: "Letter",
      page_margin_top: 5,
      header_height: 40,
      header_content: "junk",
      footer_height: 30,
      footer_show_page_number: false,
      qr_position: "footer-left",
    };
    const { sanitized, dropped } = sanitizeTemplatePayload(payload as any);
    for (const col of DROPPED_FRAME_COLUMNS) {
      expect(sanitized[col]).toBeUndefined();
    }
    expect(dropped).toEqual(expect.arrayContaining(["page_size", "header_content", "footer_height"]));
    expect(sanitized.name).toBe("X");
  });
});

// ─── 3. renderer — block-authored bodies in the real PDF ────────────────────

describe("audit35: react-pdf block renderer", () => {
  const blockBody = {
    version: 1,
    blocks: [
      { id: "b1", type: "heading", level: 1, html: "PURCHASE <b>CONFIRMATION</b>", align: "left", scale: 160, spacing: 4 },
      { id: "b2", type: "fields", items: [{ label: "Client", value: "{partner_name}" }, { label: "No.", value: "{doc_number}" }], labelWidth: 28, borders: false, striped: false, spacing: 4 },
      { id: "b3", type: "paragraph", html: "We confirm the supply of Premium Arabica <b>Coffee</b> under the terms below.", align: "left", spacing: 4 },
      { id: "b4", type: "table", source: "items", columns: [], rows: [], widths: [], headerRow: true, zebra: true, borders: "all", align: "left", showTotals: true, spacing: 4 },
      { id: "b5", type: "signature", parties: [{ name: "{company_name}", role: "Seller", label: "Authorised signature" }], layout: "row", withDate: true, spacing: 4 },
    ],
  };

  it("renders the authored blocks with live variables and the document's items", async () => {
    const { pages } = await renderAndExtract(renderWithTemplate(makeTemplate({ content_json: blockBody })));
    const all = pages.join("\n");
    // Heading + rich text
    expect(all).toContain("PURCHASE");
    expect(all).toContain("CONFIRMATION");
    // Fields with resolved variables
    expect(all).toContain("Horn of Africa Import Export PLC");
    expect(all).toContain("OFF-2026-0001");
    // Paragraph
    expect(all).toContain("Premium Arabica");
    // Items table renders the real offer line + totals
    expect(all).toContain("Premium Arabica Coffee Grade 1");
    expect(all).toContain("38,500");
    expect(all).toContain("GRAND TOTAL");
    // Signature block resolves the company variable
    expect(all).toContain("Aspidus Trading FZE");
    // The memo frame still owns the header (tenant legal name)
    expect(all).toContain("Aspidus");
  });

  it("a block body REPLACES the fixed section flow (no classic-only sections)", async () => {
    const { pages } = await renderAndExtract(renderWithTemplate(makeTemplate({ content_json: blockBody })));
    const all = pages.join("\n");
    // "Amount in Words" is exclusive to the classic totals section flow
    // (rendered uppercase by the label style).
    expect(all.toUpperCase()).not.toContain("AMOUNT IN WORDS");
    // The trade-terms grid is classic-flow only.
    expect(all).not.toContain("Incoterm");
  });

  it("junk content_json falls back to the classic fixed flow", async () => {
    const { pages } = await renderAndExtract(renderWithTemplate(makeTemplate({ content_json: { version: 1, blocks: "junk" } })));
    const all = pages.join("\n");
    expect(all.toUpperCase()).toContain("AMOUNT IN WORDS"); // classic flow intact
    expect(all).toContain("Premium Arabica Coffee Grade 1");
  });

  it("content_json null (legacy templates) renders the classic flow unchanged", async () => {
    const { pages } = await renderAndExtract(renderWithTemplate(makeTemplate()));
    expect(pages.join("\n").toUpperCase()).toContain("AMOUNT IN WORDS");
  });

  it("a pagebreak block forces a second page", async () => {
    const withBreak = {
      version: 1,
      blocks: [
        { id: "h", type: "heading", level: 1, html: "First page", align: "left", scale: 140 },
        { id: "pb", type: "pagebreak" },
        { id: "h2", type: "heading", level: 1, html: "Second page", align: "left", scale: 140 },
      ],
    };
    const { pages } = await renderAndExtract(renderWithTemplate(makeTemplate({ content_json: withBreak })));
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pages[0]).toContain("First page");
    expect(pages[1]).toContain("Second page");
  });

  it("custom tables render authored cells with variable resolution", async () => {
    const customTable = {
      version: 1,
      blocks: [
        { id: "t", type: "table", source: "custom", columns: ["Item", "Client"], rows: [["Rice 5%", "{partner_name}"]], widths: [50, 50], headerRow: true, zebra: false, borders: "all", align: "left", showTotals: false, spacing: 4 },
      ],
    };
    const { pages } = await renderAndExtract(renderWithTemplate(makeTemplate({ content_json: customTable })));
    const all = pages.join("\n");
    expect(all).toContain("Rice 5%");
    expect(all).toContain("Horn of Africa Import Export PLC");
  });
});

// ─── 4. memorandum lock — the hard guarantee ────────────────────────────────

// Mock strategy mirrors tests/integration/admin-errors-route.test.ts.
const { mockRequireAuth, mockAudit, mockResolveTenantId, mockAssertNumeric, mockFrom } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockAudit: vi.fn(async () => {}),
  mockResolveTenantId: vi.fn(() => "tenant-A"),
  mockAssertNumeric: vi.fn(() => null),
  mockFrom: vi.fn(),
}));

vi.mock("@/lib/api/helpers", () => ({
  requireAuth: mockRequireAuth,
  audit: mockAudit,
  resolveTenantId: mockResolveTenantId,
}));
vi.mock("@/lib/permissions/can", () => ({
  requirePermission: vi.fn(() => null),
}));
vi.mock("@/lib/api/validate", () => ({
  assertNumeric: mockAssertNumeric,
}));
vi.mock("@/lib/supabase/client", () => ({
  getSupabase: vi.fn(() => ({ from: mockFrom })),
}));

import { GET, PUT } from "@/app/api/memorandum-settings/route";

function makeAuthCtx(): AuthContext {
  return {
    user: {
      id: "u-1", tenant_id: "tenant-A", username: "dejan", email: "dejan@aspidus.co",
      full_name: null, role: "admin", permissions: null, active: true, token_version: 1,
    } as unknown as AuthContext["user"],
    store: { appendAudit: vi.fn(async () => ({})) } as unknown as AuthContext["store"],
    ip: "127.0.0.1",
    isSuperAdmin: false,
  } as unknown as AuthContext;
}

/** Chainable fake Supabase query builder. */
function chain(result: { data: unknown; error?: unknown }) {
  const c: any = {
    select: vi.fn(() => c),
    eq: vi.fn(() => c),
    insert: vi.fn(() => c),
    update: vi.fn(() => c),
    maybeSingle: vi.fn(async () => result),
  };
  return c;
}

function req(method: "GET" | "PUT", body?: unknown) {
  const url = "http://localhost/api/memorandum-settings?tenant_id=tenant-A";
  return new NextRequest(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }) as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue(makeAuthCtx());
  mockResolveTenantId.mockReturnValue("tenant-A");
  mockAssertNumeric.mockReturnValue(null);
});

describe("audit35: memorandum lock API — nothing changes the frame by mistake", () => {
  it("PUT with fields while locked → 423 MEMO_LOCKED (no write attempted)", async () => {
    mockFrom.mockReturnValue(chain({ data: { id: "m1", locked: true } }));
    const r = await PUT(req("PUT", { header_height_mm: 40, page_size: "A4" }));
    expect(r.status).toBe(423);
    const body = await r.json();
    expect(body.code).toBe("MEMO_LOCKED");
    expect(body.locked).toBe(true);
    // The update chain was never even built.
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it("PUT unlock with a wrong phrase → 400, still locked", async () => {
    mockFrom.mockReturnValue(chain({ data: { id: "m1", locked: true } }));
    const r = await PUT(req("PUT", { action: "unlock", unlock_phrase: "please" }));
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe("MEMO_LOCKED");
  });

  it("PUT unlock with the exact phrase MEMORANDUM → locked=false written", async () => {
    const updateChain = chain({ data: { id: "m1", locked: false } });
    mockFrom.mockReturnValue(chain({ data: { id: "m1", locked: true } }));
    // second from() call (the update) uses the update chain
    mockFrom.mockImplementation((table: string) =>
      table === "memorandum_settings" ? (mockFrom.mock.calls.length <= 1 ? chain({ data: { id: "m1", locked: true } }) : updateChain) : chain({ data: null }),
    );
    const r = await PUT(req("PUT", { action: "unlock", unlock_phrase: "memorandum" }));
    expect(r.status).toBe(200);
    expect(updateChain.update).toHaveBeenCalledWith(expect.objectContaining({ locked: false }));
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), "memorandum_settings.unlock", expect.anything(), "tenant-A", expect.anything());
  });

  it("PUT action lock → locked=true written", async () => {
    const updateChain = chain({ data: { id: "m1", locked: true } });
    mockFrom.mockImplementation((table: string, _opts?: unknown) =>
      table === "memorandum_settings" ? (mockFrom.mock.calls.length <= 1 ? chain({ data: { id: "m1", locked: false } }) : updateChain) : chain({ data: null }),
    );
    const r = await PUT(req("PUT", { action: "lock" }));
    expect(r.status).toBe(200);
    expect(updateChain.update).toHaveBeenCalledWith(expect.objectContaining({ locked: true }));
  });

  it("PUT fields while UNLOCKED → normal write path", async () => {
    const updateChain = chain({ data: { id: "m1", locked: false, header_height_mm: 40 } });
    mockFrom.mockImplementation(() =>
      mockFrom.mock.calls.length <= 1 ? chain({ data: { id: "m1", locked: false } }) : updateChain,
    );
    const r = await PUT(req("PUT", { header_height_mm: 40 }));
    expect(r.status).toBe(200);
    expect(updateChain.update).toHaveBeenCalled();
  });

  it("the locked flag itself is never writable through a field PUT", async () => {
    const updateChain = chain({ data: { id: "m1", locked: false } });
    mockFrom.mockImplementation(() =>
      mockFrom.mock.calls.length <= 1 ? chain({ data: { id: "m1", locked: false } }) : updateChain,
    );
    const r = await PUT(req("PUT", { locked: true, header_height_mm: 40 }));
    expect(r.status).toBe(200);
    const written = updateChain.update.mock.calls[0][0] as Record<string, unknown>;
    expect(written.locked).toBeUndefined();
    expect(written.header_height_mm).toBe(40);
  });

  it("GET auto-creates the first row in setup mode (locked=false)", async () => {
    const insertChain = chain({ data: { id: "m-new", locked: false } });
    mockFrom.mockImplementation(() =>
      mockFrom.mock.calls.length <= 1 ? chain({ data: null }) : insertChain,
    );
    const r = await GET(req("GET"));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.locked).toBe(false);
    expect(insertChain.insert).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: "tenant-A", locked: false }));
  });

  it("an action with settings mixed in → 400 (actions travel alone)", async () => {
    mockFrom.mockReturnValue(chain({ data: { id: "m1", locked: false } }));
    const r = await PUT(req("PUT", { action: "lock", page_size: "A4" }));
    expect(r.status).toBe(400);
  });
});
