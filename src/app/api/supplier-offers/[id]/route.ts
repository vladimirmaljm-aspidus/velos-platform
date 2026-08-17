import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(_req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (supplier-offers.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "supplier-offers.read"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_trade)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_trade", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  const { id } = await params;
  const item = await auth.store.getSupplierOffer(id);
  if (!item) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!auth.isSuperAdmin && item.tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  return NextResponse.json(item);
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (supplier-offers.update)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "supplier-offers.update"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_trade)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_trade", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  const { id } = await params;
  const existing = await auth.store.getSupplierOffer(id);
  if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // ── Tenant-ownership validation (audit F-6/P1-5 IDOR) ────────────────
  // Same fix as POST /api/supplier-offers: an authenticated user could
  // otherwise change the `supplier_id` / `product_id` on an existing
  // offer to point at another tenant's records. Super-admins bypass.
  if (!auth.isSuperAdmin) {
    if (body.supplier_id) {
      const supplier = await auth.store.getPartner(body.supplier_id);
      if (!supplier || supplier.tenant_id !== existing.tenant_id) {
        return NextResponse.json({ error: "Invalid supplier — does not belong to your tenant." }, { status: 400 });
      }
    }
    if (body.product_id) {
      const product = await auth.store.getProduct(body.product_id);
      if (!product || product.tenant_id !== existing.tenant_id) {
        return NextResponse.json({ error: "Invalid product — does not belong to your tenant." }, { status: 400 });
      }
    }
  }

  let updated;
  try {
    updated = await auth.store.upsertSupplierOffer({ ...body, id, tenant_id: existing.tenant_id });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to save supplier offer" },
      { status: 500 },
    );
  }
  await audit(auth.store, auth.user, req, "supplier_offer.update", "supplier_offer", id, {});
  return NextResponse.json(updated);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (supplier-offers.delete)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "supplier-offers.delete"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_trade)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_trade", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  const { id } = await params;
  const existing = await auth.store.getSupplierOffer(id);
  if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  await auth.store.deleteSupplierOffer(id);
  await audit(auth.store, auth.user, req, "supplier_offer.delete", "supplier_offer", id);
  return NextResponse.json({ ok: true });
}
