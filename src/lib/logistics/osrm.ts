/**
 * Server-side land-routing via OSRM's free public demo server — no API key.
 * https://project-osrm.org/docs/v5.24.0/api/#general-options
 *
 * The demo server is rate-limited and best-effort (no SLA). Callers must
 * tolerate null results and fall back to a straight-line estimate.
 */

const OSRM_URL = "https://router.project-osrm.org/route/v1/driving";

export interface DrivingRoute {
  distanceKm: number;
  durationHours: number;
  /** [lng, lat] pairs, simplified overview geometry. */
  geometry: [number, number][];
}

export async function drivingRoute(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): Promise<DrivingRoute | null> {
  try {
    const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
    const params = new URLSearchParams({ overview: "full", geometries: "geojson" });
    const res = await fetch(`${OSRM_URL}/${coords}?${params}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const route = data?.routes?.[0];
    if (!route) return null;
    return {
      distanceKm: route.distance / 1000,
      durationHours: route.duration / 3600,
      geometry: route.geometry?.coordinates || [],
    };
  } catch {
    return null;
  }
}
