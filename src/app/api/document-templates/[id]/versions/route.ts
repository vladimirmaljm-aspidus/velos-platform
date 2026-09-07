import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId } from "@/lib/api/helpers";
import { publishTemplateVersion, snapshotTemplateColumns } from "@/lib/api/template-versions";

export const runtime = "nodejs";

/**
 * GET /api/document-templates/[id]/versions
 *
 * Version history for a template (light rows — snapshots excluded, they can
 * be 32KB+ each). Newest first, capped at 200.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  {
    const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "document-templates.read"); if (_d) return _d;
  }
  {
    const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_document_templates", auth.isSuperAdmin); if (_f) return _f;
  }
  if (!auth.isSuperAdmin && auth.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }

  const { id } = await params;
  const t = await auth.store.getDocumentTemplate(id);
  if (!t) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!auth.isSuperAdmin && t.tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const tenantId = resolveTenantId(auth, req) || t.tenant_id;
  const versions = await auth.store.listTemplateVersions(tenantId, id);
  return NextResponse.json({ items: versions, total: versions.length });
}

/**
 * POST /api/document-templates/[id]/versions
 *
 * Two actions:
 *   { action: "publish", changelog?: string }  — snapshot the CURRENT
 *       stored state as a new version (the editor's "Publish version").
 *   { action: "restore", version: number, changelog?: string } — write the
 *       snapshot of `version` back to the template. The CURRENT state is
 *       auto-snapshotted first, so nothing is ever lost.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  {
    const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "document-templates.update"); if (_d) return _d;
  }
  {
    const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_document_templates", auth.isSuperAdmin); if (_f) return _f;
  }
  if (!auth.isSuperAdmin && auth.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }

  const { id } = await params;
  const t = await auth.store.getDocumentTemplate(id);
  if (!t) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!auth.isSuperAdmin && t.tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const tenantId = t.tenant_id;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const action = body.action === "restore" ? "restore" : body.action === "publish" ? "publish" : null;
  if (!action) {
    return NextResponse.json({ error: 'Invalid action. Allowed: "publish", "restore".' }, { status: 400 });
  }
  const changelog = typeof body.changelog === "string" ? body.changelog.slice(0, 500) : null;

  if (action === "publish") {
    try {
      const published = await publishTemplateVersion(auth.store, tenantId, id, changelog, auth.user.id);
      if (!published) return NextResponse.json({ error: "Not found." }, { status: 404 });
      await audit(auth.store, auth.user, req, "doc_template.publish", "document_template", id, {
        name: t.name,
        version: published.version,
      });
      return NextResponse.json({ ok: true, ...published });
    } catch (e) {
      console.error("[template-versions] publish failed:", e);
      return NextResponse.json({ error: "Publish failed — the template itself is saved." }, { status: 500 });
    }
  }

  // ── restore ──
  const version = Number(body.version);
  if (!Number.isInteger(version) || version < 1) {
    return NextResponse.json({ error: "Invalid version." }, { status: 400 });
  }
  const snap = await auth.store.getTemplateVersionSnapshot(tenantId, id, version);
  if (!snap) {
    return NextResponse.json({ error: `Version ${version} not found.` }, { status: 404 });
  }

  // 1) Auto-backup the CURRENT state so the restore is itself reversible.
  const current = await auth.store.getDocumentTemplate(id);
  if (current) {
    const list = await auth.store.listTemplateVersions(tenantId, id);
    const nextVersion = list.length ? Math.max(...list.map((v) => v.version)) + 1 : 1;
    await auth.store.createTemplateVersion({
      tenant_id: tenantId,
      template_id: id,
      version: nextVersion,
      name: String(current.name || "template").slice(0, 200),
      snapshot: snapshotTemplateColumns(current),
      changelog: `Auto-backup before restoring v${version}`,
      created_by: auth.user.id,
    });
  }

  // 2) Write the snapshot back (only whitelisted template columns — the
  //    snapshot can never re-introduce frame columns; they were dropped at
  //    the source when the version was published).
  const restored = await auth.store.upsertDocumentTemplate({ ...(snap.snapshot as any), id, tenant_id: tenantId });
  await audit(auth.store, auth.user, req, "doc_template.restore", "document_template", id, {
    name: restored.name,
    restored_from: version,
  });
  return NextResponse.json({ ok: true, template: restored });
}
