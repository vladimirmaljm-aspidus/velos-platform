import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * GET /api/seals?tenant_id=xxx
 * List all seals (zigled) for the resolved tenant.
 * Super-admin can pass ?tenant_id=xxx to manage a specific tenant.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (seals.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "seals.read"); if (_d) return _d; } /* requirePermission wired */
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
    const items = await auth.store.listSeals(tenantId);
    return NextResponse.json({ items });
  } catch (e: any) {
    console.error("[seals GET]", e);
    return NextResponse.json(
      { error: e.message || "Internal server error" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/seals?tenant_id=xxx
 * Create or update a seal. The body should include all seal fields.
 * The tenant_id is resolved server-side (super-admin can override via query).
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (seals.create)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "seals.create"); if (_d) return _d; } /* requirePermission wired */
    // Feature gate (module_document_templates)
    { const { requireFeature } = await import("@/lib/api/feature-guard");
      const _f = await requireFeature(auth.tenantId, "module_document_templates", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    if (!auth.isSuperAdmin && auth.user.role !== "admin") {
      return NextResponse.json({ error: "Admin access required." }, { status: 403 });
    }
    const tenantId = resolveTenantId(auth, req);
    if (!tenantId) {
      return NextResponse.json({ error: "tenant_id query parameter is required for super-admin actions." }, { status: 400 });
    }
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    body.tenant_id = tenantId;
    if (!body.created_by) body.created_by = auth.user.id;
    const created = await auth.store.upsertSeal(body);
    await audit(
      auth.store,
      auth.user,
      req,
      body.id ? "seal.update" : "seal.create",
      "tenant_seal",
      created.id,
      { name: created.name }
    );
    return NextResponse.json(created);
  } catch (e: any) {
    console.error("[seals POST]", e);
    return NextResponse.json(
      { error: e.message || "Internal server error" },
      { status: 500 },
    );
  }
}
