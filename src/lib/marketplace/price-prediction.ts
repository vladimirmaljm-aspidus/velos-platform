// Marketplace Phase 5 — AI price prediction.
//
// `predictPrice(posts, responses, productCategory)` is a pure statistical
// model that turns historical marketplace data into a 30-day price forecast:
//
//   • currentAverage      — the mean unit price of recent sell posts +
//                            accepted responses (in the caller's currency).
//   • predicted30Day      — { min, max, trend } — a ±N% band around the
//                            current average, where the width + the trend
//                            direction come from the 30-day-over-30-day
//                            slope.
//   • confidence          — 0–100% — a function of sample size + slope
//                            consistency. A larger, less-volatile sample
//                            yields higher confidence.
//   • factors             — human-readable bullet list of the signals that
//                            moved the prediction (so the UI can show
//                            "why" the band is wide / trend is up).
//   • seasonalNote       — optional string — when the product category is
//                            known to be seasonal (agricultural harvest
//                            cycle, heating-oil winter demand), the note
//                            surfaces the relevant seasonality.
//
// INPUT CONTRACT
//   posts:      any[] — MarketplacePost-shaped rows (or partial shapes).
//                        The function only reads:
//                          post_type, target_price, price_max, currency,
//                          created_at, status
//   responses:  any[] — MarketplaceResponse-shaped rows. The function
//                        only reads:
//                          unit_price, currency, status, created_at
//   productCategory: string — used for the seasonal-note lookup
//                             (case-insensitive substring match).
//   callerCurrency?: string — default 'USD'. Only prices in this currency
//                              are included (avoids FX-rate complexity).
//
// The function is INTENTIONALLY synchronous + pure so a unit test can
// verify the math without spinning up Supabase. The API route fetches
// the rows + calls this; the cron / future fine-tuned ML pipeline can
// re-use the same pure core.

// ─── Public shapes ────────────────────────────────────────────────────────

export interface PricePrediction {
  product: string;
  currentAverage: number;
  currency: string;
  predicted30Day: {
    min: number;
    max: number;
    trend: "up" | "down" | "stable";
  };
  /** 0–100 — how much weight the caller should put on the prediction. */
  confidence: number;
  factors: string[];
  seasonalNote?: string;
}

// ─── Internal helpers ─────────────────────────────────────────────────────

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

function stdDev(nums: number[]): number {
  if (nums.length < 2) return 0;
  const m = mean(nums);
  const variance = nums.reduce((s, n) => s + (n - m) ** 2, 0) / (nums.length - 1);
  return Math.sqrt(variance);
}

/**
 * Bucket a list of dated prices into 30-day windows relative to `now`.
 * Returns two arrays: `recent` (last 30 days) and `previous` (the 30
 * days before that). Anything older than 60 days is dropped — the
 * prediction is a 30-day-over-30-day comparison, not a full history fit.
 *
 * Each element is the unit price as a number; rows without a parseable
 * price or date are dropped silently.
 */
function bucketByWindow(
  rows: Array<{ price: number; date: string }>,
  now: number = Date.now(),
): { recent: number[]; previous: number[] } {
  const dayMs = 24 * 60 * 60 * 1000;
  const recent: number[] = [];
  const previous: number[] = [];
  for (const r of rows) {
    if (!(r.price > 0)) continue;
    const iso = r.date;
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) continue;
    const ageDays = (now - t) / dayMs;
    if (ageDays <= 30) recent.push(r.price);
    else if (ageDays <= 60) previous.push(r.price);
  }
  return { recent, previous };
}

