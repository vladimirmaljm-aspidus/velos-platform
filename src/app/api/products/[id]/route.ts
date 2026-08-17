import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(_req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (products.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "products.read"); if (_d) return _d; } /* requirePermission wired */

    const { id } = await params;
    const item = await auth.store.getProduct(id);
    if (!item) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && item.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return NextResponse.json(item);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (products.update)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "products.update"); if (_d) return _d; } /* requirePermission wired */

    const { id } = await params;
    const existing = await auth.store.getProduct(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const body = await req.json();
    const updated = await auth.store.upsertProduct({ ...body, id, tenant_id: existing.tenant_id });
    await audit(auth.store, auth.user, req, "product.update", "product", id, { name: updated.name });
    return NextResponse.json(updated);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (products.delete)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "products.delete"); if (_d) return _d; } /* requirePermission wired */

    const { id } = await params;
    const existing = await auth.store.getProduct(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
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
    await audit(auth.store, auth.user, req, "product.delete", "product", id);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
