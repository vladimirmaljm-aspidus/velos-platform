// Marketplace Phase 9 — market intelligence (price trends, supply/demand,
// top countries, heatmap, seasonal patterns, user benchmarking).
//
// All functions here are PURE + SYNCHRONOUS + DATA-AGNOSTIC:
//   • They take plain JSON rows (MarketplacePost / MarketplaceResponse
//     shapes work directly, but the functions read only the fields they
//     need via Record<string, any> access, so partial / sanitised shapes
//     also work).
//   • They never touch Supabase, the auth context, or the SDK. That keeps
//     them unit-testable without spinning up a database, and the API
//     routes can fetch the rows once + pass them to several calculators
//     (a single big query powers the entire dashboard).
//   • Trend / balance / percentile decisions use simple, explainable
//     thresholds so the UI can render "why" — no black-box ML here. The
//     heavier forecasting (30-day band, volatility, seasonality note) is
//     already handled in `price-prediction.ts`; the intelligence layer
//     reuses that where appropriate and adds cross-category comparisons.
//
// INPUT CONTRACT (each function lists the row fields it reads). All
// numeric coercion goes through `toNumber()` so a Supabase null / empty
// string never produces a NaN.

// ─── Helpers ─────────────────────────────────────────────────────────────

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toIso(v: unknown): string | null {
  if (!v) return null;
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function mean(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Price trend (12 weeks) ────────────────────────────────────────────

export interface PriceTrendWeek {
  /** ISO date — the bucket start (Monday 00:00 UTC). */
  week: string;
  avgPrice: number;
  minPrice: number;
  maxPrice: number;
  sampleCount: number;
}

export interface PriceTrendResult {
  weeks: PriceTrendWeek[];
  trend: "up" | "down" | "stable";
  /** Percentage change from the first week to the last week with data
   *  (rounded to 2 decimals). 0 when there is < 2 weeks of data. */
  changePercent: number;
}

/**
 * Build a 12-week price history per category.
 *
 * Reads from `posts` (sell-only, fixed/range target_price) and
 * `responses` (any unit_price). Prices are filtered to the supplied
 * `currency` to avoid mixing FX. The `weeks` parameter is configurable
 * (default 12) so the same function powers the 1m / 3m / 6m / 1y time
 * ranges on the dashboard.
 *
 * Trend direction is computed from a simple linear-fit slope across the
 * weekly averages (least-squares). A slope of more than +3% across the
 * window = "up"; less than -3% = "down"; between = "stable". This is the
 * same threshold logic used by `predictPrice()` for trend direction so
 * the two layers feel consistent.
 *
 * `changePercent` is `(lastAvg - firstAvg) / firstAvg * 100`, computed
 * from the first and last weeks that actually had samples (so a long
 * empty stretch in the middle doesn't push the percentage to 0).
 */
export function calculatePriceTrend(
  posts: any[],
  responses: any[],
  currency: string = "USD",
  weeks: number = 12,
): PriceTrendResult {
  const cur = currency || "USD";
  const dayMs = 24 * 60 * 60 * 1000;
  const weekMs = 7 * dayMs;
  const now = Date.now();
  const totalWeeks = Math.max(1, Math.min(52, weeks));

  const datedPrices: Array<{ price: number; date: string }> = [];

  if (Array.isArray(posts)) {
    for (const p of posts) {
      const post = (p ?? {}) as Record<string, any>;
      if (post.post_type && post.post_type !== "sell") continue;
      const priceType = post.price_type ?? "fixed";
      if (priceType === "on_request") continue;
      const target = toNumber(post.target_price);
      const max = toNumber(post.price_max);
      let price: number | null = target;
      if (priceType === "range" && target !== null && max !== null) {
        price = (target + max) / 2;
      }
      if (price === null || price <= 0) continue;
      const postCurrency = (post.currency ?? cur) as string;
      if (postCurrency && postCurrency !== cur) continue;
      const iso = toIso(post.created_at);
      if (!iso) continue;
      datedPrices.push({ price, date: iso });
    }
  }

  if (Array.isArray(responses)) {
    for (const r of responses) {
      const resp = (r ?? {}) as Record<string, any>;
      const unitPrice = toNumber(resp.unit_price);
      if (unitPrice === null || unitPrice <= 0) continue;
      const respCurrency = (resp.currency ?? cur) as string;
      if (respCurrency && respCurrency !== cur) continue;
      const iso = toIso(resp.created_at);
      if (!iso) continue;
      datedPrices.push({ price: unitPrice, date: iso });
    }
  }

  // Bucket prices into per-week windows. Iterate oldest → newest so the
  // chart's X axis reads left → right.
  const buckets: PriceTrendWeek[] = [];
  for (let w = totalWeeks - 1; w >= 0; w--) {
    const bucketEnd = now - w * weekMs;
    const bucketStart = bucketEnd - weekMs;
    const samples: number[] = [];
    for (const dp of datedPrices) {
      const t = new Date(dp.date).getTime();
      if (!Number.isFinite(t)) continue;
      if (t >= bucketStart && t < bucketEnd) {
        samples.push(dp.price);
      }
    }
    buckets.push({
      week: new Date(bucketStart).toISOString(),
      avgPrice: samples.length > 0 ? round2(mean(samples)) : 0,
      minPrice: samples.length > 0 ? round2(Math.min(...samples)) : 0,
      maxPrice: samples.length > 0 ? round2(Math.max(...samples)) : 0,
      sampleCount: samples.length,
    });
  }

  // Linear-regression slope across the populated weeks (rounded to 2
  // decimals). Using only weeks with samples means a long dead stretch
  // doesn't tilt the slope toward zero.
  const populated = buckets.filter((b) => b.sampleCount > 0);
  let slopePct = 0;
  if (populated.length >= 2) {
    const xs: number[] = [];
    const ys: number[] = [];
    populated.forEach((b, i) => {
      // Use the index of the populated week in the FULL buckets array
      // (not in `populated`) so weeks far apart get a wider x range —
      // the slope better reflects the trend over time.
      const x = buckets.indexOf(b);
      xs.push(x);
      ys.push(b.avgPrice);
    });
    const n = xs.length;
    const xMean = mean(xs);
    const yMean = mean(ys);
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - xMean) * (ys[i] - yMean);
      den += (xs[i] - xMean) ** 2;
    }
    const slope = den === 0 ? 0 : num / den;
    const firstAvg = ys[0] || 0;
    slopePct = firstAvg > 0 ? (slope / firstAvg) * 100 : 0;
  }

  let trend: "up" | "down" | "stable" = "stable";
  if (slopePct > 3) trend = "up";
  else if (slopePct < -3) trend = "down";

  // changePercent = (last - first) / first * 100 using the populated
  // weeks only. Falls back to 0 when there are fewer than 2 populated
  // weeks.
  let changePercent = 0;
  if (populated.length >= 2) {
    const firstAvg = populated[0].avgPrice;
    const lastAvg = populated[populated.length - 1].avgPrice;
    if (firstAvg > 0) {
      changePercent = round2(((lastAvg - firstAvg) / firstAvg) * 100);
    }
  }

  return {
    weeks: buckets,
    trend,
    changePercent,
  };
}

