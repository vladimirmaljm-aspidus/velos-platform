// DEPRECATED: This route has no active UI consumers. Kept for potential future use.
// If you're building a new feature, consider whether this integration is still needed.
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";

export const runtime = "nodejs";

/**
 * GET /api/integrations/comtrade?reporter=RS&partner=AE&hsCode=1801&year=2023
 *
 * Fetches international trade data from UN Comtrade API.
 * Free tier: 500 requests/day (15,000/month).
 *
 * Requires UNCOMTRADE_API_KEY (subscription key from https://comtradeapi.un.org).
 *
 * Shows import/export statistics by country pair and HS code.
 * Used in the Trade module to show market intelligence.
 */

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (integrations.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "integrations.read"); if (_d) return _d; } /* requirePermission wired */


  const url = new URL(req.url);
  const reporter = url.searchParams.get("reporter"); // ISO country code
  const partner = url.searchParams.get("partner");
  const hsCode = url.searchParams.get("hsCode");
  const year = url.searchParams.get("year") || String(new Date().getFullYear() - 1);
  const flow = url.searchParams.get("flow") || "X"; // X=export, M=import

  if (!reporter) {
    return NextResponse.json({ error: "reporter country code is required (e.g. RS, AE, US)" }, { status: 400 });
  }

  const store = await getStore();
  const integrationSettings = await store.getSetting<any>("integrations");
  const apiKey = process.env.UNCOMTRADE_API_KEY || integrationSettings?.uncomtrade_api_key;

  if (!apiKey) {
    return NextResponse.json({
      error: "UN Comtrade API key is not configured. Go to Settings → API Integrations to set it up.",
      setupGuide: {
        step1: "Go to https://comtradeapi.un.org",
        step2: "Click 'Register' and create a free account",
        step3: "After login, go to 'Profile' → copy your 'Subscription Key'",
        step4: "Paste the key in Settings → API Integrations → UN Comtrade",
      },
    }, { status: 200 });
  }

  try {
    // Build Comtrade API URL
    const params = new URLSearchParams({
      reporterCode: reporter,
      period: year,
      cmdCode: hsCode || "TOTAL",
      flowCode: flow,
      freqCode: "A", // Annual
      clCode: "HS", // Harmonized System
    });
    if (partner) params.set("partnerCode", partner);

    const res = await fetch(
      `https://comtradeapi.un.org/data/v1/get/C/A/HS?${params}`,
      {
        headers: {
          "Ocp-Apim-Subscription-Key": apiKey,
        },
        signal: AbortSignal.timeout(15_000),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      return NextResponse.json({ error: `Comtrade API error ${res.status}: ${errText}` }, { status: 502 });
    }

    const data = await res.json();

    // Normalize the results
    const items = (data.data || []).map((d: any) => ({
      reporter: d.reporterDesc || d.reporterCode,
      partner: d.partnerDesc || d.partnerCode,
      flow: d.flowDesc || d.flowCode,
      hsCode: d.cmdCode,
      hsDescription: d.cmdDesc,
      year: d.period,
      tradeValue: d.primaryValue || 0,
      netWeight: d.netWght || null,
      quantity: d.qty || null,
      qtyUnit: d.qtyDesc || "",
      flags: d.isFlagDesc || "",
    }));

    return NextResponse.json({
      items,
      total: items.length,
      query: { reporter, partner, hsCode, year, flow },
      source: "UN Comtrade",
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
