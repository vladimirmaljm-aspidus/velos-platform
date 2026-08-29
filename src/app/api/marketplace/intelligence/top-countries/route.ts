import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getSupabase } from "@/lib/supabase/client";
import { calculateTopCountries } from "@/lib/marketplace/intelligence";
import { getCountry } from "@/lib/data/geo/countries";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

/**
 * GET /api/marketplace/intelligence/top-countries — top importing/
 * exporting countries per category, for the market-intelligence
 * dashboard.
 *
 * Returns `{ importers: TopCountryExt[], exporters: TopCountryExt[],
 * sampleSize: number }`:
 *   • importers — countries with the most `post_type='buy'` listings
 *                  in the window (buyers = importers in a commodity
 *                  market).
 *   • exporters — countries with the most `post_type='sell'` listings
 *                  in the window.
 *   • sampleSize — total posts scanned.
 *
 * Each `TopCountryExt` row extends `TopCountry` with `name` and `flag`
 * from the static countries table so the UI can render without an extra
 * lookup.
 *
 * Query params:
 *   ?category=<product_category>   filter to a single category.
 *   ?days=<7..365>                  window size (default 30).
 *   ?limit=<1..50>                  max countries per list (default 10).
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
  const limitRaw = Number(url.searchParams.get("limit")) || 10;
  const limit = Math.max(1, Math.min(50, Math.floor(limitRaw)));

  const sb = getSupabase();
  const since = new Date(
    Date.now() - days * 24 * 60 * 60 * 1000,
  ).toISOString();

  let q = sb
    .from("marketplace_posts")
    .select(
      "id, post_type, delivery_country, product_category, created_at",
    )
    .eq("tenant_id", access.tenant_id)
    .in("post_type", ["buy", "sell"])
    .gte("created_at", since)
    .not("delivery_country", "is", null);
  if (category) q = q.ilike("product_category", category);
  let rows: any[] = [];
  try {
    // MARKET-H30: order by created_at DESC before the cap so the most
    // recent N posts are taken. Without an explicit order, PostgREST
    // returns rows in an unspecified order, so the 5000-row cap would
    // silently take an arbitrary (and inconsistent across calls) sample.
    // The bias toward recent posts is intentional + consistent — a
    // dashboard showing "top countries" should weight recent activity
    // more than months-old activity anyway.
    const { data } = await q.order("created_at", { ascending: false }).limit(5000);
    rows = (data as any[]) || [];
  } catch (e) {
    console.error("[marketplace.intelligence.top-countries] fetch failed:", e);
    return NextResponse.json(
      { error: "Failed to compute top countries." },
      { status: 500 },
    );
  }

  // Decorate with country name + flag for the UI.
  const decorate = (
    list: ReturnType<typeof calculateTopCountries>,
  ) =>
    list.map((c) => {
      const country = getCountry(c.country);
      return {
        ...c,
        name: country?.name ?? c.country,
        flag: country?.flag ?? "",
      };
    });

  const importers = decorate(calculateTopCountries(rows, "buy", limit));
  const exporters = decorate(calculateTopCountries(rows, "sell", limit));

  return NextResponse.json({
    importers,
    exporters,
    sampleSize: rows.length,
  });
}

export const GET = withApm(_get, "GET /api/marketplace/intelligence/top-countries");
