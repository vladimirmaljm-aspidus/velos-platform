import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getSupabase } from "@/lib/supabase/client";
import { calculateSeasonalPattern } from "@/lib/marketplace/intelligence";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

/**
 * GET /api/marketplace/intelligence/seasonal — seasonal patterns per
 * category (historical monthly averages), for the market-intelligence
 * dashboard.
 *
 * Returns `{ months, currency, sampleSize }`:
 *   • months     — SeasonalMonth[12], one per calendar month, with
 *                  `avgPrice`, `avgVolume` (= sample count in that
 *                  month bucket), and `pattern` (high/medium/low).
 *   • currency   — the price series' currency.
 *   • sampleSize — total rows scanned.
 *
 * The pattern is volume-based (not price-based) because price
 * seasonality in a small sample is noisy. The caller can overlay the
 * price chart on the volume bars to spot the actual seasonal effect.
 *
 * Query params:
 *   ?category=<product_category>   filter to a single category.
 *   ?currency=<USD|EUR|...>         price-currency filter (default USD).
 *
 * The route fetches up to 2 years of history so each calendar month
 * bucket has up to 2 data points (one per year).
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
  const currency = (
    url.searchParams.get("currency") ||
    "USD"
  ).toUpperCase();

  const sb = getSupabase();
  // Fetch 2 years of history so each month bucket has 1–2 data points.
  const since = new Date(
    Date.now() - 2 * 365 * 24 * 60 * 60 * 1000,
  ).toISOString();

  // We need the post's `target_price` / `price_max` / `price_type` /
  // `currency` + the responses' `unit_price` / `currency` + `created_at`
  // for both. Two queries, then merge.
  let rows: any[] = [];

  try {
    let postQ = sb
      .from("marketplace_posts")
      .select(
        "id, post_type, target_price, price_max, price_type, currency, created_at",
      )
      .eq("tenant_id", access.tenant_id)
      .eq("post_type", "sell")
      .gte("created_at", since)
      .not("target_price", "is", null);
    if (category) postQ = postQ.ilike("product_category", category);
    // MARKET-H30: order by created_at DESC before the cap so the most
    // recent N posts are taken — without an explicit order, the 5000-
    // row cap would sample arbitrary rows. Recent posts are more
    // relevant for the seasonal pattern (the 2-year window still
    // covers multiple months per bucket).
    const { data: postRows, error: postErr } = await postQ
      .order("created_at", { ascending: false })
      .limit(5000);
    if (postErr) throw postErr;
    rows = rows.concat((postRows as any[]) || []);
  } catch (e) {
    console.error("[marketplace.intelligence.seasonal] posts fetch failed:", e);
  }

  // Fetch the responses too — accepted counter-offers are the strongest
  // price signal (transacted prices). We need the post's category for
  // the filter, so we join via PostgREST.
  try {
    let respQ = sb
      .from("marketplace_responses")
      .select(
        "id, unit_price, currency, created_at, post:marketplace_posts!inner(product_category, tenant_id)",
      )
      .eq("tenant_id", access.tenant_id)
      .gte("created_at", since)
      .not("unit_price", "is", null);
    if (category) {
      respQ = respQ.ilike("post.product_category", category);
    }
    // MARKET-H30: same fix as the posts query above — order DESC before
    // the cap so the most recent responses are kept.
    const { data: respRows, error: respErr } = await respQ
      .order("created_at", { ascending: false })
      .limit(5000);
    if (respErr) throw respErr;
    rows = rows.concat((respRows as any[]) || []);
  } catch (e) {
    console.error("[marketplace.intelligence.seasonal] responses fetch failed:", e);
  }

  const months = calculateSeasonalPattern(rows, currency);
  return NextResponse.json({
    months,
    currency,
    sampleSize: rows.length,
  });
}

export const GET = withApm(_get, "GET /api/marketplace/intelligence/seasonal");
