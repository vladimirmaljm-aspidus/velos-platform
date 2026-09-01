import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(_req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (document-templates.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "document-templates.read"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_document_templates)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_document_templates", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  const { id } = await params;
  const t = await auth.store.getDocumentTemplate(id);
  if (!t) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!auth.isSuperAdmin && t.tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  return NextResponse.json(t);
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (document-templates.update)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "document-templates.update"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_document_templates)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_document_templates", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  if (!auth.isSuperAdmin && auth.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  const { id } = await params;
  const existing = await auth.store.getDocumentTemplate(id);
  if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  // Strip JOIN results that come back from GET (letterhead, seal) — they're
  // not real DB columns and would cause a 500 from PostgREST.
  delete body.letterhead;
  delete body.seal;
  // Also strip virtual QR fields — they're stored inside footer_content._qrConfig
  delete body.qr_position;
  delete body.qr_size_mm;
  delete body.qr_opacity;
  // ── audit22: validate the new JSON blobs (shape-agnostic size guard) ──
  // Deeper normalization happens at read time (parseStyleConfig / renderer);
  // junk objects degrade to defaults rather than poisoning the column.
  for (const col of ["style_json", "layout_json"] as const) {
    const v = body[col];
    if (v === undefined) continue;
    const ok = v === null || (typeof v === "object" && !Array.isArray(v));
    const size = ok ? JSON.stringify(v ?? "").length : 0;
    if (!ok || size > 32768) {
      console.warn(`[PUT /api/document-templates/${id}] dropped invalid ${col}`);
      delete body[col];
    }
  }
  const updated = await auth.store.upsertDocumentTemplate({ ...body, id, tenant_id: existing.tenant_id });
  await audit(auth.store, auth.user, req, "doc_template.update", "document_template", id, { name: updated.name });
  return NextResponse.json(updated);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (document-templates.delete)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "document-templates.delete"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_document_templates)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_document_templates", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  if (!auth.isSuperAdmin && auth.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  const { id } = await params;
  const existing = await auth.store.getDocumentTemplate(id);
  if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  await auth.store.deleteDocumentTemplate(id);
  await audit(auth.store, auth.user, req, "doc_template.delete", "document_template", id);
  return NextResponse.json({ ok: true });
}
