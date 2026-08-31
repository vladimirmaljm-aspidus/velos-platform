import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKey, sanitizeError } from "@/lib/api/helpers";
import { getRateMap } from "@/lib/utils/exchange-rates";

export const runtime = "nodejs";

/**
 * GET /api/exchange-rates?base=USD
 *
 * Returns the live exchange-rate map for a base currency:
 *   { base: "USD", rates: { EUR: 0.92, AED: 3.67, ... }, fetchedAt, source }
 *
 * Used by the Trade Calculator UI to:
 *  - auto-populate per-line FX rates (currency → buy_currency)
 *  - convert the live "View totals in <currency>" preview
 *
 * Auth: any logged-in user or API key. No special permission needed — rates
 * are public reference data. Cached 1h server-side to avoid rate limits.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuthOrApiKey(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const url = new URL(req.url);
    const base = (url.searchParams.get("base") || "USD").toUpperCase();
    const result = await getRateMap(base);
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json(
      { error: sanitizeError(e)},
      { status: 502 },
    );
  }
}
