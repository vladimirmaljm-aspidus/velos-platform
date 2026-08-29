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
  const nowIso = new Date().toISOString();
  const since = new Date(
    Date.now() - days * 24 * 60 * 60 * 1000,
  ).toISOString();
  // MARKET-H29: the trend is "last 7 days" vs "previous 7 days" — two
  // NON-OVERLAPPING 7-day windows. The previous implementation computed
  // the "last 7 days" as `buyNow - buyPrev` where `buyNow` was the
  // full `days` window and `buyPrev` was the `days` window shifted back
  // by 7 days. Those two windows OVERLAP in the middle (each covers
  // `[now-days, now-7]`), so the subtraction double-counted and the
  // resulting "last 7 days" was wrong. We now fetch each of the four
  // 7-day-only counts directly:
  //   • buyLast7  / sellLast7  = posts created in [now-7d, now)
  //   • buyPrev7  / sellPrev7  = posts created in [now-14d, now-7d)
  // The `sincePrev` (now-14d) + `sincePrevEnd` (now-7d) bounds are kept
  // for the previous window; the new `nowIso` is the upper bound for the
  // last-7-days window.
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
  let buyLast7 = 0;
  let sellLast7 = 0;
  let buyPrev7 = 0;
  let sellPrev7 = 0;
  try {
    [buyNow, sellNow, buyLast7, sellLast7, buyPrev7, sellPrev7] = await Promise.all([
      countPosts("buy", since),
      countPosts("sell", since),
      // Last 7 days only — non-overlapping with the previous-7 window.
      countPosts("buy", sincePrevEnd, nowIso),
      countPosts("sell", sincePrevEnd, nowIso),
      // Previous 7 days only (the 7 days before the last 7 days).
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

  // Trend: the last-7-day supply/demand index vs the previous-7-day
  // index. Both windows are 7 days wide and non-overlapping, so the
  // delta reflects a true week-over-week change.
  const lastIdx = calculateSupplyDemandIndex(buyLast7, sellLast7).index;
  const prevIdx = calculateSupplyDemandIndex(buyPrev7, sellPrev7).index;
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
