// DEPRECATED: This route has no active UI consumers. Kept for potential future use.
// If you're building a new feature, consider whether this integration is still needed.
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";

export const runtime = "nodejs";

let cache: Record<string, { data: any; fetchedAt: number }> = {};
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes — tracking updates frequently

/**
 * GET /api/integrations/searates?container=MSCU1234567
 *
 * Tracks a shipping container using SeaRates API.
 * Free tier: 100 requests/month.
 *
 * Requires SEARATES_API_KEY environment variable (or tenant setting).
 * Get a free key at: https://www.searates.com
 *
 * Covers 150+ shipping lines (MAERSK, MSC, CMA CGM, COSCO, Hapag-Lloyd, etc.)
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (integrations.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "integrations.read"); if (_d) return _d; } /* requirePermission wired */


  const url = new URL(req.url);
  const container = (url.searchParams.get("container") || "").trim().toUpperCase();
  const booking = (url.searchParams.get("booking") || "").trim().toUpperCase();

  if (!container && !booking) {
    return NextResponse.json({ error: "Container number or booking number is required." }, { status: 400 });
  }

  const store = await getStore();
  const integrationSettings = await store.getSetting<any>("integrations");
  const apiKey = process.env.SEARATES_API_KEY || integrationSettings?.searates_api_key;

  if (!apiKey) {
    return NextResponse.json({
      error: "SeaRates API key is not configured. Go to Settings → API Integrations to set it up.",
      setupGuide: {
        step1: "Go to https://www.searates.com",
        step2: "Sign up for a free account",
        step3: "Go to 'API Keys' → create a new key",
        step4: "Copy the API key",
        step5: "Paste it in Settings → API Integrations → SeaRates",
      },
    }, { status: 200 });
  }

  const cacheKey = container || booking;

  // Check cache
  if (cache[cacheKey] && Date.now() - cache[cacheKey].fetchedAt < CACHE_TTL) {
    return NextResponse.json({ ...cache[cacheKey].data, cached: true });
  }

  try {
    // SeaRates tracking API
    const params = new URLSearchParams({
      key: apiKey,
    });
    if (container) params.set("container", container);
    if (booking) params.set("booking", booking);

    const res = await fetch(
      `https://sirius.searates.com/tracking?${params}`,
      { signal: AbortSignal.timeout(15_000) }
    );

    if (!res.ok) {
      const errText = await res.text();
      let errMsg = `SeaRates API error ${res.status}`;
      try {
        const errJson = JSON.parse(errText);
        errMsg = errJson.message || errJson.error || errMsg;
      } catch {}
      return NextResponse.json({ error: errMsg }, { status: 502 });
    }

    const data = await res.json();

    // Normalize the tracking data
    const tracking = {
      containerNumber: container || data.container || "",
      bookingNumber: booking || data.booking || "",
      status: data.status || "unknown",
      carrier: data.carrier || data.shipping_line || "",
      vessel: data.vessel || "",
      voyage: data.voyage || "",
      pol: data.pol || data.port_of_loading || "",
      pod: data.pod || data.port_of_discharge || "",
      eta: data.eta || null,
      atd: data.atd || null, // Actual time of departure
      ata: data.ata || null, // Actual time of arrival
      currentLocation: data.current_location || data.position || "",
      lastUpdate: data.last_update || data.updated_at || new Date().toISOString(),
      events: (data.events || data.history || []).map((e: any) => ({
        date: e.date || e.timestamp || "",
        location: e.location || e.port || "",
        description: e.description || e.event || "",
        type: e.type || "",
      })),
    };

    cache[cacheKey] = { data: tracking, fetchedAt: Date.now() };

    return NextResponse.json({ ...tracking, cached: false });
  } catch (e: any) {
    // SEC-L4 — never leak raw e.message to the client. SeaRates error
    // bodies include API key / endpoint hints. The sanitizeError
    // helper strips schema/table/column leaks and constraint names.
    console.error("[searates]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 502 });
  }
}
