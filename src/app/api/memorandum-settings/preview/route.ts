import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId, sanitizeError, getIp } from "@/lib/api/helpers";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { generatePdf } from "@/lib/pdf/generator";
import type { MemorandumSettings, Offer, Partner, Tenant } from "@/lib/supabase/types";

export const runtime = "nodejs";

/**
 * POST /api/memorandum-settings/preview — audit33 "Memorandum Studio".
 *
 * Renders a REAL document (the tenant's most recent of the requested type,
 * an explicit docId, or a fully synthetic sample when the tenant has no
 * documents yet) with the UNSAVED memorandum settings as the override, so
 * the admin sees exactly how the letterhead frame would print on every
 * document BEFORE saving. Same generator as the download routes.
 *
 * Guarantees:
 *  • auth + memorandum_settings.read permission + module gate + admin role
 *  • per-IP rate limit (10 renders / 60s — react-pdf renders are CPU-heavy)
 *  • enum + numeric validation of the settings payload (same surface as
 *    the save route) — no junk ever reaches the renderer
 *  • createVerification: false — a preview NEVER writes verification rows
 *  • synthetic preview documents are never persisted anywhere
 */

const PREVIEW_DOC_TYPES = new Set(["offer", "invoice", "proforma", "loi"]);

/** Enum-whitelisted TEXT columns (mirrors the save route + migration 090). */
const ENUM_COLUMNS: Record<string, string[]> = {
  page_size: ["A4", "Letter"],
  logo_side: ["left", "right"],
  qr_position: ["left", "center", "right", "none"],
  footer_address_source: ["tenant", "custom"],
};

/** Sanitize the client-supplied settings override: only known columns with
 *  valid values survive. Anything unknown/junk is dropped (never a 500). */
function sanitizeMemoOverride(
  raw: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const out: Record<string, unknown> = {};
  for (const [col, allowed] of Object.entries(ENUM_COLUMNS)) {
    const v = raw[col];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string" || !allowed.includes(v)) {
      return { ok: false, error: `Invalid ${col}. Allowed: ${allowed.join(", ")}.` };
    }
    out[col] = v;
  }
  const intCols = new Set([
    "header_height_mm", "header_left_font_size",
    "logo_max_width_mm", "logo_max_height_mm",
    "logo_position_x_mm", "logo_position_y_mm",
    "footer_height_mm", "qr_size_mm",
    "qr_position_x_mm", "qr_position_y_mm",
    "footer_center_font_size", "footer_right_font_size", "footer_left_font_size",
    "footer_left_width_pct", "footer_center_width_pct", "footer_right_width_pct",
    "body_font_size", "body_line_height",
    "margin_top_mm", "margin_bottom_mm", "margin_left_mm", "margin_right_mm",
  ]);
  for (const col of intCols) {
    const v = raw[col];
    if (v === undefined || v === null) continue;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) {
      return { ok: false, error: `Invalid ${col}. Must be a number.` };
    }
    out[col] = Math.round(n);
  }
  const realCols: Record<string, [number, number]> = {
    qr_opacity: [0, 1],
    header_border_width: [0, 6],
  };
  for (const [col, [min, max]] of Object.entries(realCols)) {
    const v = raw[col];
    if (v === undefined || v === null) continue;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n) || n < min || n > max) {
      return { ok: false, error: `Invalid ${col}. Must be between ${min} and ${max}.` };
    }
    out[col] = n;
  }
  const strCols = new Set([
    "header_bg_color", "header_left_font_family", "header_left_font_color",
    "header_border_color", "footer_bg_color", "footer_border_color",
    "footer_left_font_family", "footer_left_font_color",
    "footer_center_font_family", "footer_center_font_color",
    "footer_right_font_family", "footer_right_font_color",
    "body_font_family", "body_text_color", "primary_color",
    "footer_address_custom", "footer_center_alignment",
  ]);
  for (const col of strCols) {
    const v = raw[col];
    if (typeof v === "string") {
      out[col] = v.length > 2000 ? v.slice(0, 2000) : v;
    }
  }
  const boolCols = new Set([
    "header_enabled", "header_left_font_bold", "logo_enabled",
    "footer_enabled", "qr_enabled", "footer_left_enabled",
    "footer_show_contact", "footer_border_enabled", "page_number_enabled",
    "header_border_enabled", "header_show_subtitle",
  ]);
  for (const col of boolCols) {
    const v = raw[col];
    if (typeof v === "boolean") out[col] = v;
  }
  return { ok: true, value: out };
}

/** Build a synthetic sample document so the preview ALWAYS works — even a
 *  brand-new tenant with zero documents sees the frame on realistic data. */
function syntheticSampleDoc(tenantId: string, docType: string): Offer {
  const today = new Date().toISOString().slice(0, 10);
  const plus30 = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
  return {
    id: "memo-preview-sample",
    tenant_id: tenantId,
    number: "SAMPLE-0001",
    partner_id: "sample-partner",
    status: "draft",
    currency: "USD",
    issue_date: today,
    valid_until: plus30,
    delivery_date: plus30,
    subject: "Sample document — memorandum preview",
    total: 6170.0,
    subtotal: 6170.0,
    tax_amount: 0,
    discount_amount: 0,
    shipping_cost: 0,
    trade_terms: null,
    offer_text: null,
    notes: null,
    items: [
      {
        id: "sample-item-1",
        product_name: "Premium Arabica Coffee",
        description: "Washed process, SHG grade, screen 18",
        hs_code: "0901.21",
        origin_country: "BR",
        quantity: 500,
        unit: "kg",
        unit_price: 12.34,
        total: 6170,
        specifications: null,
        detailed_spec: null,
      } as never,
    ],
    created_at: new Date().toISOString(),
    created_by: null,
  } as unknown as Offer;
}