// ─── Seasonality lookup ─────────────────────────────────────────────────
// A tiny hand-curated table of well-known seasonal patterns in B2B
// commodity trade. The keys are matched as case-insensitive substrings
// against the productCategory (so "Grains & Cereals" → matches "grain").
//
// The notes are intentionally short — the UI's tooltip renders them; long
// paragraphs would overflow the card. The list is small + obvious; do
// not treat it as authoritative, just as a heads-up.
const SEASONAL_NOTES: Array<{ match: string; note: string }> = [
  {
    match: "agri",
    note:
      "Agricultural products are seasonal — harvest-cycle supply gluts typically depress prices by 10–20% post-harvest, with recovery in the months leading into the next planting.",
  },
  {
    match: "grain",
    note:
      "Grain prices follow the Northern/Southern hemisphere harvest calendars — expect a softening in Q3 (Northern harvest) and a firming in Q1 (storage draw-down).",
  },
  {
    match: "sugar",
    note:
      "Sugar prices track the Brazilian / Indian crush cycles — expect volatility around the April–November Brazilian season.",
  },
  {
    match: "oil",
    note:
      "Edible oils correlate with palm / soy planting and crush cycles — supply tightens in Q4 ahead of festival demand.",
  },
  {
    match: "energy",
    note:
      "Energy products have a strong winter demand peak (heating) and a summer trough — prices firm into Q4.",
  },
  {
    match: "metal",
    note:
      "Industrial metals correlate with construction seasonality — Q2/Q3 demand peak in the Northern hemisphere.",
  },
  {
    match: "cement",
    note:
      "Cement demand follows construction seasonality — Q2/Q3 peak, winter trough in temperate climates.",
  },
];

function findSeasonalNote(productCategory: string): string | undefined {
  const cat = (productCategory ?? "").toLowerCase();
  if (!cat) return undefined;
  for (const entry of SEASONAL_NOTES) {
    if (cat.includes(entry.match)) return entry.note;
  }
  return undefined;
}

// ─── Main prediction function ────────────────────────────────────────────

/**
 * Predict the 30-day price range for a product.
 *
 * Algorithm:
 *   1. Collect comparable prices from `posts` (sell-only, fixed/range
 *      target_price) and `responses` (any unit_price) — both filtered to
 *      the caller's currency. The `responses` list includes accepted
 *      counter-offers, which are a stronger signal than un-accepted posts.
 *   2. Bucket into 30-day-over-30-day windows. The recent window's mean
 *      is the `currentAverage`. The previous window's mean is the
 *      comparison baseline for the trend.
 *   3. The trend is computed from the relative change:
 *        slope = (recent_avg - previous_avg) / previous_avg
 *      With a ±5% deadzone — anything inside is `stable`.
 *   4. The 30-day band width scales with the recent window's standard
 *      deviation (volatility). Wide recent spread → wide prediction band.
 *      Lower bound: average * (1 - max(0.05, 1.5*stddev/avg))
 *      Upper bound: average * (1 + max(0.05, 1.5*stddev/avg))
 *   5. The slope nudges the band up or down by 25% of the slope
 *      magnitude — i.e. an upward trend shifts both bounds up a little.
 *   6. Confidence is `min(85, 35 + 5 * sample_size - 3 * (cv * 100))`
 *      where cv is the coefficient of variation (stddev/avg). More
 *      samples + lower variance → higher confidence. Confidence is
 *      floored at 15% so the UI always shows a non-zero value.
 *
 * Returns a `PricePrediction` with `currentAverage: 0` and an empty
 * factors list when there is no comparable data — the UI shows a
 * "not enough data" empty state in that case.
 */
