import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * GET /api/integrations/geocode?q=1600+Amphitheatre+Parkway
 *
 * Free address autocomplete using Nominatim (OpenStreetMap).
 * No API key required — just needs a valid User-Agent.
 * Rate limit: 1 request per second (enforced by Nominatim).
 *
 * This replaces Google Places API (which requires a credit card).
 * Nominatim is slightly less accurate but completely free and unlimited.
 *
 * Returns predictions in the same format as the Google Places endpoint
 * so the AddressAutocomplete component works with both.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const q = url.searchParams.get("q") || url.searchParams.get("input") || "";
  const limit = Math.min(Number(url.searchParams.get("limit") || 5), 10);

  if (q.length < 3) return NextResponse.json({ predictions: [] });

  try {
    const params = new URLSearchParams({
      q,
      format: "json",
      addressdetails: "1",
      limit: String(limit),
      "accept-language": "en",
    });

    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: {
        "User-Agent": "VELOSCRM/1.0 (trade@velos.trade)",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return NextResponse.json({ predictions: [], error: `Nominatim API error ${res.status}` });
    }

    const data = await res.json();

    const predictions = (data || []).map((p: any) => {
      const addr = p.address || {};
      const street = [addr.house_number, addr.road].filter(Boolean).join(" ");
      const city = addr.city || addr.town || addr.village || addr.municipality || addr.county || "";
      const state = addr.state || "";
      const postalCode = addr.postcode || "";
      const country = addr.country || "";
      const countryCode = addr.country_code?.toUpperCase() || "";

      return {
        place_id: p.place_id?.toString() || "",
        description: p.display_name,
        main_text: street || city || country,
        secondary_text: [city, state, postalCode, country].filter(Boolean).join(", "),
        formatted_address: p.display_name,
        street,
        city,
        state,
        postal_code: postalCode,
        country,
        country_code: countryCode,
        lat: parseFloat(p.lat),
        lng: parseFloat(p.lon),
      };
    });

    return NextResponse.json({ predictions });
  } catch (e: any) {
    return NextResponse.json({ predictions: [], error: e.message });
  }
}
