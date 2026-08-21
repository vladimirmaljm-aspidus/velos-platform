import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getSupabase } from "@/lib/supabase/client";
import { calculateSupplyDemandIndex } from "@/lib/marketplace/intelligence";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

/**
 * GET /api/marketplace/intelligence/supply-demand — supply/demand index
 * per category, for the market-intelligence dashboard.
 *
 * Returns `{ index, balance, description, buyPosts, sellPosts, trend }`:
 *   • index        — 0–100. >50 → demand-heavy (buyer market), <50 →
 *                    supply-heavy.
 *   • balance      — 'buyer_market' | 'seller_market' | 'balanced'.
 *   • description  — human-readable summary, ready for the gauge's
 *                    caption.
 *   • buyPosts     — count of `post_type='buy'` listings in window.
 *   • sellPosts    — count of `post_type='sell'` listings in window.
 *   • trend        — 'rising' | 'falling' | 'flat' — the change in the
 *                    index over the last 7 days vs the previous 7 days.
 *
 * Query params:
 *   ?category=<product_category>   filter to a single category.
 *   ?days=<7..365>                  window size (default 30).
 *
 * Auth: any active portal session.
 */
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const url = new URL(req.url);
  const category = url.searchParams.get("category") || undefined;
  const daysRaw = Number(url.searchParams.get("days")) || 30;
  const days = Math.max(7, Math.min(365, Math.floor(daysRaw)));

  const sb = getSupabase();
  const since = new Date(
    Date.now() - days * 24 * 60 * 60 * 1000,
  ).toISOString();
  const sincePrev = new Date(
    Date.now() - (days + 7) * 24 * 60 * 60 * 1000,
  ).toISOString();
  const sincePrevEnd = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const tenantId = access.tenant_id;
  async function countPosts(
    postType: "buy" | "sell",
    fromIso: string,
    toIso?: string,
  ): Promise<number> {
    let q = sb
      .from("marketplace_posts")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("post_type", postType)
      .gte("created_at", fromIso);
    if (toIso) q = q.lt("created_at", toIso);
    if (category) q = q.ilike("product_category", category);
    const { count } = await q;
    return count ?? 0;
  }

  let buyNow = 0;
  let sellNow = 0;
  let buyPrev = 0;
  let sellPrev = 0;
  try {
    [buyNow, sellNow, buyPrev, sellPrev] = await Promise.all([
      countPosts("buy", since),
      countPosts("sell", since),
      countPosts("buy", sincePrev, sincePrevEnd),
      countPosts("sell", sincePrev, sincePrevEnd),
    ]);
  } catch (e) {
    console.error("[marketplace.intelligence.supply-demand] count failed:", e);
    return NextResponse.json(
      { error: "Failed to compute supply/demand index." },
      { status: 500 },
    );
  }

  const result = calculateSupplyDemandIndex(buyNow, sellNow);

  // Trend: the previous 7-day index vs the last 7-day index. The caller
  // can compute this from the per-window buy/sell counts above. The
  // "previous" window is the 7 days before the last 7 days — both
  // inside the `days` window.
  const lastIdx = calculateSupplyDemandIndex(buyNow - buyPrev, sellNow - sellPrev).index;
  const prevIdx = calculateSupplyDemandIndex(buyPrev, sellPrev).index;
  let trend: "rising" | "falling" | "flat" = "flat";
  if (lastIdx - prevIdx > 5) trend = "rising";
  else if (lastIdx - prevIdx < -5) trend = "falling";

  return NextResponse.json({
    ...result,
    buyPosts: buyNow,
    sellPosts: sellNow,
    trend,
  });
}

export const GET = withApm(_get, "GET /api/marketplace/intelligence/supply-demand");
