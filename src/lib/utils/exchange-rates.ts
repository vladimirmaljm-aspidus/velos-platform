/**
 * Live currency exchange rates.
 *
 * Primary source: open.er-api.com (free, no API key, ~160 currencies).
 * - 1-hour in-memory cache per pair.
 * - `getExchangeRate(from, to)` returns a single pair rate.
 * - `getRateMap(base)` returns the full rate map (all quotes) for a base
 *   currency, so the client can convert many currencies in one shot.
 *
 * The free open.er-api.com endpoint is reachable from the sandbox and prod.
 *
 * P1 stale-fallback fix (task C-5 Fix 5): previously, when the live rate
 * fetch failed, `getRateMap` returned a hardcoded `FALLBACK_USD` table
 * (USD:1, EUR:0.92, JPY:149, …) that was frozen at whatever values were
 * committed to source control. FX rates move daily; a hardcoded table is
 * always stale by definition and silently produces wrong totals in the
 * trade calculator (the only place that consumes `getRateMap`). We now
 * keep a persistent "last known good" cache of the most recent successful
 * rate map per base currency, and:
 *
 *   1. If the live fetch succeeds, we cache the result (with timestamp).
 *   2. If the live fetch fails, we serve the cached result IF it is less
 *      than 24 hours old (clearly marked `source: "open.er-api.com
 *      (stale fallback)"` so the UI can warn the user).
 *   3. If the cache is older than 24h OR has never been populated (cold
 *      start + first call fails), we throw — the caller's catch block
 *      surfaces a 502 to the client rather than silently returning
 *      years-stale numbers.
 */

const cache = new Map<string, { rate: number; expiresAt: number }>();
const mapCache = new Map<string, { rates: Record<string, number>; fetchedAt: number }>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour — primary cache, hot path

/**
 * Persistent "last known good" cache for the stale-fallback path. Survives
 * across requests (in-process) but is NOT shared across replicas. Each
 * replica maintains its own; that's fine for staleness — the worst case is
 * that two replicas serve slightly different stale rates during an upstream
 * outage, which is acceptable for a trade-calculator preview.
 *
 * Keyed by base currency. The `fetchedAt` timestamp is when the live API
 * returned the rate, NOT when this cache entry was created.
 */
const lastGoodMap = new Map<string, { rates: Record<string, number>; fetchedAt: number }>();

/**
 * Maximum age (in ms) of a "last known good" rate map before we refuse to
 * serve it as a stale fallback. 24 hours matches the ECB daily fix cycle —
 * longer than that and the rate is more likely to mislead than to inform.
 */
const STALE_FALLBACK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type RateMapResult = {
  base: string;
  rates: Record<string, number>;
  fetchedAt: string;
  source: string;
};

/**
 * Returns a single pair rate (from → to). Returns 1 when from === to.
 * Returns null on failure (callers should fall back to 1 to avoid crashing).
 */
