import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAdmin, resolveTenantId, audit } from "@/lib/api/helpers";

export const runtime = "nodejs";

// GET /api/erp/bank-accounts — List bank accounts
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
    // FIX-MARKET-UI / FIX 4 — pagination. The store's listErpBankAccounts
    // returns the full array (no `count`); for pagination we slice the
    // result on the route side. Bank accounts are typically few per
    // tenant (<10) so the in-memory slice is acceptable.
    const url = new URL(req.url);
    const limit = url.searchParams.get("limit")
      ? Math.min(Number(url.searchParams.get("limit")), 500)
      : undefined;
    const offset = url.searchParams.get("offset")
      ? Math.max(Number(url.searchParams.get("offset")), 0)
      : undefined;

    const all = await auth.store.listErpBankAccounts(tenantId);
    const total = all.length;
    const items = limit !== undefined
      ? all.slice(offset ?? 0, (offset ?? 0) + limit)
      : all;
    return NextResponse.json({ items, total });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST /api/erp/bank-accounts — Create/update bank account (requires admin)
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
    const created = await auth.store.upsertErpBankAccount({ ...body, tenant_id: tenantId });
    await audit(auth.store, auth.user, req, body.id ? "bank_account.update" : "bank_account.create", "erp_bank_account", created.id, {
      bank_name: created.bank_name,
      account_number: created.account_number,
    });
    return NextResponse.json(created);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
