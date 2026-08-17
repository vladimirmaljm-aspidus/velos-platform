import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * GET /api/automation/product-context?product_id=xxx&tenant_id=xxx
 *
 * Returns ALL context related to a product in one response so the offer /
 * trade-calculator / demand UIs can render without N+1 round-trips.
 *
 * Product Catalog has been merged into Products — the Product itself now
 * carries HS code, brand, coa_params, detailed_spec, etc. The legacy
 * `catalog_entry_id` query param is still accepted for backward compat but
 * is a no-op (the response always returns `catalogEntry: null`).
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (dashboard.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "dashboard.read"); if (_d) return _d; } /* requirePermission wired */


  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) return NextResponse.json({ items: [], total: 0 });

  const url = new URL(req.url);
  const productId = url.searchParams.get("product_id");
  const catalogEntryId = url.searchParams.get("catalog_entry_id");
  // catalogEntryId is accepted for backward compat with old bookmarks /
  // integrations but is intentionally unused — Product Catalog is merged
  // into Products. We keep the parameter so old callers don't 400.
  void catalogEntryId;

  if (!productId) {
    return NextResponse.json(
      {
        error:
          "product_id is required. (catalog_entry_id is deprecated — Product Catalog has been merged into Products.)",
      },
      { status: 400 }
    );
  }

  try {
    const store = auth.store;

    // 1. Product details — Product now carries all trade metadata (HS code,
    //    brand, coa_params, detailed_spec, logistics, etc.) directly, so no
    //    catalog lookup is needed.
    const product = await store.getProduct(productId);
    if (!product) {
      return NextResponse.json({ error: "Product not found." }, { status: 404 });
    }
    // Tenant ownership check — without this, any authenticated user could fetch
    // any other tenant's product by ID (audit finding C-1).
    if ("user" in auth && !auth.isSuperAdmin && product.tenant_id !== tenantId) {
      return NextResponse.json({ error: "Product not found." }, { status: 404 });
    }

    // 2. Supplier offers for this product
    const supplierOffers = await store.listSupplierOffers(tenantId, {
      limit: 20,
      filters: { product_id: productId },
    });

    // 3. Price history — derived from recent offers that include this product
    //    (matched by product_id or SKU).
    const recentOffers = await store.listOffers(tenantId, { limit: 50 });
    const priceHistory: Array<{
      date: string;
      source: string;
      source_number: string;
      unit_price: number;
      currency: string;
      quantity: number;
    }> = [];

    for (const offer of recentOffers.items) {
      for (const item of offer.items) {
        if (item.product_id === productId || item.sku === product.sku) {
          priceHistory.push({
            date: offer.created_at,
            source: "offer",
            source_number: offer.number,
            unit_price: item.unit_price,
            currency: offer.currency,
            quantity: item.quantity,
          });
        }
      }
    }

    // Sort price history by date descending
    priceHistory.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return NextResponse.json({
      product,
      // Kept for backward compat — no longer populated. Consumers should read
      // trade metadata (hs_code, brand, coa_params, detailed_spec, origin,
      // logistics, shelf_life) from `product` directly.
      catalogEntry: null,
      supplierOffers: supplierOffers.items,
      // Trade calculations are now derived live in the trade-calculator view;
      // we return an empty array for backward compat with the existing response
      // shape consumed by offers-view.tsx / demands-view.tsx.
      tradeCalculations: [],
      inventoryStatus: {
        stock: product.stock,
        reorder_level: product.reorder_level,
        low_stock: product.stock <= product.reorder_level,
        unit: product.unit,
      },
      priceHistory: priceHistory.slice(0, 20), // Last 20 price entries
    });
  } catch (e) {
    console.error("[automation/product-context]", e);
    return NextResponse.json(
      { error: "Failed to load product context." },
      { status: 500 }
    );
  }
}