function syntheticSamplePartner(): Partner {
  return {
    id: "sample-partner",
    tenant_id: "",
    name: "Sample Partner Ltd.",
    type: "buyer",
    status: "active",
    address_line: "Sample Street 12",
    city: "Rotterdam",
    country: "NL",
    contact_email: null,
    contact_phone: null,
    phone: null,
    tax_id: null,
    vat_number: null,
    created_at: new Date().toISOString(),
    created_by: null,
  } as unknown as Partner;
}

export async function POST(req: NextRequest) {
  // Rate limit — preview rendering is CPU-expensive (react-pdf).
  const rl = await checkRateLimit(`memo-preview:ip:${getIp(req)}`, 10, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many preview requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rl.retryAfter ?? 60_000) / 1000)) } },
    );
  }

  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "memorandum_settings.read"); if (_d) return _d; }
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_document_templates", auth.isSuperAdmin); if (_f) return _f; }

  if (!auth.isSuperAdmin && auth.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) return NextResponse.json({ error: "No tenant." }, { status: 400 });

  let body: { docType?: unknown; docId?: unknown; settings?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const docType = typeof body.docType === "string" ? body.docType : "offer";
  if (!PREVIEW_DOC_TYPES.has(docType)) {
    return NextResponse.json(
      { error: "Invalid docType. Allowed: offer, invoice, proforma, loi." },
      { status: 400 },
    );
  }

  // Settings override — sanitized with the same surface as the save route.
  if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)) {
    return NextResponse.json({ error: "Missing settings payload." }, { status: 400 });
  }
  const sane = sanitizeMemoOverride(body.settings as Record<string, unknown>);
  if (!sane.ok) return NextResponse.json({ error: sane.error }, { status: 400 });
  const memorandumOverride = sane.value as unknown as MemorandumSettings;

  // Sample document — explicit docId (ownership-checked), else the tenant's
  // most recent of the type, else a fully synthetic sample.
  let docId = "memo-preview-sample";
  let docNumber = "SAMPLE-0001";
  let prefetched:
    | { doc?: Offer; partner?: Partner | null; tenant?: Tenant | null }
    | undefined;

  if (typeof body.docId === "string" && body.docId.trim()) {
    const wanted = body.docId.trim();
    const fetched = await fetchDoc(auth.store as never, docType, wanted);
    if (!fetched || fetched.tenant_id !== tenantId) {
      return NextResponse.json({ error: "Document not found." }, { status: 404 });
    }
    docId = fetched.id;
    docNumber = fetched.number || "";
  } else {
    const latest = await listLatest(auth.store as never, docType, tenantId);
    if (latest) {
      docId = latest.id;
      docNumber = latest.number || "";
    } else {
      // Synthetic sample — generatePdf receives it via prefetched so it is
      // never written anywhere.
      prefetched = {
        doc: syntheticSampleDoc(tenantId, docType),
        partner: syntheticSamplePartner(),
      };
      docId = "memo-preview-sample";
    }
  }

  try {
    const result = await generatePdf({
      docType: docType as "offer" | "invoice" | "proforma" | "loi",
      docId,
      tenantId,
      createVerification: false, // previews NEVER issue verifications
      memorandumOverride,
      prefetched,
    });

    audit(auth.store, auth.user, req, "memorandum_settings.preview", "memorandum_settings", tenantId, {
      docType,
      docId,
      docNumber,
      size: result.buffer.length,
    }).catch(() => {});

    const headers = new Headers();
    headers.set("Content-Type", "application/pdf");
    headers.set("Content-Disposition", `inline; filename="memorandum-preview-${docType}.pdf"`);
    headers.set("Content-Length", String(result.buffer.length));
    headers.set("X-Preview-Doc-Number", docNumber || docId);
    return new NextResponse(new Uint8Array(result.buffer), { status: 200, headers });
  } catch (e: unknown) {
    console.error("[memorandum-preview]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function fetchDoc(
  store: never,
  docType: string,
  id: string,
): Promise<{ id: string; number: string | null; tenant_id: string } | null> {
  const st = store as any;
  switch (docType) {
    case "offer": return st.getOffer(id);
    case "invoice": return st.getInvoice(id);
    case "proforma": return st.getProforma(id);
    case "loi": return st.getLoi(id);
  }
  return null;
}

/** Most recent document of the type for the tenant (created_at desc). */
async function listLatest(
  store: never,
  docType: string,
  tenantId: string,
): Promise<{ id: string; number: string | null } | null> {
  const st = store as any;
  const listers: Record<string, (tid: string, params?: { limit?: number }) => Promise<{ items: { id: string; number: string | null }[] }>> = {
    offer: (tid, p) => st.listOffers(tid, p),
    invoice: (tid, p) => st.listInvoices(tid, p),
    proforma: (tid, p) => st.listProformas(tid, p),
    loi: (tid, p) => st.listLois(tid, p),
  };
  const lister = listers[docType];
  if (!lister) return null;
  const res = await lister(tenantId, { limit: 1 });
  return res?.items?.[0] ?? null;
}
