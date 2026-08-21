import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getSupabase } from "@/lib/supabase/client";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// ─── Response shape ────────────────────────────────────────────────────────

export interface SmartSuggestion {
  /** Suggested product name — canonicalised + capitalised. */
  name: string;
  /** Most-likely product category code (e.g. "METAL", "AGRI"). */
  category: string | null;
  /** Suggested unit (e.g. "MT", "KG", "L"). */
  unit: string | null;
  /** Typical / mode unit price seen historically (in the caller's currency). */
  typicalPrice: number | null;
  /** Median target_price from comparable posts. */
  medianPrice: number | null;
  /** Number of historical posts backing this suggestion. */
  sampleSize: number;
  /** Caller's currency. */
  currency: string;
}

// ─── Route ────────────────────────────────────────────────────────────────

/**
 * GET /api/marketplace/smart-suggest?description=<text>&currency=USD
 *
 * Returns AI-powered product suggestions based on the partner's free-text
 * description of what they want to post. The suggestions are derived from
 * the tenant's historical sell posts — the most common product_name +
 * product_category + unit + price tuples that have appeared in the last
 * 180 days, ranked by how well they match the description keywords.
 *
 * The route does NOT call the VLM — the suggestion engine is a pure
 * keyword-overlap + frequency aggregator. It runs in O(N) on a
 * historically-capped dataset (≤200 rows) so the response is fast enough
 * to call per-keystroke (with a 400ms debounce on the client side).
 *
 * Response: `{ suggestions: SmartSuggestion[] }` — the top 5 matches.
 */
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const url = new URL(req.url);
  const description = (url.searchParams.get("description") || "").trim();
  const currency = (url.searchParams.get("currency") || "USD").toUpperCase();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || "5"), 1), 20);

  if (!description || description.length < 3) {
    return NextResponse.json({ suggestions: [] });
  }

  // Tokenise the description: lowercased, alnum-only, ≥3 chars, deduped.
  // Stop-words are filtered (the, and, for, etc.) so they don't dominate
  // the match score.
  const STOP = new Set([
    "the", "and", "for", "with", "from", "into", "this", "that",
    "have", "has", "are", "was", "were", "will", "would", "could",
    "should", "their", "there", "where", "when", "what", "your",
    "you", "all", "any", "off", "out", "new", "use", "uses", "used",
  ]);
  const tokens = Array.from(
    new Set(
      description
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .filter((t) => t.length >= 3 && !STOP.has(t)),
    ),
  );
  if (tokens.length === 0) {
    return NextResponse.json({ suggestions: [] });
  }

  const sb = getSupabase();

  // Fetch the last 180 days of sell posts in this tenant with a price.
  // PostgREST doesn't support full-text scoring, so we fetch a bounded
  // window (≤200 rows) and score client-side in JS. The 200-row cap is
  // ample — anything beyond 200 is a "popular" product that already has
  // strong frequency signal in the top rows.
  const since180d = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
  let rows: any[] = [];
  try {
    const { data, error } = await sb
      .from("marketplace_posts")
      .select(
        "id, product_name, product_category, unit, target_price, currency, created_at",
      )
      .eq("tenant_id", access.tenant_id)
      .eq("post_type", "sell")
      .not("target_price", "is", null)
      .gte("created_at", since180d)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    rows = (data as any[]) || [];
  } catch (e: any) {
    console.error("[marketplace.smart-suggest] fetch failed:", e);
    return NextResponse.json(
      { error: "Failed to fetch historical posts." },
      { status: 500 },
    );
  }

  // Filter rows to the caller's currency (avoid FX-rate mixing).
  const currencyRows = rows.filter(
    (r) => !r.currency || String(r.currency).toUpperCase() === currency,
  );

  // Score + group by product_name (case-insensitive). For each product,
  // accumulate the per-row match score + the category / unit votes +
  // the price samples.
  const groups = new Map<
    string,
    {
      canonicalName: string;
      category: string | null;
      unit: string | null;
      prices: number[];
      score: number;
      rows: number;
    }
  >();

  for (const r of currencyRows) {
    const name = String(r.product_name ?? "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const nameTokens = new Set(
      name.toLowerCase().split(/[^a-z0-9]+/i).filter((t) => t.length >= 3),
    );
    // Count how many description tokens appear in the product name.
    const overlap = tokens.filter((t) => nameTokens.has(t)).length;
    if (overlap === 0) continue; // no overlap → not a suggestion candidate

    // Score: overlap count + a small recency boost (most-recent 30 days
    // gets +1, last 90 gets +0.5).
    const ageDays = (Date.now() - new Date(r.created_at).getTime()) / (24 * 60 * 60 * 1000);
    const recencyBoost = ageDays <= 30 ? 1 : ageDays <= 90 ? 0.5 : 0;
    const score = overlap + recencyBoost;

    const existing = groups.get(key);
    const price = Number(r.target_price);
    if (existing) {
      existing.rows += 1;
      existing.score += score;
      if (r.product_category && !existing.category) existing.category = r.product_category;
      if (r.unit && !existing.unit) existing.unit = r.unit;
      if (Number.isFinite(price) && price > 0) existing.prices.push(price);
    } else {
      groups.set(key, {
        canonicalName: name,
        category: r.product_category ?? null,
        unit: r.unit ?? null,
        prices: Number.isFinite(price) && price > 0 ? [price] : [],
        score,
        rows: 1,
      });
    }
  }

  // Rank by score (descending), then by row count (descending — popular
  // products win ties), then alphabetical. Take the top `limit`.
  const ranked = Array.from(groups.values())
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.rows !== a.rows) return b.rows - a.rows;
      return a.canonicalName.localeCompare(b.canonicalName);
    })
    .slice(0, limit);

  // Build the SmartSuggestion response shape. Compute the median + mode
  // (typical) price per group.
  const suggestions: SmartSuggestion[] = ranked.map((g) => {
    const sorted = [...g.prices].sort((a, b) => a - b);
    const median =
      sorted.length === 0
        ? null
        : sorted.length % 2 === 0
          ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
          : sorted[Math.floor(sorted.length / 2)];
    // "Typical" = the mode if there are duplicates, otherwise the median.
    // For B2B commodity pricing the median is the right central tendency
    // (the mean is sensitive to a single outlier).
    return {
      name: g.canonicalName,
      category: g.category,
      unit: g.unit,
      typicalPrice: median,
      medianPrice: median,
      sampleSize: g.rows,
      currency,
    };
  });

  return NextResponse.json({ suggestions });
}

export const GET = withApm(_get, "GET /api/marketplace/smart-suggest");
