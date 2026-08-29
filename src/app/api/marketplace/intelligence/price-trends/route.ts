import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getSupabase } from "@/lib/supabase/client";
import { calculatePriceTrend } from "@/lib/marketplace/intelligence";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

/**
 * GET /api/marketplace/intelligence/price-trends — 12-week (configurable)
 * price history per category, for the market-intelligence dashboard.
 *
 * Returns `{ weeks, trend, changePercent, currency, sampleSize }`:
 *   • weeks          — 12 weekly buckets (avgPrice / minPrice / maxPrice /
 *                      sampleCount) for the chart's line series.
 *   • trend          — 'up' | 'down' | 'stable' — derived from the linear-
 *                      regression slope of the weekly averages.
 *   • changePercent  — relative % change between the first and last week
 *                      with samples.
 *   • currency       — the price series' currency (defaults to USD, the
 *                      `?currency=` query overrides per the caller's
 *                      preferred currency).
 *   • sampleSize     — total comparable price rows used.
 *
 * Query params:
 *   ?category=<product_category>   filter to a single product category.
 *                                  Empty / omitted = aggregate across
 *                                  all categories.
 *   ?weeks=<1..52>                  window size (default 12).
 *   ?currency=<USD|EUR|...>         price-currency filter (default USD).
 *
 * The route fetches every comparable sell post + every response
 * (counter-offer) in the caller's tenant within the window, passes them
 * to the pure `calculatePriceTrend()` in src/lib/marketplace/intelligence.ts,
 * and returns the result. Auth: any active portal session.
 */
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const url = new URL(req.url);
  const category = url.searchParams.get("category") || undefined;
  const weeksRaw = Number(url.searchParams.get("weeks")) || 12;
  const weeks = Math.max(1, Math.min(52, Math.floor(weeksRaw)));
  const currency = (
    url.searchParams.get("currency") ||
    "USD"
  ).toUpperCase();
  const since = new Date(
    Date.now() - weeks * 7 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const sb = getSupabase();

  let posts: any[] = [];
  let responses: any[] = [];
  try {
    // MARKET-H30 + MARKET-H31: order by created_at DESC so when the
    // caller slices postIds to 3000 (line 100), the MOST RECENT 3000
    // posts are taken — without an explicit order, the slice would
    // silently take arbitrary posts. The `.in("status", ["active",
    // "closed"])` filter (MARKET-H31) drops draft / cancelled posts
    // that would otherwise pollute the trend with non-actionable
    // prices (a draft post's target_price is often a placeholder
    // the partner hasn't finalised yet).
    const { data: postRows } = await sb
      .from("marketplace_posts")
      .select(
        "id, post_type, target_price, price_max, price_type, currency, created_at",
      )
      .eq("tenant_id", access.tenant_id)
      .eq("post_type", "sell")
      .in("status", ["active", "closed"])
      .gte("created_at", since)
      .not("target_price", "is", null)
      .order("created_at", { ascending: false });
    if (category) {
      // PostgREST eq is case-sensitive — product_category is stored
      // canonically (the create route stores exactly what the partner
      // sent), so use ilike to be permissive.
      const { data: catRows } = await sb
        .from("marketplace_posts")
        .select(
          "id, post_type, target_price, price_max, price_type, currency, created_at",
        )
        .eq("tenant_id", access.tenant_id)
        .eq("post_type", "sell")
        .in("status", ["active", "closed"])
        .ilike("product_category", category)
        .gte("created_at", since)
        .not("target_price", "is", null)
        .order("created_at", { ascending: false });
      posts = (catRows as any[]) || [];
    } else {
      posts = (postRows as any[]) || [];
    }
  } catch (e) {
    console.error("[marketplace.intelligence.price-trends] posts fetch failed:", e);
  }

  // Fetch every response (counter-offer) on those posts — accepted
  // responses are a stronger price signal than un-accepted posts.
  const postIds = posts.map((p) => p.id);
  if (postIds.length > 0) {
    try {
      // PostgREST `in` filter caps at ~3k ids; we slice defensively in
      // case a busy tenant exceeds the cap. The posts query above is
      // ordered DESC by created_at, so the slice keeps the most recent
      // 3000 posts' responses.
      const { data: responseRows } = await sb
        .from("marketplace_responses")
        .select("id, unit_price, currency, status, created_at")
        .in("post_id", postIds.slice(0, 3000))
        .not("unit_price", "is", null);
      responses = (responseRows as any[]) || [];
    } catch (e) {
      console.error("[marketplace.intelligence.price-trends] responses fetch failed:", e);
    }
  }

  const result = calculatePriceTrend(posts, responses, currency, weeks);
  return NextResponse.json({
    ...result,
    currency,
    // MARKET-M14 — `sampleSize` is the number of UNIQUE sell posts the
    // trend was derived from. The previous `posts.length + responses.length`
    // double-counted: every response (counter-offer) is attached to a
    // post already in `posts`, so adding `responses.length` inflated the
    // sample size by the number of counter-offers — a post with 5 counter-
    // offers contributed 6 to `sampleSize` instead of 1. The UI uses
    // sampleSize to label the chart ("based on N samples") and to gate
    // `hasData` — inflated values misled users into thinking the trend
    // was based on more independent observations than it actually was.
    // `posts.length` is the honest count of distinct data sources.
    sampleSize: posts.length,
  });
}

export const GET = withApm(_get, "GET /api/marketplace/intelligence/price-trends");
