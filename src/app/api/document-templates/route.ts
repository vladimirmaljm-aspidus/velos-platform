import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId } from "@/lib/api/helpers";
import { STARTER_TEMPLATES } from "@/lib/data/starter-templates";

export const runtime = "nodejs";

// ── audit20 / 20-b — POST column whitelist + validation ──────────────────
// The route used to spread the raw JSON body straight into
// upsertDocumentTemplate. Unknown keys either 500'd (the supabase
// smartUpsert strips ONE unknown column, then the NEXT unknown column
// throws) or mass-assigned DB-managed columns (created_at / updated_at).
// Only real document_templates columns are accepted now; anything else is
// dropped with a console.warn naming it.
const TEMPLATE_COLUMNS = new Set([
  "name", "type", "is_default",
  "page_size", "page_margin_top", "page_margin_bottom", "page_margin_left", "page_margin_right",
  "header_enabled", "header_height", "header_content", "header_show_logo", "header_show_company_name", "header_show_contact",
  "footer_enabled", "footer_height", "footer_content", "footer_show_page_number", "footer_show_bank_details", "footer_show_tax_id",
  "body_font_family", "body_font_size", "body_line_height",
  "primary_color", "accent_color",
  "table_header_bg", "table_header_color", "table_border_color", "table_stripe",
  "letterhead_id", "seal_id", "seal_enabled", "selected_bank_accounts",
  // audit22 Template Studio — extended styling + visual layout blobs.
  "style_json", "layout_json",
]);
const TEMPLATE_TYPES = new Set(["offer", "invoice", "proforma", "contract", "generic"]);
const TEMPLATE_PAGE_SIZES = new Set(["A4", "Letter"]);
// (column → [min, max]) — clamped instead of 400'd so a fat-fingered value
// still saves (the print layout stays usable); non-numeric junk is DROPPED
// so the store defaults apply instead of poisoning the column with null/NaN.
const TEMPLATE_CLAMPS: Record<string, [number, number]> = {
  page_margin_top: [5, 60], page_margin_bottom: [5, 60],
  page_margin_left: [5, 60], page_margin_right: [5, 60],
  header_height: [0, 120], footer_height: [0, 80],
  body_font_size: [6, 16], body_line_height: [1, 2.5],
};
// Columns that are Int in the schema (vs Float) — rounded after clamping so
// a JSON float like 11.5 can't 500 the insert on the int columns.
const TEMPLATE_INT_COLUMNS = new Set([
  "page_margin_top", "page_margin_bottom", "page_margin_left", "page_margin_right",
  "header_height", "footer_height", "body_font_size",
]);

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (document-templates.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "document-templates.read"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_document_templates)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_document_templates", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  if (!auth.isSuperAdmin && auth.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) {
    // Super-admin without an explicit ?tenant_id=xxx has no tenant scope —
    // return an empty list rather than 400 so the UI shows an empty state.
    // Regular users always have a tenant_id attached to their session.
    if (auth.isSuperAdmin) {
      return NextResponse.json({ items: [], total: 0 });
    }
    return NextResponse.json({ error: "No tenant context." }, { status: 400 });
  }
  const items = await auth.store.listDocumentTemplates(tenantId);
  // ─── Auto-create starter templates for first-time tenants ───────────────
  // If the tenant has zero templates, seed them with three professional
  // starting points (offer / invoice / proforma) so they can hit the ground
  // running. Idempotent — only fires when nothing exists yet.
  //
  // SECURITY NOTE (audit P2-17): this GET handler has a side effect (INSERT).
  // SameSite=Lax cookies block cross-site sub-resource requests, so CSRF is
  // mitigated. The starter templates are idempotent (only created when
  // items.length === 0), so even if triggered by a navigation, the worst
  // case is 3 template rows created — no data corruption.
  if (items.length === 0) {
    for (const starter of STARTER_TEMPLATES) {
      await auth.store.upsertDocumentTemplate({
        ...starter.template,
        tenant_id: tenantId,
      });
    }
    const seeded = await auth.store.listDocumentTemplates(tenantId);
    // audit20 / 20-b — the seeded branch omitted `total` while the normal
    // list consumers (pagination badges) expect it; keep the shape uniform.
    return NextResponse.json({ items: seeded, total: seeded.length });
  }
  return NextResponse.json({ items });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (document-templates.create)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "document-templates.create"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_document_templates)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_document_templates", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  if (!auth.isSuperAdmin && auth.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) return NextResponse.json({ error: "No tenant." }, { status: 400 });
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // ── audit20 / 20-b — field sanitization ────────────────────────────────
  // Keep ONLY known document_templates columns; unknown keys are dropped
  // (and logged) instead of reaching the store where they 500 (supabase
  // smartUpsert strips one unknown column, then throws on the next) or
  // mass-assign DB-managed columns.
  // id / tenant_id / created_by are route-controlled meta keys — pulled out
  // here and re-applied from trusted context below, never from the body.
  const bodyId = typeof body.id === "string" && body.id.trim() ? body.id.trim() : undefined;
  const sanitized: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (k === "id" || k === "tenant_id" || k === "created_by") continue;
    if (TEMPLATE_COLUMNS.has(k)) sanitized[k] = v;
    else dropped.push(k);
  }
  if (dropped.length) {
    console.warn(`[POST /api/document-templates] dropped unknown fields: ${dropped.join(", ")}`);
  }

  // ── Validation (hard 400s) ──────────────────────────────────────────────
  const name = typeof sanitized.name === "string" ? sanitized.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "Template name is required." }, { status: 400 });
  }
  if (name.length > 120) {
    return NextResponse.json({ error: "Template name must be at most 120 characters." }, { status: 400 });
  }
  sanitized.name = name;
  if (sanitized.type === undefined) {
    // Legacy default when the client omits it (matches the store default).
    sanitized.type = "generic";
  } else if (typeof sanitized.type !== "string" || !TEMPLATE_TYPES.has(sanitized.type)) {
    return NextResponse.json(
      { error: "Invalid template type. Allowed: offer, invoice, proforma, contract, generic." },
      { status: 400 },
    );
  }
  if (
    sanitized.page_size !== undefined &&
    (typeof sanitized.page_size !== "string" || !TEMPLATE_PAGE_SIZES.has(sanitized.page_size))
  ) {
    return NextResponse.json({ error: 'Invalid page size. Allowed: "A4", "Letter".' }, { status: 400 });
  }

  // ── Numeric clamping ───────────────────────────────────────────────────
  for (const [col, [min, max]] of Object.entries(TEMPLATE_CLAMPS)) {
    if (sanitized[col] === undefined || sanitized[col] === null) {
      // Absent/null numeric → drop so the store default applies (a null would
      // violate the NOT NULL columns and 500 the write).
      delete sanitized[col];
      continue;
    }
    const n = Number(sanitized[col]);
    if (!Number.isFinite(n)) {
      console.warn(`[POST /api/document-templates] dropped non-numeric ${col}`);
      delete sanitized[col];
      continue;
    }
    const clamped = Math.min(max, Math.max(min, n));
    sanitized[col] = TEMPLATE_INT_COLUMNS.has(col) ? Math.round(clamped) : clamped;
  }

  // ── selected_bank_accounts (migration 081 column) ───────────────────────
  // null = show all tenant bank accounts; otherwise an array of integer
  // indexes into tenant.bank_accounts. Junk values are dropped, not stored.
  if (sanitized.selected_bank_accounts !== undefined) {
    const v = sanitized.selected_bank_accounts;
    const ok = v === null || (Array.isArray(v) && v.every((x) => Number.isInteger(x) && x >= 0));
    if (!ok) {
      console.warn("[POST /api/document-templates] dropped invalid selected_bank_accounts");
      delete sanitized.selected_bank_accounts;
    }
  }

  // ── style_json / layout_json (migration 082, audit22) ──────────────────
  // Both must be null or a plain JSON object; the deeper shape is
  // normalized at READ time by parseStyleConfig()/the renderer, so here we
  // only guard size (≤ 32 KB) and type — junk objects degrade to defaults
  // instead of poisoning the column.
  for (const col of ["style_json", "layout_json"] as const) {
    if (sanitized[col] === undefined) continue;
    const v = sanitized[col];
    const ok = v === null || (typeof v === "object" && !Array.isArray(v));
    const size = ok ? JSON.stringify(v ?? "").length : 0;
    if (!ok || size > 32768) {
      console.warn(`[POST /api/document-templates] dropped invalid ${col}${ok ? " (too large)" : ""}`);
      delete sanitized[col];
    }
  }

  // Trusted keys AFTER the payload — client-supplied values can never
  // override these (mirrors the email-templates audit16 HIGH-1 fix).
  const payload: Record<string, unknown> = {
    ...sanitized,
    tenant_id: tenantId,
    created_by: auth.user.id,
  };
  if (bodyId) payload.id = bodyId;
  const created = await auth.store.upsertDocumentTemplate(payload as any);
  await audit(auth.store, auth.user, req, bodyId ? "doc_template.update" : "doc_template.create", "document_template", created.id, { name: created.name });
  return NextResponse.json(created);
}