// ─── Supply / demand index ─────────────────────────────────────────────

export interface SupplyDemandResult {
  /** 0–100. >50 → demand-heavy (buyer market — sellers have the upper
   *  hand because there are more buyers than sellers), <50 → supply-heavy.
   *  Exactly 50 → perfectly balanced. */
  index: number;
  balance: "buyer_market" | "seller_market" | "balanced";
  description: string;
}

/**
 * Supply/demand index from the counts of buy vs sell posts in a category.
 *
 *   buyPosts   — number of `post_type='buy'` listings (DEMAND side:
 *                 partners looking to BUY signal that there is demand).
 *   sellPosts  — number of `post_type='sell'` listings (SUPPLY side:
 *                 partners looking to SELL signal that there is supply).
 *
 * Index formula (0–100, demand-heavy > 50):
 *   ratio = buyPosts / (buyPosts + sellPosts)
 *   index = round(ratio * 100)
 *
 *   index > 55 → 'buyer_market' (more buyers than sellers — sellers
 *                can hold out for higher prices).
 *   index < 45 → 'seller_market' (more sellers than buyers — buyers
 *                have negotiating leverage).
 *   45 ≤ index ≤ 55 → 'balanced'.
 *
 * Edge cases:
 *   • Both counts 0 → 'balanced' with index 50 (no signal).
 *   • Only buy posts → index 100, buyer_market (everyone wants to buy,
 *     no-one wants to sell → extreme demand).
 *   • Only sell posts → index 0, seller_market (everyone wants to sell,
 *     no-one wants to buy → extreme oversupply).
 *
 * The function reads ONLY counts (already aggregated by the caller), so
 * it is O(1) and side-effect free. The description string is human-
 * readable, ready for the gauge's caption.
 */
