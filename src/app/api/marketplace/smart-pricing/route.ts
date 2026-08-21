import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getMarketPriceStats } from "@/lib/data/marketplace-auction-store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/smart-pricing?product=<name>&price=<target>&currency=<USD>
// — return market price statistics for the given product so the create-post
// form can warn the poster when their target_price is far above/below the
// historical market average.
//
// The response is `{ stats: MarketPriceStats }` — see
// src/lib/supabase/marketplace-auction-types.ts for the shape.
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const url = new URL(req.url);
  const product = url.searchParams.get("product") || "";
  const priceRaw = url.searchParams.get("price");
  const currency = url.searchParams.get("currency") || "USD";
  const targetPrice = priceRaw !== null && priceRaw !== "" ? Number(priceRaw) : null;

  if (!product.trim()) {
    return NextResponse.json({
      stats: {
        product_name: "",
        average_price: null,
        median_price: null,
        min_price: null,
        max_price: null,
        sample_size: 0,
        currency,
        assessment: "unknown",
        suggested_price: null,
      },
    });
  }

  try {
    const stats = await getMarketPriceStats(
      access.tenant_id,
      product,
      currency,
      Number.isFinite(targetPrice as number) ? (targetPrice as number) : null,
    );
    return NextResponse.json({ stats });
  } catch (e: any) {
    console.error("[marketplace.smart-pricing]", e);
    return NextResponse.json({ error: "Failed to compute market price stats." }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/smart-pricing");
