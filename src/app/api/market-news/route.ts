/**
 * API Route — World Market News
 * Serves REAL commodity prices and currency rates from our API integrations.
 * No hardcoded/fake data — everything comes from live or cached sources.
 *
 * Sources:
 *   - Commodity prices: Alpha Vantage API (cached 12h)
 *   - Currency rates: Frankfurter ECB API (cached 6h)
 *   - Articles: removed (no free news API available without key)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";

export const runtime = "nodejs";

let commodityCache: { data: any[]; fetchedAt: number } | null = null;
let currencyCache: { data: any[]; fetchedAt: number } | null = null;
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

const COMMODITY_SYMBOLS = [
  { symbol: "SUGAR", name: "Sugar", unit: "USD/lb" },
  { symbol: "COFFEE", name: "Coffee", unit: "USD/lb" },
  { symbol: "CORN", name: "Corn", unit: "USD/bushel" },
  { symbol: "WHEAT", name: "Wheat", unit: "USD/bushel" },
  { symbol: "COTTON", name: "Cotton", unit: "USD/lb" },
  { symbol: "COPPER", name: "Copper", unit: "USD/lb" },
];

const CURRENCY_PAIRS = [
  { from: "USD", to: "EUR" },
  { from: "USD", to: "GBP" },
  { from: "USD", to: "CNY" },
  { from: "USD", to: "JPY" },
  { from: "EUR", to: "GBP" },
  { from: "EUR", to: "CHF" },
];

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (dashboard.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "dashboard.read"); if (_d) return _d; } /* requirePermission wired */


  try {
    // ── Fetch commodity prices from Alpha Vantage ──────────────────────
    let commodities: any[] = [];

    // Check cache first
    if (commodityCache && Date.now() - commodityCache.fetchedAt < CACHE_TTL) {
      commodities = commodityCache.data;
    } else {
      const store = await getStore();
      const integrationSettings = await store.getSetting<any>("integrations");
      const apiKey = process.env.ALPHAVANTAGE_API_KEY || integrationSettings?.alphavantage_api_key;

      if (apiKey) {
        // Fetch commodities (limit to 3 per request to conserve API calls)
        for (const c of COMMODITY_SYMBOLS.slice(0, 3)) {
          try {
            const res = await fetch(
              `https://www.alphavantage.co/query?function=${c.symbol}&interval=monthly&apikey=${apiKey}`,
              { signal: AbortSignal.timeout(10_000) }
            );
            if (res.ok) {
              const data = await res.json();
              const entries = data.data || [];
              if (entries.length > 0) {
                const latest = entries[0];
                const prev = entries[1];
                const price = parseFloat(latest.value || "0");
                const prevPrice = prev ? parseFloat(prev.value || "0") : 0;
                const change = prevPrice > 0 ? price - prevPrice : 0;
                const changePct = prevPrice > 0 ? ((price - prevPrice) / prevPrice) * 100 : 0;
                commodities.push({
                  name: c.name,
                  price: Math.round(price * 100) / 100,
                  unit: c.unit,
                  change: Math.round(changePct * 100) / 100,
                  trend: change >= 0 ? "up" : "down",
                  date: latest.date || "",
                  source: "Alpha Vantage",
                });
              }
            }
          } catch { /* skip on error */ }
        }
        commodityCache = { data: commodities, fetchedAt: Date.now() };
      }
    }

    // ── Fetch currency rates from Frankfurter (ECB) ────────────────────
    let currencies: any[] = [];

    if (currencyCache && Date.now() - currencyCache.fetchedAt < CACHE_TTL) {
      currencies = currencyCache.data;
    } else {
      for (const pair of CURRENCY_PAIRS) {
        try {
          const res = await fetch(
            `https://api.frankfurter.app/latest?from=${pair.from}&to=${pair.to}`,
            { signal: AbortSignal.timeout(8_000) }
          );
          if (res.ok) {
            const data = await res.json();
            const rate = data.rates?.[pair.to];
            if (rate) {
              currencies.push({
                from: pair.from,
                to: pair.to,
                rate: Math.round(rate * 10000) / 10000,
                date: data.date || "",
                source: "ECB (Frankfurter)",
              });
            }
          }
        } catch { /* skip on error */ }
      }
      currencyCache = { data: currencies, fetchedAt: Date.now() };
    }

    return NextResponse.json({
      commodities,
      currencies,
      lastUpdated: new Date().toISOString(),
      source: "live-integrations",
    });
  } catch (error: any) {
    console.error("[market-news] Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch market data." },
      { status: 500 }
    );
  }
}
