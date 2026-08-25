import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAdmin, resolveTenantId, audit } from "@/lib/api/helpers";

export const runtime = "nodejs";

// GET /api/erp/bank-transactions — List bank transactions (optional bank_account_id filter)
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
    const bank_account_id = url.searchParams.get("bank_account_id") || undefined;
    const search = url.searchParams.get("search") || undefined;
    // FIX-MARKET-UI / FIX 4 — pagination.
    const limit = url.searchParams.get("limit")
      ? Math.min(Number(url.searchParams.get("limit")), 500)
      : undefined;
    const offset = url.searchParams.get("offset")
      ? Math.max(Number(url.searchParams.get("offset")), 0)
      : undefined;

    const result = await auth.store.listErpBankTransactions(tenantId, bank_account_id, {
      search,
      limit,
      offset,
    });
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST /api/erp/bank-transactions — Create bank transaction (requires admin)
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
    // FIX-MED-1 / Fix 1 — verify the bank_account_id belongs to the caller's
    // tenant BEFORE creating the transaction. Without this check a user with
    // `erp.create` permission could POST a bank transaction against another
    // tenant's `bank_account_id` (the upsertErpBankTransaction store method
    // stamps `tenant_id` on the *transaction* row but never verifies the
    // referenced `bank_account_id` row — so the FK is satisfied across
    // tenants and the cross-tenant leak goes unnoticed).
    //
    // `getErpBankAccount` is not part of the store interface, so we use a
    // direct Supabase lookup on `erp_bank_accounts(tenant_id)` and require
    // an exact match. The service_role client bypasses RLS — which is the
    // correct behavior here because we're enforcing a tenant boundary at
    // the application layer (the route already gated on `requireAdmin` +
    // `erp.create` + `module_finance` feature gate).
    if (!body.bank_account_id) {
      return NextResponse.json({ error: "bank_account_id is required." }, { status: 400 });
    }
    const { getSupabase } = await import("@/lib/supabase/client");
    const sb = getSupabase();
    const { data: bankAccount, error: baErr } = await sb
      .from("erp_bank_accounts")
      .select("tenant_id")
      .eq("id", body.bank_account_id)
      .maybeSingle();
    if (baErr) {
      console.error("[erp/bank-transactions POST] bank account lookup failed:", baErr);
      return NextResponse.json({ error: "Failed to verify bank account." }, { status: 500 });
    }
    if (!bankAccount || bankAccount.tenant_id !== tenantId) {
      return NextResponse.json(
        { error: "Bank account not found or doesn't belong to your tenant." },
        { status: 403 },
      );
    }
    const created = await auth.store.upsertErpBankTransaction({ ...body, tenant_id: tenantId });
    await audit(auth.store, auth.user, req, "bank_transaction.create", "erp_bank_transaction", created.id, {
      bank_account_id: created.bank_account_id,
      amount: created.amount,
      transaction_type: created.transaction_type,
    });
    return NextResponse.json(created);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