export function calculateSupplyDemandIndex(
  buyPosts: number,
  sellPosts: number,
): SupplyDemandResult {
  const buy = Math.max(0, Math.floor(buyPosts || 0));
  const sell = Math.max(0, Math.floor(sellPosts || 0));
  const total = buy + sell;

  let index: number;
  if (total === 0) {
    index = 50;
  } else {
    index = Math.round((buy / total) * 100);
  }

  let balance: SupplyDemandResult["balance"];
  let description: string;
  if (index > 55) {
    balance = "buyer_market";
    description = `Demand exceeds supply (${buy} buy vs ${sell} sell listings) — sellers can hold out for higher prices.`;
  } else if (index < 45) {
    balance = "seller_market";
    description = `Supply exceeds demand (${sell} sell vs ${buy} buy listings) — buyers have negotiating leverage.`;
  } else {
    balance = "balanced";
    description = `Market is balanced (${buy} buy vs ${sell} sell listings) — neither side has a clear advantage.`;
  }

  return { index, balance, description };
}

// ─── Top countries ─────────────────────────────────────────────────────

export interface TopCountry {
  country: string;
  count: number;
  percentage: number;
}

/**
 * Rank countries by post count for a given side of the market.
 *
 * Reads `delivery_country` from each post (ISO alpha-2 code, e.g. "RS").
 * Posts with no delivery_country are dropped — they cannot be ranked.
 *
 * `type` = 'buy'  → only count `post_type='buy'` listings (top importers).
 * `type` = 'sell' → only count `post_type='sell'` listings (top exporters).
 *
 * The `percentage` field is `count / total_count * 100`, rounded to 1
 * decimal. Total is computed AFTER dropping no-country rows so the
 * percentages sum to 100 across the returned list.
 *
 * Returns at most `limit` entries (default 10), sorted by count desc.
 */
export function calculateTopCountries(
  posts: any[],
  type: "buy" | "sell",
  limit: number = 10,
): TopCountry[] {
  if (!Array.isArray(posts)) return [];
  const counts = new Map<string, number>();
  let total = 0;
  for (const p of posts) {
    const post = (p ?? {}) as Record<string, any>;
    if (post.post_type !== type) continue;
    const cc = (post.delivery_country ?? "").toString().trim().toUpperCase();
    if (!cc) continue;
    counts.set(cc, (counts.get(cc) ?? 0) + 1);
    total++;
  }
  if (total === 0) return [];
  const arr: TopCountry[] = [];
  for (const [country, count] of counts) {
    arr.push({
      country,
      count,
      percentage: Math.round((count / total) * 1000) / 10,
    });
  }
  arr.sort((a, b) => b.count - a.count);
  return arr.slice(0, Math.max(1, Math.min(50, limit)));
}

// ─── Heatmap ───────────────────────────────────────────────────────────

export interface HeatmapPoint {
  country: string;
  lat: number;
  lng: number;
  intensity: number; // 0–100
  postCount: number;
}

