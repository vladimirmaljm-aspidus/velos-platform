import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, audit, resolveTenantId, sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

// POST /api/erp/bank-transactions/[id]/reconcile — Reconcile a bank transaction
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (erp.create)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "erp.reconcile"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */


  const { id } = await params;
  try {
    // Tenant ownership check — fetch the single row by id (tenant-scoped)
    // instead of listing up to 100k transactions and searching client-side
    // (API P1 #14). Also guards against missing tenant_id.
    // FIX-FUNC-5: resolve tenant via resolveTenantId so super-admins acting
    // under ?tenant_id=xxx can reconcile a tenant's bank transaction. The
    // previous `if (!auth.tenantId)` returned 400 for super-admins (whose
    // own tenantId is null).
    const tid = resolveTenantId(auth, req);
    if (!tid) {
      return NextResponse.json({ error: "tenant_id is required." }, { status: 400 });
    }
    const { getSupabase } = await import("@/lib/supabase/client");
    const sb = getSupabase();
    const { data: existing, error: fetchErr } = await sb
      .from("erp_bank_transactions")
      .select("*")
      .eq("id", id)
      .eq("tenant_id", tid)
      .maybeSingle();
    if (fetchErr) {
      return NextResponse.json({ error: sanitizeError(fetchErr) }, { status: 500 });
    }
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    // Super-admin override: if a super-admin is reconciling a txn outside
    // their own tenant, the tenant-scoped query above will have returned 404.
    // We don't need an additional check here — the tenant_id filter already
    // enforces isolation.

    const body = await req.json();
    if (!body.journal_entry_id) {
      return NextResponse.json({ error: "journal_entry_id is required." }, { status: 400 });
    }

    const reconciled = await auth.store.reconcileBankTransaction(id, body.journal_entry_id);
    await audit(auth.store, auth.user, req, "bank_transaction.reconcile", "erp_bank_transaction", id, {
      journal_entry_id: body.journal_entry_id,
    });
    return NextResponse.json(reconciled);
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
