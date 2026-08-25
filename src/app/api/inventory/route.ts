import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api/helpers";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (inventory.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "inventory.read"); if (_d) return _d; } /* requirePermission wired */
    // Feature gate (module_inventory)
    { const { requireFeature } = await import("@/lib/api/feature-guard");
      const _f = await requireFeature(auth.tenantId, "module_inventory", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    const tid = auth.tenantId!;
    const url = new URL(req.url);
    const partner_id = url.searchParams.get("partner_id") || undefined;
    const product_id = url.searchParams.get("product_id") || undefined;
    const search = url.searchParams.get("search") || undefined;
    const low_stock = url.searchParams.get("low_stock") === "1";
    // FIX-MARKET-UI / FIX 4 — pagination. Cap limit to 200 (matches the
    // commission routes' cap — defensive against abuse; views default to 20).
    const limit = url.searchParams.get("limit")
      ? Math.min(Number(url.searchParams.get("limit")), 200)
      : undefined;
    const offset = url.searchParams.get("offset")
      ? Math.max(Number(url.searchParams.get("offset")), 0)
      : undefined;

    if (low_stock) {
      // FIX-MARKET-UI / FIX 4 — "Low Stock" view: products at or below
      // their reorder_level. Returns the same {items,total} envelope as
      // movements so the client can swap the render mode based on the
      // `low_stock` URL flag.
      const result = await auth.store.listLowStockProducts(tid, { limit, offset });
      return NextResponse.json(result);
    }

    const result = await auth.store.listAllInventory(tid, {
      filters: { partner_id, product_id },
      search,
      limit,
      offset,
    });
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
