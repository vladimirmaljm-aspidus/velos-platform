import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * GET /api/places/autocomplete?input=1600+Amphitheatre
 *
 * Proxies Google Places Autocomplete API.
 * Requires GOOGLE_MAPS_API_KEY environment variable.
 * Returns { predictions: [{ place_id, description, main_text, secondary_text }] }
 *
 * If no API key is configured, returns empty predictions (the UI falls back
 * to a plain text input).
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (dashboard.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "dashboard.read"); if (_d) return _d; } /* requirePermission wired */


  const url = new URL(req.url);
  const input = url.searchParams.get("input") || "";
  if (input.length < 3) return NextResponse.json({ predictions: [] });

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    // No API key — return empty so the UI falls back to plain text input
    return NextResponse.json({ predictions: [], error: "GOOGLE_MAPS_API_KEY not configured" });
  }

  try {
    const params = new URLSearchParams({
      input,
      key: apiKey,
      types: "geocode", // addresses only (no businesses)
      language: "en",
    });
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/place/autocomplete/json?${params}`,
      { signal: AbortSignal.timeout(8_000) }
    );
    const data = await res.json();

    const predictions = (data.predictions || []).map((p: any) => ({
      place_id: p.place_id,
      description: p.description,
      main_text: p.structured_formatting?.main_text || "",
      secondary_text: p.structured_formatting?.secondary_text || "",
    }));

    return NextResponse.json({ predictions });
  } catch (e: any) {
    return NextResponse.json({ predictions: [], error: e.message });
  }
}