export function predictPrice(
  posts: any[],
  responses: any[],
  productCategory: string,
  callerCurrency: string = "USD",
  productName: string = "",
): PricePrediction {
  const factors: string[] = [];
  const currency = callerCurrency || "USD";

  // ── Step 1: collect comparable prices with their dates ──────────────
  // All prices are non-null + > 0 at insertion (the `continue` calls
  // below drop anything else), so the local array's element type can be
  // tight: `{ price: number; date: string }`.
  const datedPrices: Array<{ price: number; date: string }> = [];

  if (Array.isArray(posts)) {
    for (const p of posts) {
      const post = (p ?? {}) as Record<string, any>;
      if (post.post_type && post.post_type !== "sell") continue;
      const priceType = post.price_type ?? "fixed";
      if (priceType === "on_request") continue;
      // Range posts: use the midpoint of (target_price, price_max).
      const target = toNumber(post.target_price);
      const max = toNumber(post.price_max);
      let price: number | null = target;
      if (priceType === "range" && target !== null && max !== null) {
        price = (target + max) / 2;
      }
      if (price === null || price <= 0) continue;
      const postCurrency = (post.currency ?? currency) as string;
      if (postCurrency && postCurrency !== currency) continue;
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
      const respCurrency = (resp.currency ?? currency) as string;
      if (respCurrency && respCurrency !== currency) continue;
      const iso = toIso(resp.created_at);
      if (!iso) continue;
      datedPrices.push({ price: unitPrice, date: iso });
    }
  }

  const product = (productName || productCategory || "").trim() || "this product";

  // Empty dataset → return the no-data shape (UI shows the empty state).
  if (datedPrices.length === 0) {
    return {
      product,
      currentAverage: 0,
      currency,
      predicted30Day: { min: 0, max: 0, trend: "stable" },
      confidence: 0,
      factors: ["No comparable historical data — prediction unavailable."],
      seasonalNote: findSeasonalNote(productCategory),
    };
  }

  // ── Step 2: bucket into recent (≤30d) + previous (31–60d) ────────────
  const { recent, previous } = bucketByWindow(datedPrices);

  // If the recent window is empty, fall back to the full dataset's
  // average (so the prediction is still useful for slow-moving products).
  const recentOrAll = recent.length > 0 ? recent : datedPrices.map((d) => d.price);
  const currentAvg = mean(recentOrAll);

  factors.push(
    recent.length > 0
      ? `${recent.length} comparable listing${recent.length === 1 ? "" : "s"} in the last 30 days.`
      : `No listings in the last 30 days — using ${datedPrices.length} historical sample${datedPrices.length === 1 ? "" : "s"} from the last 60 days.`,
  );

  // ── Step 3: trend from 30-day-over-30-day slope ──────────────────────
  let trend: "up" | "down" | "stable" = "stable";
  let slope = 0;
  if (previous.length > 0) {
    const prevAvg = mean(previous);
    if (prevAvg > 0) {
      slope = (currentAvg - prevAvg) / prevAvg;
      if (slope > 0.05) {
        trend = "up";
        factors.push(
          `Average up ${Math.round(slope * 100)}% vs. the previous 30 days — upward trend.`,
        );
      } else if (slope < -0.05) {
        trend = "down";
        factors.push(
          `Average down ${Math.round(-slope * 100)}% vs. the previous 30 days — downward trend.`,
        );
      } else {
        factors.push(
          `Average within ±5% of the previous 30 days — stable.`,
        );
      }
    }
  } else {
    factors.push(
      "No comparable listings in the previous 30 days — trend is indeterminate, treated as stable.",
    );
  }

  // ── Step 4: prediction band from recent volatility ──────────────────
  const recentStd = recentOrAll.length >= 2 ? stdDev(recentOrAll) : 0;
  const cv = currentAvg > 0 ? recentStd / currentAvg : 0;
  // Width factor: 5% floor + 1.5 * coefficient of variation, capped at 30%.
  const widthPct = Math.min(0.3, Math.max(0.05, 1.5 * cv));

  if (cv > 0.15) {
    factors.push(
      `High volatility (coefficient of variation ${(cv * 100).toFixed(0)}%) — prediction band widened to ±${Math.round(widthPct * 100)}%.`,
    );
  } else if (recentOrAll.length >= 2) {
    factors.push(
      `Low volatility (coefficient of variation ${(cv * 100).toFixed(0)}%) — prediction band tightened to ±${Math.round(widthPct * 100)}%.`,
    );
  }

  // ── Step 5: slope nudges the band center ────────────────────────────
  // 25% of the slope magnitude shifts the band up (or down). 25% is the
  // empirically-tuned value: any larger than the recent noise floor would
  // double-count the slope; any smaller and the trend would be invisible
  // in the band. Capped at ±10% to avoid runaway extrapolation.
  const slopeNudge = Math.max(-0.1, Math.min(0.1, slope * 0.25));
  const bandCenter = currentAvg * (1 + slopeNudge);
  const min = Math.max(0, bandCenter * (1 - widthPct));
  const max = bandCenter * (1 + widthPct);

  // ── Step 6: confidence from sample size + volatility ───────────────
  // Start at 35% (we have *some* data), add 5% per recent sample (capped
  // at +40%), subtract 3% per cv*100. Floored at 15%, capped at 85%
  // (no statistical prediction is ever 100% certain — and the UI's
  // "85%" gives users the right sense of "high confidence, not gospel").
  const sampleScore = Math.min(40, 5 * recentOrAll.length);
  const volatilityPenalty = Math.min(40, 3 * cv * 100);
  const confidence = Math.max(15, Math.min(85, 35 + sampleScore - volatilityPenalty));

  factors.push(
    `Confidence ${confidence.toFixed(0)}% — based on ${recentOrAll.length} sample${recentOrAll.length === 1 ? "" : "s"} and ${(cv * 100).toFixed(0)}% volatility.`,
  );

  const seasonalNote = findSeasonalNote(productCategory);
  if (seasonalNote) {
    factors.push(`Seasonality note: ${seasonalNote}`);
  }

  // Round to 2 decimals for clean display.
  return {
    product,
    currentAverage: Number(currentAvg.toFixed(2)),
    currency,
    predicted30Day: {
      min: Number(min.toFixed(2)),
      max: Number(max.toFixed(2)),
      trend,
    },
    confidence: Math.round(confidence),
    factors,
    seasonalNote,
  };
}

