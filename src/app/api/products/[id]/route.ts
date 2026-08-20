import { NextRequest, NextResponse } from "next/server";
// FIX-ALL-2 / Fix 3 — accept API-key auth on [id] routes so an API-key
// caller fetching /api/products/<non-existent-id> gets 404 (not 401).
import { requireAuthOrApiKey, hasPermission, audit, sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthOrApiKey(_req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (products.read) — session callers use requirePermission,
    // API-key callers use hasPermission (colon format).
    { const { requirePermission } = await import("@/lib/permissions/can");
      if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "products.read"); if (_d) return _d; } }
    if ("apiKeyId" in auth && !hasPermission(auth.permissions, "products:read")) {
      return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
    }

    const { id } = await params;
    const item = await auth.store.getProduct(id);
    // FIX-ALL-2 / Fix 3 — not-found returns 404, not 401. Previously an
    // API-key caller hit `requireAuth` first (which rejects Bearer tokens)
    // and got 401 for every [id] lookup — masking the genuine 404 case.
    if (!item) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
    if (!isSuperAdmin && item.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return NextResponse.json(item);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (products.update) — session callers use requirePermission,
  // API-key callers use hasPermission (colon format).
  { const { requirePermission } = await import("@/lib/permissions/can");
    if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "products.update"); if (_d) return _d; } }
  if ("apiKeyId" in auth && !hasPermission(auth.permissions, "products:write")) {
    return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
  }

    const { id } = await params;
    const existing = await auth.store.getProduct(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
    if (!isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const body = await req.json();
    const updated = await auth.store.upsertProduct({ ...body, id, tenant_id: existing.tenant_id });
    const auditUser = "user" in auth ? auth.user : { id: `api:${auth.apiKeyId}`, username: auth.apiKeyName, tenant_id: auth.tenantId };
    await audit(auth.store, auditUser, req, "product.update", "product", id, { name: updated.name });
    return NextResponse.json(updated);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (products.delete) — session callers use requirePermission,
  // API-key callers use hasPermission (colon format).
  { const { requirePermission } = await import("@/lib/permissions/can");
    if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "products.delete"); if (_d) return _d; } }
  if ("apiKeyId" in auth && !hasPermission(auth.permissions, "products:write")) {
    return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
  }

    const { id } = await params;
    const existing = await auth.store.getProduct(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
    if (!isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    // FIX-P1: dependency check (D-1) — refuse delete when the product is
    // referenced in offers or inventory_movements. Deactivate the product
    // instead so historical records stay intact.
    try {
      const { getSupabase } = await import("@/lib/supabase/client");
      const sb = getSupabase();
      const { data: linkedOffers } = await sb.from("offers").select("id").eq("product_id", id).limit(1).maybeSingle();
      const { data: linkedInv } = await sb.from("inventory_movements").select("id").eq("product_id", id).limit(1).maybeSingle();
      if (linkedOffers || linkedInv) {
        return NextResponse.json(
          { error: "Cannot delete product — it's referenced in offers or inventory. Deactivate it instead." },
          { status: 409 },
        );
      }
    } catch (depErr) {
      console.warn("[products DELETE] dependency check failed:", depErr);
    }
    await auth.store.deleteProduct(id);
    const auditUser = "user" in auth ? auth.user : { id: `api:${auth.apiKeyId}`, username: auth.apiKeyName, tenant_id: auth.tenantId };
    await audit(auth.store, auditUser, req, "product.delete", "product", id);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
