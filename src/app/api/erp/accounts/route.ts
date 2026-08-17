import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAdmin, resolveTenantId, audit } from "@/lib/api/helpers";

export const runtime = "nodejs";

// GET /api/erp/accounts — List chart of accounts
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (erp.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "erp.read"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */


  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) return NextResponse.json({ items: [], total: 0 });

  try {
    const url = new URL(req.url);
    const search = url.searchParams.get("search") || undefined;
    const account_type = url.searchParams.get("account_type") || undefined;
    const is_active = url.searchParams.get("is_active") || undefined;
    const standard = url.searchParams.get("standard") || undefined;

    const result = await auth.store.listErpAccounts(tenantId, {
      search,
      filters: { account_type, is_active, standard },
    });
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST /api/erp/accounts — Create/update account (requires admin)
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (erp.create)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "erp.create"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */


  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) {
    return NextResponse.json({ error: "Tenant ID required." }, { status: 400 });
  }

  try {
    const body = await req.json();
    const created = await auth.store.upsertErpAccount({ ...body, tenant_id: tenantId });
    await audit(auth.store, auth.user, req, body.id ? "erp_account.update" : "erp_account.create", "erp_account", created.id, {
      code: created.code,
      name: created.name,
    });
    return NextResponse.json(created);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
