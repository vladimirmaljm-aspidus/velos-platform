import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId } from "@/lib/api/helpers";
// 31-f — shared required-field validation (audit 30-b BUG-2: an empty
// POST /api/letterheads returned a 500 with an EMPTY error body — the
// tenant_letterheads.name NOT NULL violation was swallowed; now a clean
// 400 naming the field).
import { requireFields } from "@/lib/api/validate";

export const runtime = "nodejs";

/**
 * GET /api/letterheads?tenant_id=xxx
 * List all letterheads (memorandum firme) for the resolved tenant.
 * Super-admin can pass ?tenant_id=xxx to manage a specific tenant.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (letterheads.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "letterheads.read"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_document_templates)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_document_templates", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  if (!auth.isSuperAdmin && auth.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) {
    // Super-admin without an explicit ?tenant_id=xxx has no tenant scope —
    // return an empty list rather than 400 so the UI shows an empty state
    // instead of an error. Regular users without a tenant (shouldn't happen
    // in practice — every regular user has a tenant_id) get a 400.
    if (auth.isSuperAdmin) {
      return NextResponse.json({ items: [], total: 0 });
    }
    return NextResponse.json({ error: "No tenant context." }, { status: 400 });
  }
  const items = await auth.store.listLetterheads(tenantId);
  return NextResponse.json({ items });
}

/**
 * POST /api/letterheads?tenant_id=xxx
 * Create or update a letterhead. The body should include all letterhead fields.
 * The tenant_id is resolved server-side (super-admin can override via query).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (letterheads.create)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "letterheads.create"); if (_d) return _d; } /* requirePermission wired */
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
  // 31-f — required-field validation BEFORE the upsert (audit 30-b BUG-2:
  // POST {} → tenant_letterheads.name NOT NULL → 500 with an EMPTY error
  // body). tenant_id is resolved server-side above and created_by is
  // defaulted below, so `name` is the only client-supplied NOT NULL column
  // without a default. Skipped on the update path (body.id).
  if (!body.id) {
    const bad = requireFields(body, ["name"]);
    if (bad) return bad;
  }
  body.tenant_id = tenantId;
  if (!body.created_by) body.created_by = auth.user.id;
  const created = await auth.store.upsertLetterhead(body);
  await audit(
    auth.store,
    auth.user,
    req,
    body.id ? "letterhead.update" : "letterhead.create",
    "tenant_letterhead",
    created.id,
    { name: created.name }
  );
  return NextResponse.json(created);
}
