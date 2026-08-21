/**
 * Picks the most realistic "nearest port" for a given inland point.
 *
 * Pure great-circle distance is misleading near coastlines with poor road
 * access (fjords, deltas, mountain ranges). We shortlist candidates by
 * haversine distance, then rank the shortlist by actual OSRM driving
 * distance/time — falling back to the haversine ranking if OSRM is
 * unreachable.
 */
import { WAYPOINTS, haversineNm, type Waypoint } from "./maritime-router";
import { drivingRoute, type DrivingRoute } from "./osrm";

const HUB_PORTS = WAYPOINTS.filter((w) => w.type === "hub");
const SHORTLIST_SIZE = 5;

export interface NearestPortResult {
  port: Waypoint;
  drivingRoute: DrivingRoute | null;
}

export async function findNearestPort(
  point: { lat: number; lng: number },
): Promise<NearestPortResult> {
  const shortlist = [...HUB_PORTS]
    .map((port) => ({ port, nm: haversineNm(point.lat, point.lng, port.lat, port.lng) }))
    .sort((a, b) => a.nm - b.nm)
    .slice(0, SHORTLIST_SIZE);

  const withDriving = await Promise.all(
    shortlist.map(async ({ port }) => ({
      port,
      drivingRoute: await drivingRoute(point, { lat: port.lat, lng: port.lng }),
    })),
  );

  // Prefer the candidate OSRM could actually route to, ranked by driving
  // distance. If OSRM failed for everything, fall back to the closest
  // great-circle candidate (shortlist is already sorted by that).
  const reachable = withDriving.filter((c) => c.drivingRoute !== null);
  if (reachable.length > 0) {
    reachable.sort((a, b) => a.drivingRoute!.distanceKm - b.drivingRoute!.distanceKm);
    return reachable[0];
  }
  return { port: shortlist[0].port, drivingRoute: null };
}
