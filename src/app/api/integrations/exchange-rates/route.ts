import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";

export const runtime = "nodejs";

let cache: { data: any; fetchedAt: number } | null = null;
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours — rates don't change that often

/**
 * GET /api/integrations/exchange-rates?from=USD&to=EUR&amount=100
 *
 * Fetches exchange rates from ExchangeRate-API (https://www.exchangerate-api.com).
 * Free tier: 1,500 requests/month, no credit card required.
 *
 * Requires EXCHANGERATE_API_KEY environment variable (or tenant setting).
 *
 * If no API key is configured, falls back to Frankfurter API (ECB rates,
 * completely free, no key needed, but only covers ~30 currencies).
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (integrations.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "integrations.read"); if (_d) return _d; } /* requirePermission wired */


  const url = new URL(req.url);
  const from = url.searchParams.get("from") || "USD";
  const to = url.searchParams.get("to") || "USD";
  const amount = parseFloat(url.searchParams.get("amount") || "1");

  // Check for API key in env or tenant settings
  const store = await getStore();
  const integrationSettings = await store.getSetting<any>("integrations");
  const apiKey = process.env.EXCHANGERATE_API_KEY || integrationSettings?.exchangerate_api_key;

  // If same currency, return 1:1
  if (from === to) {
    return NextResponse.json({ from, to, rate: 1, amount, converted: amount, source: "same" });
  }

  // Try ExchangeRate-API first (if key configured)
  if (apiKey) {
    try {
      // Use the pair conversion endpoint for accuracy
      const res = await fetch(
        `https://v6.exchangerate-api.com/v6/${apiKey}/pair/${from}/${to}/${amount}`,
        { signal: AbortSignal.timeout(10_000) }
      );

      if (res.ok) {
        const data = await res.json();
        if (data.result === "success") {
          return NextResponse.json({
            from,
            to,
            rate: data.conversion_rate,
            amount,
            converted: data.conversion_result,
            source: "exchangerate-api",
            cached: false,
            rateDate: data.time_last_update_utc || new Date().toISOString(),
            rateTime: "Live rate (real-time)",
          });
        }
      }
    } catch {
      // Fall through to Frankfurter
    }
  }

  // Fallback: Frankfurter API (free, no key, ECB rates)
  try {
    // Check cache for the pair
    const cacheKey = `${from}_${to}`;
    if (cache && cache.data?.[cacheKey] && Date.now() - cache.fetchedAt < CACHE_TTL) {
      const rate = cache.data[cacheKey];
      return NextResponse.json({
        from,
        to,
        rate,
        amount,
        converted: amount * rate,
        source: "frankfurter-ecb",
        cached: true,
        rateDate: cache.data?.date || new Date().toISOString(),
        rateTime: "ECB reference rate (updated daily at 16:00 CET)",
      });
    }

    const res = await fetch(
      `https://api.frankfurter.app/latest?from=${from}&to=${to}`,
      { signal: AbortSignal.timeout(10_000) }
    );

    if (!res.ok) {
      return NextResponse.json({ error: "Failed to fetch exchange rate" }, { status: 502 });
    }

    const data = await res.json();
    const rate = data.rates?.[to];

    if (!rate) {
      return NextResponse.json({ error: `Cannot convert ${from} to ${to}` }, { status: 400 });
    }

    // Cache the rate
    if (!cache) cache = { data: {}, fetchedAt: Date.now() };
    cache.data[cacheKey] = rate;
    cache.fetchedAt = Date.now();

    return NextResponse.json({
      from,
      to,
      rate,
      amount,
      converted: amount * rate,
      source: "frankfurter-ecb",
      cached: false,
      rateDate: data.date || new Date().toISOString(),
      rateTime: "ECB reference rate (updated daily at 16:00 CET)",
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
