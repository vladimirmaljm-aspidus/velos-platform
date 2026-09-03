import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId } from "@/lib/api/helpers";
// 31-f — shared request-body validation helpers (audit 30-a findings
// 30a-07/30a-08: POST {} → product_catalog NOT NULL violation → 500, and
// {active: "yes-please"} → PostgREST boolean cast error → 500; now clean
// 400s before the DB write).
import { requireFields, assertBoolean } from "@/lib/api/validate";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (product-catalog.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "product-catalog.read"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_trade)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_trade", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) return NextResponse.json({ items: [], total: 0 });
  const url = new URL(req.url);
  const search = url.searchParams.get("search") || undefined;
  const category = url.searchParams.get("category") || undefined;
  const result = await auth.store.listProductCatalog(tenantId, { search, filters: { category } });
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (product-catalog.create)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "product-catalog.create"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_trade)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_trade", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) return NextResponse.json({ error: "No tenant context." }, { status: 400 });
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  // 31-f — required-field + type validation BEFORE the upsert (audit
  // 30a-08: POST {} → 500 "Missing required field."; 30a-07:
  // {active: "yes-please"} → 500). name / category / base_unit are NOT
  // NULL with no DB defaults (active has a default but must still be a
  // real boolean — a junk string is a PostgREST cast error). Skipped on
  // the update path (body.id).
  if (!body.id) {
    const bad = requireFields(body, ["name", "category", "base_unit"]);
    if (bad) return bad;
  }
  {
    const bad = assertBoolean(body, ["active"]);
    if (bad) return bad;
  }
  body.tenant_id = tenantId;
  const created = await auth.store.upsertProductCatalogEntry(body);
  await audit(auth.store, auth.user, req, body.id ? "product_catalog.update" : "product_catalog.create", "product_catalog", created.id, { name: created.name });
  return NextResponse.json(created);
}