// Approximate centroid coordinates for the major trading countries. The
// values are picked so the bubble lands roughly on the country's land
// mass — sufficient for a marketing-grade heatmap. Countries missing
// from this table fall back to the geocode service at render time (or
// are dropped if the geocode fails). The list is intentionally short —
// it covers >90% of the marketplace's actual post traffic in pilot.
const COUNTRY_COORDS: Record<string, { lat: number; lng: number }> = {
  RS: { lat: 44.0, lng: 21.0 },
  US: { lat: 39.5, lng: -98.0 },
  CN: { lat: 35.0, lng: 105.0 },
  IN: { lat: 22.0, lng: 79.0 },
  DE: { lat: 51.0, lng: 10.0 },
  NL: { lat: 52.0, lng: 5.5 },
  AE: { lat: 24.0, lng: 54.0 },
  SA: { lat: 24.0, lng: 45.0 },
  TR: { lat: 39.0, lng: 35.0 },
  RU: { lat: 61.0, lng: 90.0 },
  BR: { lat: -10.0, lng: -55.0 },
  AR: { lat: -34.0, lng: -64.0 },
  AU: { lat: -25.0, lng: 133.0 },
  ZA: { lat: -29.0, lng: 24.0 },
  EG: { lat: 26.0, lng: 30.0 },
  NG: { lat: 9.0, lng: 8.0 },
  KE: { lat: 0.5, lng: 38.0 },
  TH: { lat: 15.0, lng: 101.0 },
  VN: { lat: 14.0, lng: 108.0 },
  ID: { lat: -2.0, lng: 118.0 },
  MY: { lat: 4.0, lng: 102.0 },
  SG: { lat: 1.3, lng: 103.8 },
  PK: { lat: 30.0, lng: 70.0 },
  BD: { lat: 24.0, lng: 90.0 },
  FR: { lat: 46.0, lng: 2.0 },
  GB: { lat: 54.0, lng: -2.0 },
  IT: { lat: 42.0, lng: 12.0 },
  ES: { lat: 40.0, lng: -3.7 },
  PL: { lat: 52.0, lng: 19.0 },
  UA: { lat: 49.0, lng: 32.0 },
  RO: { lat: 46.0, lng: 25.0 },
  HU: { lat: 47.0, lng: 19.0 },
  GR: { lat: 39.0, lng: 22.0 },
  HR: { lat: 45.0, lng: 15.5 },
  SI: { lat: 46.1, lng: 14.8 },
  BA: { lat: 44.0, lng: 18.0 },
  ME: { lat: 42.5, lng: 19.4 },
  MK: { lat: 41.6, lng: 21.7 },
  AL: { lat: 41.0, lng: 20.0 },
  CA: { lat: 60.0, lng: -100.0 },
  MX: { lat: 23.0, lng: -102.0 },
  JP: { lat: 36.0, lng: 138.0 },
  KR: { lat: 36.5, lng: 127.8 },
  CH: { lat: 47.0, lng: 8.0 },
  AT: { lat: 47.5, lng: 14.5 },
  BE: { lat: 50.6, lng: 4.6 },
  CZ: { lat: 49.8, lng: 15.5 },
  SE: { lat: 62.0, lng: 15.0 },
  NO: { lat: 62.0, lng: 10.0 },
  FI: { lat: 64.0, lng: 26.0 },
  DK: { lat: 56.0, lng: 9.5 },
  PT: { lat: 39.5, lng: -8.0 },
  IE: { lat: 53.4, lng: -8.0 },
  IQ: { lat: 33.0, lng: 44.0 },
  IR: { lat: 32.0, lng: 53.0 },
  QA: { lat: 25.3, lng: 51.2 },
  KW: { lat: 29.3, lng: 47.6 },
  OM: { lat: 21.5, lng: 55.9 },
  JO: { lat: 31.0, lng: 36.0 },
  IL: { lat: 31.5, lng: 34.8 },
  MA: { lat: 32.0, lng: -6.0 },
  DZ: { lat: 28.0, lng: 2.6 },
  TN: { lat: 34.0, lng: 9.0 },
  GH: { lat: 8.0, lng: -1.2 },
  CI: { lat: 7.5, lng: -5.5 },
  ET: { lat: 9.0, lng: 40.0 },
  TZ: { lat: -6.0, lng: 35.0 },
  UY: { lat: -32.5, lng: -55.8 },
  PY: { lat: -23.4, lng: -58.4 },
  CL: { lat: -30.0, lng: -71.0 },
  CO: { lat: 4.0, lng: -72.0 },
  PE: { lat: -9.0, lng: -75.0 },
  EC: { lat: -1.8, lng: -77.7 },
  NZ: { lat: -42.0, lng: 174.0 },
  PH: { lat: 12.9, lng: 121.6 },
};

/**
 * Generate geographic heatmap data from posts.
 *
 * Aggregates post counts per `delivery_country` (ISO alpha-2), looks up
 * the centroid coordinates in `COUNTRY_COORDS`, and computes an
 * `intensity` (0–100) proportional to the country's post count relative
 * to the busiest country.
 *
 *   intensity = round((count / maxCount) * 100)
 *
 * Posts whose country is not in the coordinate table are dropped — the
 * UI cannot place them on a world map without coordinates. The caller
 * can optionally fall back to a geocoding service (see
 * src/lib/logistics/geocoding.ts) but the dashboard uses the static
 * table for instant rendering.
 *
 * Filters: pass `postType='buy'` or `postType='sell'` to restrict to one
 * side of the market. By default, all post types are counted.
 */
