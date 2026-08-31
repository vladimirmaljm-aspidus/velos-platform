import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, audit, resolveTenantId, sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

// DELETE /api/erp/bank-accounts/[id] — Delete bank account (requires admin)
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (erp.delete)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "erp.delete"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */


  const { id } = await params;
  try {
    // FIX-FUNC-5: resolve tenant via resolveTenantId so super-admins acting
    // under ?tenant_id=xxx can delete a tenant's bank account. The previous
    // `auth.tenantId ?? ""` call passed an empty string for super-admins
    // (whose own tenantId is null), so listErpBankAccounts("") returned
    // zero rows and the route always 404'd for super-admins.
    const tid = resolveTenantId(auth, req);
    if (!tid) return NextResponse.json({ error: "Tenant context required." }, { status: 400 });
    // Tenant Ownership check: listErpBankAccounts returns the tenant's bank accounts.
    // (The store currently returns an empty array as ERP is not implemented; this check
    // will become active once ERP is wired up.)
    const all = await auth.store.listErpBankAccounts(tid);
    const existing = all.find((b) => b.id === id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await auth.store.deleteErpBankAccount(id);
    await audit(auth.store, auth.user, req, "bank_account.delete", "erp_bank_account", id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