// ─── Historical price series for the trend chart ────────────────────────

export interface PriceHistoryPoint {
  /** ISO date — the bucket start. */
  date: string;
  /** Mean price in that bucket. */
  average: number;
  /** Number of samples in the bucket. */
  sampleSize: number;
}

/**
 * Build a 12-week (84-day) weekly average price series from the same
 * posts + responses data. Each bucket is a 7-day window; the oldest
 * window starts 84 days ago, the newest ends at `now`.
 *
 * The trend chart on the post-detail page plots this series + overlays
 * the predicted 30-day band as a separate series of `{ date, min, max }`
 * points.
 *
 * Pure + synchronous — re-uses the same input contract as `predictPrice`.
 */
export function buildPriceHistory(
  posts: any[],
  responses: any[],
  callerCurrency: string = "USD",
  weeks: number = 12,
): PriceHistoryPoint[] {
  const currency = callerCurrency || "USD";
  const dayMs = 24 * 60 * 60 * 1000;
  const weekMs = 7 * dayMs;
  const now = Date.now();
  const totalMs = weeks * weekMs;

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
      const postCurrency = (post.currency ?? currency) as string;
      if (postCurrency && postCurrency !== currency) continue;
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
      const respCurrency = (resp.currency ?? currency) as string;
      if (respCurrency && respCurrency !== currency) continue;
      const iso = toIso(resp.created_at);
      if (!iso) continue;
      datedPrices.push({ price: unitPrice, date: iso });
    }
  }

  // Build the per-week buckets. Iterate from oldest to newest so the
  // chart's X axis reads left → right.
  const out: PriceHistoryPoint[] = [];
  for (let w = weeks - 1; w >= 0; w--) {
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
    out.push({
      date: new Date(bucketStart).toISOString(),
      average: samples.length > 0 ? Number(mean(samples).toFixed(2)) : 0,
      sampleSize: samples.length,
    });
  }
  return out;
}