export function generateHeatmapData(
  posts: any[],
  postType?: "buy" | "sell",
): HeatmapPoint[] {
  if (!Array.isArray(posts)) return [];
  const counts = new Map<string, number>();
  for (const p of posts) {
    const post = (p ?? {}) as Record<string, any>;
    if (postType && post.post_type !== postType) continue;
    const cc = (post.delivery_country ?? "").toString().trim().toUpperCase();
    if (!cc) continue;
    counts.set(cc, (counts.get(cc) ?? 0) + 1);
  }
  if (counts.size === 0) return [];
  const max = Math.max(...counts.values());
  if (max <= 0) return [];
  const out: HeatmapPoint[] = [];
  for (const [country, count] of counts) {
    const coords = COUNTRY_COORDS[country];
    if (!coords) continue; // unknown country — drop rather than misrender
    out.push({
      country,
      lat: coords.lat,
      lng: coords.lng,
      postCount: count,
      intensity: Math.round((count / max) * 100),
    });
  }
  out.sort((a, b) => b.postCount - a.postCount);
  return out;
}

// ─── Seasonal patterns ─────────────────────────────────────────────────

export interface SeasonalMonth {
  /** 1 (January) through 12 (December). */
  month: number;
  avgPrice: number;
  avgVolume: number;
  pattern: "high" | "medium" | "low";
}

/**
 * Compute the per-month seasonal pattern from historical data.
 *
 * `historicalData` is an array of rows with a `created_at` (ISO date)
 * and either `target_price` / `price_max` (for posts) or `unit_price`
 * (for responses). The function buckets rows by month-of-year, computes
 * the average price and the average volume (= number of samples in the
 * month bucket) per month, then classifies each month into "high",
 * "medium", or "low" based on its volume relative to the busiest month.
 *
 *   high   → volume ≥ 66% of the max-month's volume
 *   medium → 33% ≤ volume < 66%
 *   low    → volume < 33%
 *
 * The classification is volume-based rather than price-based because
 * price seasonality in a small sample is noisy. The caller can layer
 * the price chart on top to spot the actual seasonal price effect.
 *
 * Months with zero samples are returned with `avgPrice: 0`,
 * `avgVolume: 0`, `pattern: 'low'` so the chart shows a 12-point axis
 * regardless of data coverage.
 */
export function calculateSeasonalPattern(
  historicalData: any[],
  currency: string = "USD",
): SeasonalMonth[] {
  const cur = currency || "USD";
  const empty: SeasonalMonth[] = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    avgPrice: 0,
    avgVolume: 0,
    pattern: "low" as const,
  }));
  if (!Array.isArray(historicalData) || historicalData.length === 0) {
    return empty;
  }

  const buckets: Array<{ prices: number[]; count: number }> = Array.from(
    { length: 12 },
    () => ({ prices: [], count: 0 }),
  );

  for (const row of historicalData) {
    const r = (row ?? {}) as Record<string, any>;
    const iso = toIso(r.created_at);
    if (!iso) continue;

    // Price: prefer `unit_price` (responses — actual transacted prices)
    // → `target_price` (posts) → midpoint of `target_price` + `price_max`.
    const unitPrice = toNumber(r.unit_price);
    const target = toNumber(r.target_price);
    const max = toNumber(r.price_max);
    let price: number | null = unitPrice;
    if (price === null) {
      const priceType = r.price_type ?? "fixed";
      if (priceType === "range" && target !== null && max !== null) {
        price = (target + max) / 2;
      } else {
        price = target;
      }
    }
    if (price === null || price <= 0) continue;

    // Currency match — drop rows whose currency differs from the caller's
    // (same policy as the trend function: avoid FX mixing).
    const rowCurrency = (r.currency ?? cur) as string;
    if (rowCurrency && rowCurrency !== cur) continue;

    const month = new Date(iso).getMonth(); // 0–11
    if (month < 0 || month > 11) continue;
    buckets[month].prices.push(price);
    buckets[month].count++;
  }

  const maxVolume = Math.max(...buckets.map((b) => b.count));
  const out: SeasonalMonth[] = empty.map((m, i) => {
    const b = buckets[i];
    if (b.count === 0) return m;
    const avgPrice = round2(mean(b.prices));
    const avgVolume = b.count;
    let pattern: SeasonalMonth["pattern"] = "low";
    if (maxVolume > 0) {
      const ratio = b.count / maxVolume;
      if (ratio >= 0.66) pattern = "high";
      else if (ratio >= 0.33) pattern = "medium";
    }
    return { month: i + 1, avgPrice, avgVolume, pattern };
  });
  return out;
}

