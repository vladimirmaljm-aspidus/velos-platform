import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";

export const runtime = "nodejs";

let cache: Record<string, { data: any; fetchedAt: number }> = {};
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes — weather changes frequently

/**
 * GET /api/integrations/weather?lat=25.01&lon=55.06
 * GET /api/integrations/weather?city=Dubai
 *
 * Fetches current weather from OpenWeatherMap.
 * Free tier: 1,000 calls/day, 30,000/month.
 *
 * Requires OPENWEATHER_API_KEY environment variable (or tenant setting).
 * Get a free key at: https://openweathermap.org/api
 *
 * Used in the Logistics module to show weather conditions at ports.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (integrations.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "integrations.read"); if (_d) return _d; } /* requirePermission wired */


  const url = new URL(req.url);
  const lat = url.searchParams.get("lat");
  const lon = url.searchParams.get("lon");
  const city = url.searchParams.get("city");

  if (!lat && !lon && !city) {
    return NextResponse.json({ error: "Provide lat/lon or city parameter." }, { status: 400 });
  }

  // Get API key
  const store = await getStore();
  const integrationSettings = await store.getSetting<any>("integrations");
  const apiKey = process.env.OPENWEATHER_API_KEY || integrationSettings?.openweather_api_key;

  if (!apiKey) {
    return NextResponse.json({
      error: "OpenWeatherMap API key is not configured. Go to Settings → API Integrations to set it up.",
    }, { status: 200 });
  }

  const cacheKey = lat && lon ? `${lat}_${lon}` : city || "";

  // Check cache
  if (cache[cacheKey] && Date.now() - cache[cacheKey].fetchedAt < CACHE_TTL) {
    return NextResponse.json({ ...cache[cacheKey].data, cached: true });
  }

  try {
    // Build URL
    const params = new URLSearchParams({
      appid: apiKey,
      units: "metric",
    });
    if (lat && lon) {
      params.set("lat", lat);
      params.set("lon", lon);
    } else if (city) {
      params.set("q", city);
    }

    // Current weather
    const res = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?${params}`,
      { signal: AbortSignal.timeout(10_000) }
    );

    if (!res.ok) {
      const errText = await res.text();
      let errMsg = `OpenWeatherMap API error ${res.status}`;
      try {
        const errJson = JSON.parse(errText);
        errMsg = errJson.message || errMsg;
      } catch {}
      return NextResponse.json({ error: errMsg }, { status: 502 });
    }

    const data = await res.json();

    // Normalize
    const weather = {
      location: data.name || "",
      country: data.sys?.country || "",
      temperature: Math.round(data.main?.temp || 0),
      feelsLike: Math.round(data.main?.feels_like || 0),
      humidity: data.main?.humidity || 0,
      pressure: data.main?.pressure || 0,
      windSpeed: Math.round((data.wind?.speed || 0) * 3.6), // m/s → km/h
      windDirection: data.wind?.deg || 0,
      cloudiness: data.clouds?.all || 0,
      visibility: data.visibility || 0, // meters
      condition: data.weather?.[0]?.main || "",
      description: data.weather?.[0]?.description || "",
      icon: data.weather?.[0]?.icon || "",
      sunrise: data.sys?.sunrise ? new Date(data.sys.sunrise * 1000).toISOString() : null,
      sunset: data.sys?.sunset ? new Date(data.sys.sunset * 1000).toISOString() : null,
      lat: data.coord?.lat,
      lon: data.coord?.lon,
      timestamp: new Date().toISOString(),
    };

    cache[cacheKey] = { data: weather, fetchedAt: Date.now() };

    return NextResponse.json({ ...weather, cached: false });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
