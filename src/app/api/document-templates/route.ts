import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId } from "@/lib/api/helpers";
import { STARTER_TEMPLATES } from "@/lib/data/starter-templates";
import {
  TEMPLATE_TYPES,
  sanitizeTemplatePayload,
} from "@/lib/api/template-payload";

export const runtime = "nodejs";

// ── audit20 / 20-b — POST column whitelist + validation ──────────────────
// The route used to spread the raw JSON body straight into
// upsertDocumentTemplate. Unknown keys either 500'd (the supabase
// smartUpsert strips ONE unknown column, then the NEXT unknown column
// throws) or mass-assigned DB-managed columns (created_at / updated_at).
// audit23: the whitelist/clamp logic moved to src/lib/api/template-payload.ts
// so the SAVED payload and the PREVIEWED payload can never drift.

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

  // ── audit20 / 20-b — field sanitization (audit23: shared module) ────────
  // Whitelist + clamps live in src/lib/api/template-payload.ts so the SAVED
  // payload and the PREVIEWED payload (preview/route.ts) can never drift.
  // id / tenant_id / created_by are route-controlled meta keys — never from
  // the body.
  const bodyId = typeof body.id === "string" && body.id.trim() ? body.id.trim() : undefined;
  let sanitized: Record<string, unknown>;
  try {
    sanitized = sanitizeTemplatePayload(body).sanitized;
  } catch (sanitizeErr) {
    return NextResponse.json(
      { error: sanitizeErr instanceof Error ? sanitizeErr.message : "Invalid template payload." },
      { status: 400 },
    );
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
      { error: "Invalid template type. Allowed: offer, invoice, proforma, contract, loi, generic." },
      { status: 400 },
    );
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
