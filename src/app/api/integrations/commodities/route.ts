import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";

export const runtime = "nodejs";

/**
 * GET /api/integrations/commodities?symbol=CORN
 *
 * Fetches commodity futures prices from Alpha Vantage.
 * API key: provided by admin (stored in settings or env).
 *
 * Available symbols:
 *   WTI  — WTI Crude Oil
 *   BRENT — Brent Crude Oil
 *   NATURAL_GAS — Natural Gas
 *   COPPER — Copper
 *   ALUMINUM — Aluminum
 *   WHEAT — Wheat
 *   CORN — Corn
 *   COTTON — Cotton
 *   SUGAR — Sugar
 *   COFFEE — Coffee
 *   COCOA — Cocoa (not directly available — use All Commodities)
 *
 * Free tier: 25 requests/day (750/month)
 * Data is cached for 12 hours to conserve API calls.
 */

let cache: Record<string, { data: any; fetchedAt: number }> = {};
const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours

const SYMBOL_LABELS: Record<string, string> = {
  WTI: "WTI Crude Oil (USD/barrel)",
  BRENT: "Brent Crude Oil (USD/barrel)",
  NATURAL_GAS: "Natural Gas (USD/MMBtu)",
  COPPER: "Copper (USD/lb)",
  ALUMINUM: "Aluminum (USD/MT)",
  WHEAT: "Wheat (USD/bushel)",
  CORN: "Corn (USD/bushel)",
  COTTON: "Cotton (USD/lb)",
  SUGAR: "Sugar (USD/lb)",
  COFFEE: "Coffee (USD/lb)",
};

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (integrations.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "integrations.read"); if (_d) return _d; } /* requirePermission wired */


  const url = new URL(req.url);
  const symbol = url.searchParams.get("symbol") || "ALL";

  // Get API key from settings or env
  const store = await getStore();
  const integrationSettings = await store.getSetting<any>("integrations");
  const apiKey = process.env.ALPHAVANTAGE_API_KEY || integrationSettings?.alphavantage_api_key;

  if (!apiKey) {
    return NextResponse.json({
      error: "Alpha Vantage API key is not configured. Go to Settings → API Integrations to set it up.",
    }, { status: 200 });
  }

  // If ALL, fetch all symbols (but check cache first)
  if (symbol === "ALL") {
    const results: any[] = [];

    for (const [sym, label] of Object.entries(SYMBOL_LABELS)) {
      const cached = cache[sym];
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
        results.push({ symbol: sym, label, ...cached.data, cached: true });
      }
      // If not cached, we'll skip it in this batch to conserve API calls
      // (fetching all 10 at once would burn 10 of the 25 daily calls)
    }

    // If nothing is cached, fetch the most important ones
    if (results.length === 0) {
      const important = ["SUGAR", "COFFEE", "CORN", "WHEAT", "COPPER"];
      for (const sym of important) {
        try {
          const data = await fetchCommodity(sym, apiKey);
          if (data) {
            results.push({ symbol: sym, label: SYMBOL_LABELS[sym], ...data, cached: false });
          }
        } catch {}
      }
    }

    return NextResponse.json({ items: results });
  }

  // Single symbol
  const cached = cache[symbol];
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return NextResponse.json({
      symbol,
      label: SYMBOL_LABELS[symbol] || symbol,
      ...cached.data,
      cached: true,
    });
  }

  try {
    const data = await fetchCommodity(symbol, apiKey);
    if (!data) {
      return NextResponse.json({ error: `Failed to fetch ${symbol}` }, { status: 502 });
    }

    cache[symbol] = { data, fetchedAt: Date.now() };

    return NextResponse.json({
      symbol,
      label: SYMBOL_LABELS[symbol] || symbol,
      ...data,
      cached: false,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}

async function fetchCommodity(symbol: string, apiKey: string) {
  const res = await fetch(
    `https://www.alphavantage.co/query?function=${symbol}&interval=monthly&apikey=${apiKey}`,
    { signal: AbortSignal.timeout(15_000) }
  );

  if (!res.ok) return null;

  const data = await res.json();

  // Alpha Vantage returns different formats per commodity
  // Most return a "data" array with monthly entries
  const entries = data.data || [];
  if (entries.length === 0) return null;

  const latest = entries[0]; // Most recent month
  const previous = entries[1]; // Previous month

  const price = parseFloat(latest.value || latest["WTI"] || latest["BRENT"] || "0");
  const prevPrice = previous ? parseFloat(previous.value || previous["WTI"] || previous["BRENT"] || "0") : 0;
  const change = prevPrice > 0 ? price - prevPrice : 0;
  const changePct = prevPrice > 0 ? ((price - prevPrice) / prevPrice) * 100 : 0;

  return {
    price,
    currency: "USD",
    date: latest.date || "",
    change,
    changePct: Math.round(changePct * 100) / 100,
    interval: latest.interval || "Monthly",
  };
}
