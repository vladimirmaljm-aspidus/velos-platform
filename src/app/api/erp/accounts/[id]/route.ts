import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAdmin, resolveTenantId, audit, sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

// GET /api/erp/accounts/[id] — Get single account
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (erp.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "erp.read"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */


  const { id } = await params;
  try {
    const account = await auth.store.getErpAccount(id);
    if (!account) return NextResponse.json({ error: "Not found." }, { status: 404 });
    // Tenant ownership check
    if (!auth.isSuperAdmin && account.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return NextResponse.json(account);
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

// PUT /api/erp/accounts/[id] — Update account
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (erp.update)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "erp.update"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */


  const { id } = await params;
  try {
    // Tenant ownership check
    const existing = await auth.store.getErpAccount(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const body = await req.json();
    const updated = await auth.store.upsertErpAccount({ ...body, id, tenant_id: existing.tenant_id });
    await audit(auth.store, auth.user, req, "erp_account.update", "erp_account", id, {
      code: updated.code,
      name: updated.name,
    });
    return NextResponse.json(updated);
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

// DELETE /api/erp/accounts/[id] — Delete account (only if not system account)
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
    const account = await auth.store.getErpAccount(id);
    if (!account) return NextResponse.json({ error: "Not found." }, { status: 404 });
    // Tenant ownership check
    if (!auth.isSuperAdmin && account.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (account.is_system) {
      return NextResponse.json({ error: "Cannot delete system account." }, { status: 403 });
    }
    await auth.store.deleteErpAccount(id);
    await audit(auth.store, auth.user, req, "erp_account.delete", "erp_account", id, {
      code: account.code,
      name: account.name,
    });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
