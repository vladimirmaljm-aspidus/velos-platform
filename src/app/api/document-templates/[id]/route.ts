import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";
import { sanitizeTemplatePayload, DROPPED_FRAME_COLUMNS } from "@/lib/api/template-payload";

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
  // ── audit35: unified payload sanitization (same gate as POST + preview) ─
  // The PUT route used to validate style_json/layout_json inline and let
  // EVERYTHING else flow raw into the store — including the dead frame
  // columns (page_*, header_*, footer_height…) that the renderer has
  // ignored since audit33. The sanitizer now drops them here too: nothing
  // outside /api/memorandum-settings can ever write the document frame.
  // It also validates content_json (the Document Studio block body).
  //
  // `publish` + `changelog` are action keys, not columns — pulled out
  // before sanitization.
  const publish = body?.publish === true;
  const changelog = typeof body?.changelog === "string" ? body.changelog.slice(0, 500) : null;
  let sanitized: Record<string, unknown>;
  try {
    sanitized = sanitizeTemplatePayload(body).sanitized;
  } catch (sanitizeErr) {
    return NextResponse.json(
      { error: sanitizeErr instanceof Error ? sanitizeErr.message : "Invalid template payload." },
      { status: 400 },
    );
  }
  // Compat logging: legacy editor payloads still carry the frame columns —
  // a dropped-column warning keeps the API honest without breaking saves.
  {
    const droppedFrame = Object.keys(body || {}).filter((k) => DROPPED_FRAME_COLUMNS.has(k));
    if (droppedFrame.length) {
      console.warn(
        `[PUT /api/document-templates/${id}] dropped memorandum-owned frame columns (audit33/35): ${droppedFrame.join(", ")}`,
      );
    }
  }

  // Hard 400s on the columns that MUST stay valid (mirror POST semantics).
  const name = typeof sanitized.name === "string" ? sanitized.name.trim() : "";
  if (sanitized.name !== undefined && !name) {
    return NextResponse.json({ error: "Template name is required." }, { status: 400 });
  }
  if (name) sanitized.name = name;

  const updated = await auth.store.upsertDocumentTemplate({ ...sanitized, id, tenant_id: existing.tenant_id });
  await audit(auth.store, auth.user, req, "doc_template.update", "document_template", id, { name: updated.name });

  // ── audit35 Document Studio: optional publish snapshot ──────────────
  let publishedVersion: number | null = null;
  if (publish) {
    try {
      const { publishTemplateVersion } = await import("@/lib/api/template-versions");
      const res = await publishTemplateVersion(auth.store, existing.tenant_id, id, changelog, auth.user.id);
      if (res) {
        publishedVersion = res.version;
        await audit(auth.store, auth.user, req, "doc_template.publish", "document_template", id, { name: updated.name, version: res.version });
      }
    } catch (e) {
      console.warn(`[PUT /api/document-templates/${id}] publish snapshot failed:`, e);
    }
  }
  return NextResponse.json(publishedVersion ? { ...updated, published_version: publishedVersion } : updated);
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
