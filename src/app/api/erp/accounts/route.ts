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
    // FIX-MARKET-UI / FIX 4 — pagination. Cap limit at 500 (matches the
    // commission-payouts route's defensive cap).
    const limit = url.searchParams.get("limit")
      ? Math.min(Number(url.searchParams.get("limit")), 500)
      : undefined;
    const offset = url.searchParams.get("offset")
      ? Math.max(Number(url.searchParams.get("offset")), 0)
      : undefined;

    const result = await auth.store.listErpAccounts(tenantId, {
      search,
      filters: { account_type, is_active, standard },
      limit,
      offset,
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
    // FIX-FUNC-3: the `erp_accounts` table's column is `account_type`, but
    // some API callers (and the admin UI) send `type`. Map the legacy field
    // name to the actual column before delegating to the store — without
    // this, smartUpsert tries to write to a non-existent `type` column and
    // the DB raises "Could not find the 'type' column" → 500.
    if (body.type != null) {
      if (body.account_type == null) body.account_type = body.type;
      delete body.type;
    }
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
