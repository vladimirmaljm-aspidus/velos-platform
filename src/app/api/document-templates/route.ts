import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId } from "@/lib/api/helpers";
import { STARTER_TEMPLATES } from "@/lib/data/starter-templates";

export const runtime = "nodejs";

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
    return NextResponse.json({ items: seeded });
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
  body.tenant_id = tenantId;
  if (!body.created_by) body.created_by = auth.user.id;
  const created = await auth.store.upsertDocumentTemplate(body);
  await audit(auth.store, auth.user, req, body.id ? "doc_template.update" : "doc_template.create", "document_template", created.id, { name: created.name });
  return NextResponse.json(created);
}