// ─── Benchmark (user vs market) ─────────────────────────────────────────

export interface UserStats {
  responseTimeHours: number;
  avgPrice: number;
  successRate: number; // 0–100
}

export interface MarketStats {
  responseTimeHours: number;
  avgPrice: number;
  successRate: number; // 0–100
}

export interface BenchmarkResult {
  responseTime: {
    user: number;
    market: number;
    /** 0–100 — the percentile of the user's response time vs the market
     *  (lower response time = higher percentile). */
    percentile: number;
  };
  priceCompetitiveness: {
    user: number;
    market: number;
    /** 'above' → user's avg price is higher than market (less competitive
     *  for sellers); 'below' → user's avg price is lower (more competitive
     *  for sellers); 'at' → within ±3% of the market. */
    position: "above" | "below" | "at";
  };
  successRate: {
    user: number;
    market: number;
    /** 0–100 — the percentile of the user's success rate vs the market
     *  (higher success rate = higher percentile). */
    percentile: number;
  };
}

/**
 * Benchmark a user's marketplace performance against market averages.
 *
 * The caller computes `userStats` and `marketStats` ahead of time (e.g.
 * the API route aggregates them from the marketplace_posts /
 * marketplace_responses tables). This function does the comparison math.
 *
 * Percentiles: the function only has two data points (user + market),
 * so the percentile is a SIMPLIFIED proxy:
 *   • Response time percentile: 100 - ((user - market) / market * 100),
 *     clamped to [0, 100]. A user faster than the market gets >50.
 *   • Success rate percentile: 50 + ((user - market) / market * 100),
 *     clamped to [0, 100]. A user above the market gets >50.
 *
 * These percentiles are NOT statistical percentiles (which would need
 * the full distribution) — they are directional indicators. The UI
 * surfaces them as "you're in the top X% of responders" but the
 * tooltip / disclosure notes the simplified model.
 */
export function benchmarkUser(
  userStats: UserStats,
  marketStats: MarketStats,
): BenchmarkResult {
  // Response time — lower is better.
  const userRt = clamp(toNumber(userStats.responseTimeHours) ?? 0, 0, 100000);
  const marketRt = clamp(toNumber(marketStats.responseTimeHours) ?? 0, 0, 100000);
  let rtPercentile = 50;
  if (marketRt > 0) {
    const diff = (marketRt - userRt) / marketRt; // positive → faster than market
    rtPercentile = Math.round(clamp(50 + diff * 50, 0, 100));
  } else {
    // No market baseline → user with 0 response time is "best".
    rtPercentile = userRt === 0 ? 90 : 50;
  }

  // Price competitiveness — lower is better (for sellers).
  const userPrice = clamp(toNumber(userStats.avgPrice) ?? 0, 0, 1e12);
  const marketPrice = clamp(toNumber(marketStats.avgPrice) ?? 0, 0, 1e12);
  let pricePosition: BenchmarkResult["priceCompetitiveness"]["position"] = "at";
  if (marketPrice > 0) {
    const pct = ((userPrice - marketPrice) / marketPrice) * 100;
    if (pct > 3) pricePosition = "above";
    else if (pct < -3) pricePosition = "below";
  }

  // Success rate — higher is better.
  const userSuccess = clamp(toNumber(userStats.successRate) ?? 0, 0, 100);
  const marketSuccess = clamp(toNumber(marketStats.successRate) ?? 0, 0, 100);
  let srPercentile = 50;
  if (marketSuccess > 0) {
    const diff = (userSuccess - marketSuccess) / marketSuccess;
    srPercentile = Math.round(clamp(50 + diff * 50, 0, 100));
  } else {
    srPercentile = userSuccess >= 80 ? 90 : 50;
  }

  return {
    responseTime: {
      user: round2(userRt),
      market: round2(marketRt),
      percentile: rtPercentile,
    },
    priceCompetitiveness: {
      user: round2(userPrice),
      market: round2(marketPrice),
      position: pricePosition,
    },
    successRate: {
      user: round2(userSuccess),
      market: round2(marketSuccess),
      percentile: srPercentile,
    },
  };
}
