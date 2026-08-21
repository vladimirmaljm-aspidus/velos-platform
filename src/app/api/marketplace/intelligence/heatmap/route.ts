import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getSupabase } from "@/lib/supabase/client";
import { generateHeatmapData } from "@/lib/marketplace/intelligence";
import { getCountry } from "@/lib/data/geo/countries";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

/**
 * GET /api/marketplace/intelligence/heatmap — geographic demand heatmap
 * data (country → post count + intensity), for the market-intelligence
 * dashboard.
 *
 * Returns `{ points, sampleSize }`:
 *   • points — HeatmapPointExt[] sorted by postCount desc. Each row has
 *              `country` (ISO alpha-2), `lat`, `lng`, `intensity`
 *              (0–100 relative to busiest country), `postCount`, and
 *              the country's `name` + `flag` for the UI.
 *   • sampleSize — total posts scanned (those without a delivery_country
 *                  are dropped before counting).
 *
 * Query params:
 *   ?category=<product_category>   filter to a single category.
 *   ?type=<buy|sell>                restrict to one side of the market.
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
  const typeParam = url.searchParams.get("type");
  const type =
    typeParam === "buy" || typeParam === "sell" ? typeParam : undefined;
  const daysRaw = Number(url.searchParams.get("days")) || 30;
  const days = Math.max(7, Math.min(365, Math.floor(daysRaw)));

  const sb = getSupabase();
  const since = new Date(
    Date.now() - days * 24 * 60 * 60 * 1000,
  ).toISOString();

  let q = sb
    .from("marketplace_posts")
    .select("id, post_type, delivery_country, product_category, created_at")
    .eq("tenant_id", access.tenant_id)
    .gte("created_at", since)
    .not("delivery_country", "is", null);
  if (category) q = q.ilike("product_category", category);
  if (type) q = q.eq("post_type", type);
  let rows: any[] = [];
  try {
    const { data } = await q.limit(10000);
    rows = (data as any[]) || [];
  } catch (e) {
    console.error("[marketplace.intelligence.heatmap] fetch failed:", e);
    return NextResponse.json(
      { error: "Failed to compute heatmap." },
      { status: 500 },
    );
  }

  const points = generateHeatmapData(rows, type).map((p) => {
    const country = getCountry(p.country);
    return {
      ...p,
      name: country?.name ?? p.country,
      flag: country?.flag ?? "",
    };
  });

  return NextResponse.json({
    points,
    sampleSize: rows.length,
  });
}

export const GET = withApm(_get, "GET /api/marketplace/intelligence/heatmap");
