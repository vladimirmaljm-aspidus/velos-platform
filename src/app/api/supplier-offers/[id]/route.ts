import { NextRequest, NextResponse } from "next/server";
// FIX-ALL-2 / Fix 3 — accept API-key auth on [id] routes so an API-key
// caller fetching /api/supplier-offers/<non-existent-id> gets 404 (not 401).
import { requireAuthOrApiKey, hasPermission, audit, sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthOrApiKey(_req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (supplier-offers.read) — session callers use requirePermission,
    // API-key callers use hasPermission (colon format).
    { const { requirePermission } = await import("@/lib/permissions/can");
      if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "supplier-offers.read"); if (_d) return _d; } }
    if ("apiKeyId" in auth && !hasPermission(auth.permissions, "supplier-offers:read")) {
      return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
    }
  // Feature gate (module_trade)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_trade", _isSA); if (_f) return _f; } /* requireFeature wired */

  const { id } = await params;
  const item = await auth.store.getSupplierOffer(id);
  // FIX-ALL-2 / Fix 3 — not-found returns 404, not 401.
  if (!item) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
  if (!isSuperAdmin && item.tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  return NextResponse.json(item);
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthOrApiKey(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (supplier-offers.update) — session callers use requirePermission,
  // API-key callers use hasPermission (colon format).
  { const { requirePermission } = await import("@/lib/permissions/can");
    if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "supplier-offers.update"); if (_d) return _d; } }
  if ("apiKeyId" in auth && !hasPermission(auth.permissions, "supplier-offers:write")) {
    return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
  }
  // Feature gate (module_trade)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_trade", _isSA); if (_f) return _f; } /* requireFeature wired */

  const { id } = await params;
  const existing = await auth.store.getSupplierOffer(id);
  if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
  if (!isSuperAdmin && existing.tenant_id !== auth.tenantId) {
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
  if (!isSuperAdmin) {
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
      { error: sanitizeError(e) },
      { status: 500 },
    );
  }
  const auditUser = "user" in auth ? auth.user : { id: `api:${auth.apiKeyId}`, username: auth.apiKeyName, tenant_id: auth.tenantId };
  await audit(auth.store, auditUser, req, "supplier_offer.update", "supplier_offer", id, {});
  return NextResponse.json(updated);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthOrApiKey(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (supplier-offers.delete) — session callers use requirePermission,
  // API-key callers use hasPermission (colon format).
  { const { requirePermission } = await import("@/lib/permissions/can");
    if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "supplier-offers.delete"); if (_d) return _d; } }
  if ("apiKeyId" in auth && !hasPermission(auth.permissions, "supplier-offers:write")) {
    return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
  }
  // Feature gate (module_trade)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_trade", _isSA); if (_f) return _f; } /* requireFeature wired */

  const { id } = await params;
  const existing = await auth.store.getSupplierOffer(id);
  if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
  if (!isSuperAdmin && existing.tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  await auth.store.deleteSupplierOffer(id);
  const auditUser = "user" in auth ? auth.user : { id: `api:${auth.apiKeyId}`, username: auth.apiKeyName, tenant_id: auth.tenantId };
  await audit(auth.store, auditUser, req, "supplier_offer.delete", "supplier_offer", id);
  return NextResponse.json({ ok: true });
}