export async function getExchangeRate(from: string, to: string): Promise<number | null> {
  if (!from || !to) return null;
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return 1;

  const cacheKey = `${f}-${t}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.rate;
  }

  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${f}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const rate = data.rates?.[t];
    if (typeof rate !== "number" || !isFinite(rate) || rate <= 0) return null;
    cache.set(cacheKey, { rate, expiresAt: Date.now() + CACHE_TTL });
    // Also cache the inverse so we don't double-fetch.
    cache.set(`${t}-${f}`, { rate: 1 / rate, expiresAt: Date.now() + CACHE_TTL });
    return rate as number;
  } catch (e) {
    console.warn("[exchange-rates] lookup failed:", e);
    return null;
  }
}

/**
 * Returns the full rate map for a base currency.
 * `rates[X]` means "1 base = rates[X] X".
 * Used by the trade calculator UI to convert all cost lines + show a live
 * "View totals in <currency>" preview without re-fetching per pair.
 *
 * Throws when the live fetch fails AND no usable cached rate map exists
 * (cold start, or cache older than 24h). The HTTP route handler catches
 * and returns 502 — see `src/app/api/exchange-rates/route.ts`.
 */
export async function getRateMap(base: string): Promise<RateMapResult> {
  const b = (base || "USD").toUpperCase();
  const cached = mapCache.get(b);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return {
      base: b,
      rates: cached.rates,
      fetchedAt: new Date(cached.fetchedAt).toISOString(),
      source: "open.er-api.com (cached)",
    };
  }

  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${b}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data?.result !== "success" || !data?.rates) throw new Error("bad response");
    const rates = data.rates as Record<string, number>;
    // Sanity: drop non-finite / non-positive entries.
    for (const k of Object.keys(rates)) {
      const v = rates[k];
      if (typeof v !== "number" || !isFinite(v) || v <= 0) delete rates[k];
    }
    rates[b] = 1;
    const fetchedAt = Date.now();
    // Update both caches: the hot 1h cache (for the success path) and the
    // persistent last-known-good cache (for the stale-fallback path).
    mapCache.set(b, { rates, fetchedAt });
    lastGoodMap.set(b, { rates: { ...rates }, fetchedAt });
    return {
      base: b,
      rates,
      fetchedAt: new Date(fetchedAt).toISOString(),
      source: "open.er-api.com",
    };
  } catch (e) {
    console.warn("[exchange-rates] getRateMap failed:", e);

    // P1 stale-fallback fix (task C-5 Fix 5): serve the last known good
    // rate map if it's less than 24h old. Older than that, or never
    // cached at all, and we throw — the route handler returns 502 so the
    // UI can show "rates unavailable" rather than silently rendering
    // wrong totals based on a frozen hardcoded table.
    const lastGood = lastGoodMap.get(b);
    if (lastGood) {
      const ageMs = Date.now() - lastGood.fetchedAt;
      if (ageMs < STALE_FALLBACK_MAX_AGE_MS) {
        const ageHours = Math.round(ageMs / (60 * 60 * 1000));
        return {
          base: b,
          rates: { ...lastGood.rates },
          fetchedAt: new Date(lastGood.fetchedAt).toISOString(),
          source: `open.er-api.com (stale fallback, ${ageHours}h old)`,
        };
      }
      // Cache exists but is too stale — fall through to throw.
      throw new Error(
        `Exchange rate provider is unavailable and the last known good rate for ${b} ` +
        `is older than 24h (fetched ${new Date(lastGood.fetchedAt).toISOString()}). ` +
        `Refusing to serve potentially misleading rates.`,
      );
    }

    // No cache at all (cold start + first call failed) — surface the error.
    throw new Error(
      `Exchange rate provider is unavailable and no cached rate exists for ${b}. ` +
      `Original error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Synchronous pair lookup against an already-fetched rate map.
 * Returns the rate to convert `amount` from `from` to `to`.
 * `rates` is a map keyed by quote currency, with base = `baseCurrency`.
 */
export function convertViaMap(
  amount: number,
  from: string,
  to: string,
  rates: Record<string, number>,
  baseCurrency: string,
): number {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return amount;
  // rates[X] = 1 base → X. So 1 from = (rates[from] / rates[to]) to.
  const fromRate = rates[f];
  const toRate = rates[t];
  if (!fromRate || !toRate) return amount;
  return amount * (toRate / fromRate);
}

export const SUPPORTED_CURRENCIES = [
  "USD", "EUR", "GBP", "CHF", "AED", "SAR", "CNY", "INR", "RUB",
  "JPY", "TRY", "BRL", "ZAR", "SGD", "HKD", "AUD", "CAD", "RSD",
  "EGP", "KRW", "MXN", "MYR", "THB", "IDR", "PHP", "NZD", "SEK",
  "NOK", "DKK", "PLN", "CZK", "HUF", "RON", "BGN", "ILS",
];
