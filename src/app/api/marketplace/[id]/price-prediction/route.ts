import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getSupabase } from "@/lib/supabase/client";
import {
  predictPrice,
  buildPriceHistory,
  type PricePrediction,
  type PriceHistoryPoint,
} from "@/lib/marketplace/price-prediction";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

/**
 * GET /api/marketplace/[id]/price-prediction — 30-day price forecast for
 * a post's product.
 *
 * Returns `{ prediction, history }`:
 *   • prediction: PricePrediction — the 30-day forecast with min/max
 *     band, trend direction, confidence %, and a human-readable factors
 *     list + seasonal note.
 *   • history: PriceHistoryPoint[] — a 12-week weekly-average series for
 *     the trend chart on the post-detail page.
 *
 * The route fetches the post (to get product_name + product_category +
 * currency) + every comparable sell post in the tenant + every
 * response (counter-offer) on those posts. All of those rows are passed
 * to the pure `predictPrice()` + `buildPriceHistory()` functions in
 * src/lib/marketplace/price-prediction.ts.
 *
 * Auth: any active portal session in the same tenant as the post. The
 * prediction is read-only.
 *
 * ?currency= override (default = the post's currency). Useful when a
 * partner browses a USD-priced post while their preferred currency is
 * EUR — they can request the forecast in their own currency (the
 * underlying prices are filtered by currency, so cross-currency
 * comparisons are not mixed).
 */
async function _get(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;

  const sb = getSupabase();

  // Fetch the post — we need product_name + product_category + currency.
  const { data: postRow, error: postErr } = await sb
    .from("marketplace_posts")
    .select("id, tenant_id, product_name, product_category, currency")
    .eq("id", id)
    .maybeSingle();
  if (postErr) {
    console.error("[marketplace.price-prediction] post lookup failed:", postErr);
    return NextResponse.json({ error: "Failed to load post." }, { status: 500 });
  }
  if (!postRow) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const post = postRow as {
    tenant_id: string;
    product_name: string;
    product_category: string | null;
    currency: string;
  };
  if (post.tenant_id !== access.tenant_id) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  // Allow the caller to override the currency (default to the post's
  // currency so the prediction is in the partner's preferred unit).
  const url = new URL(req.url);
  const currency = (url.searchParams.get("currency") || post.currency || "USD").toUpperCase();

  const productName = post.product_name ?? "";
  const productCategory = post.product_category ?? "";

  // Fetch every comparable sell post in the tenant (last 90 days) with a
  // visible price. We use 90 days rather than 60 to give the trend
  // calculation more historical depth (the prediction function still
  // only buckets into 30-day windows — anything older than 60 days is
  // dropped at the bucketing step, but having the extra data around
  // is cheap).
  const since90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  let comparablePosts: any[] = [];
  try {
    const { data: posts } = await sb
      .from("marketplace_posts")
      .select(
        "id, post_type, target_price, price_max, price_type, currency, status, created_at",
      )
      .eq("tenant_id", access.tenant_id)
      .eq("post_type", "sell")
      .ilike("product_name", `%${productName.replace(/[%_]/g, " ")}%`)
      .gte("created_at", since90d);
    comparablePosts = (posts as any[]) || [];
  } catch (e) {
    console.error("[marketplace.price-prediction] posts fetch failed:", e);
  }

  // Fetch every response (counter-offer) on those posts — the accepted
  // responses are a stronger price signal than un-accepted posts.
  const postIds = comparablePosts.map((p) => p.id);
  let comparableResponses: any[] = [];
  if (postIds.length > 0) {
    try {
      const { data: responses } = await sb
        .from("marketplace_responses")
        .select("id, unit_price, currency, status, created_at")
        .in("post_id", postIds)
        .not("unit_price", "is", null);
      comparableResponses = (responses as any[]) || [];
    } catch (e) {
      console.error("[marketplace.price-prediction] responses fetch failed:", e);
    }
  }

  const prediction: PricePrediction = predictPrice(
    comparablePosts,
    comparableResponses,
    productCategory,
    currency,
    productName,
  );

  const history: PriceHistoryPoint[] = buildPriceHistory(
    comparablePosts,
    comparableResponses,
    currency,
    12,
  );

  return NextResponse.json({
    prediction,
    history,
    currency,
    sampleSize: comparablePosts.length + comparableResponses.length,
  });
}

export const GET = withApm(_get, "GET /api/marketplace/[id]/price-prediction");
