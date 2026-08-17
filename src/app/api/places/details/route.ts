import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * GET /api/places/details?place_id=ChIJ...
 *
 * Proxies Google Places Details API.
 * Returns { formatted_address, street, city, state, postal_code, country, lat, lng }
 *
 * If no API key is configured, returns empty result.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (dashboard.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "dashboard.read"); if (_d) return _d; } /* requirePermission wired */


  const url = new URL(req.url);
  const placeId = url.searchParams.get("place_id");
  if (!placeId) return NextResponse.json({ error: "place_id required" }, { status: 400 });

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "GOOGLE_MAPS_API_KEY not configured" });
  }

  try {
    const params = new URLSearchParams({
      place_id: placeId,
      key: apiKey,
      fields: "formatted_address,address_components,geometry",
      language: "en",
    });
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/place/details/json?${params}`,
      { signal: AbortSignal.timeout(8_000) }
    );
    const data = await res.json();
    const result = data.result;

    if (!result) return NextResponse.json({ error: "Place not found" }, { status: 404 });

    // Parse address_components into structured fields
    const components = result.address_components || [];
    const get = (type: string) => components.find((c: any) => c.types.includes(type))?.long_name || "";

    const street = [get("street_number"), get("route")].filter(Boolean).join(" ");
    const city = get("locality") || get("postal_town") || get("administrative_area_level_2");
    const state = get("administrative_area_level_1");
    const postalCode = get("postal_code");
    const country = get("country");
    const countryCode = components.find((c: any) => c.types.includes("country"))?.short_name || "";

    return NextResponse.json({
      formatted_address: result.formatted_address,
      street,
      city,
      state,
      postal_code: postalCode,
      country,
      country_code: countryCode,
      lat: result.geometry?.location?.lat,
      lng: result.geometry?.location?.lng,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
