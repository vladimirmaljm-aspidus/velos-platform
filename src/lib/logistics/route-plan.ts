/**
 * Orchestrates a full door-to-door route plan:
 *   origin address --(road)--> nearest origin port
 *                   --(sea, via real maritime waypoint network)-->
 *   nearest destination port --(road)--> destination address
 *
 * Combines: Nominatim geocoding, OSRM driving routes, the existing
 * Dijkstra maritime router, and offline border-crossing detection.
 * Every external call is best-effort — a failed OSRM/Nominatim lookup
 * degrades to a straight-line estimate rather than failing the whole plan.
 */
import { geocodeStructured, geocodeAddress, type GeocodeResult } from "./geocoding";
import { drivingRoute, type DrivingRoute } from "./osrm";
import { findNearestPort } from "./nearest-port";
import { detectBorderCrossings, type BorderCrossing } from "./borders";
import {
  findMaritimeRoute,
  haversineNm,
  type RouteResult as MaritimeRoute,
  type Waypoint,
} from "./maritime-router";

// ── Timing/dwell assumptions (clearly estimates, not carrier commitments) ──
const PORT_DWELL_HOURS = 48; // customs + loading/unloading at each port
const BORDER_DWELL_HOURS = 3; // average customs clearance per land border
const SEA_KNOTS = 14; // matches maritime-router's transitDays assumption

// ── Indicative cost model (NOT an official price list — no such data
// source exists in this system yet; flagged clearly to the caller/UI). ──
const COST_PER_KM_ROAD_USD = 1.35; // truck FTL, rough global blended rate
const COST_PER_NM_SEA_USD = 2.9; // FCL ocean freight, rough blended rate
const COST_PER_BORDER_USD = 180; // customs brokerage per crossing

export interface AddressInput {
  addressLine?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  /** Optional named port — if given, used as the port instead of auto-picking one. */
  port?: string | null;
}

export interface RouteLeg {
  kind: "road" | "sea";
  fromLabel: string;
  toLabel: string;
  fromCoords: [number, number]; // [lng, lat]
  toCoords: [number, number];
  geometry: [number, number][]; // [lng, lat] path for rendering
  distanceKm: number;
  durationHours: number;
  approximate: boolean; // true when the routing API failed and we fell back to a straight line
}

export interface RoutePlan {
  origin: { label: string; coords: [number, number] };
  destination: { label: string; coords: [number, number] };
  originPort: { label: string; coords: [number, number] };
  destinationPort: { label: string; coords: [number, number] };
  legs: RouteLeg[];
  intermediateWaypoints: Waypoint[]; // canals / straits / capes on the sea leg
  borderCrossings: BorderCrossing[];
  totals: {
    distanceKm: number;
    transitHours: number; // pure movement time (road driving + sea transit)
    dwellHours: number; // port + border dwell estimate
    totalHours: number;
    totalDays: number;
  };
  estimatedCost: {
    roadUsd: number;
    seaUsd: number;
    customsUsd: number;
    totalUsd: number;
    disclaimer: string;
  };
}

const NM_TO_KM = 1.852;

function greatCircleLeg(
  kind: "road" | "sea",
  fromLabel: string,
  toLabel: string,
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  speedKmh: number,
): RouteLeg {
  const distanceKm = haversineNm(from.lat, from.lng, to.lat, to.lng) * NM_TO_KM;
  return {
    kind,
    fromLabel,
    toLabel,
    fromCoords: [from.lng, from.lat],
    toCoords: [to.lng, to.lat],
    geometry: [[from.lng, from.lat], [to.lng, to.lat]],
    distanceKm,
    durationHours: distanceKm / speedKmh,
    approximate: true,
  };
}

function roadLegFromOsrm(
  fromLabel: string,
  toLabel: string,
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  route: DrivingRoute | null,
): RouteLeg {
  if (!route) return greatCircleLeg("road", fromLabel, toLabel, from, to, 55);
  return {
    kind: "road",
    fromLabel,
    toLabel,
    fromCoords: [from.lng, from.lat],
    toCoords: [to.lng, to.lat],
    geometry: route.geometry,
    distanceKm: route.distanceKm,
    durationHours: route.durationHours,
    approximate: false,
  };
}

async function resolveAddress(input: AddressInput, fallbackLabel: string): Promise<{ result: GeocodeResult; label: string }> {
  if (input.port) {
    const byPort = await geocodeAddress(`${input.port} port`);
    if (byPort) return { result: byPort, label: input.port };
  }
  const structured = await geocodeStructured(input);
  if (structured) {
    const label = [input.addressLine, input.city, input.country].filter(Boolean).join(", ") || structured.displayName;
    return { result: structured, label };
  }
  throw new Error(`Could not geocode ${fallbackLabel}: no matching address or port found.`);
}

export async function buildRoutePlan(
  origin: AddressInput,
  destination: AddressInput,
): Promise<RoutePlan> {
  const [originGeo, destGeo] = await Promise.all([
    resolveAddress(origin, "origin"),
    resolveAddress(destination, "destination"),
  ]);

  const originPoint = { lat: originGeo.result.lat, lng: originGeo.result.lng };
  const destPoint = { lat: destGeo.result.lat, lng: destGeo.result.lng };

  const [originPortPick, destPortPick] = await Promise.all([
    findNearestPort(originPoint),
    findNearestPort(destPoint),
  ]);

  const maritime: MaritimeRoute = findMaritimeRoute(
    originPortPick.port.lat, originPortPick.port.lng,
    destPortPick.port.lat, destPortPick.port.lng,
  );

  const leg1 = roadLegFromOsrm(
    originGeo.label, originPortPick.port.name,
    originPoint, { lat: originPortPick.port.lat, lng: originPortPick.port.lng },
    originPortPick.drivingRoute,
  );

  // findMaritimeRoute wraps its input coords in virtual "origin"/"destination"
  // waypoints; since we call it with the port's own coords, those wrapper
  // segments collapse to zero distance — drop them, they add no information.
  const seaLegs: RouteLeg[] = maritime.segments.filter((seg) => seg.distance > 0).map((seg) => ({
    kind: "sea" as const,
    fromLabel: seg.from.name,
    toLabel: seg.to.name,
    fromCoords: [seg.from.lng, seg.from.lat] as [number, number],
    toCoords: [seg.to.lng, seg.to.lat] as [number, number],
    geometry: [[seg.from.lng, seg.from.lat], [seg.to.lng, seg.to.lat]] as [number, number][],
    distanceKm: seg.distance * NM_TO_KM,
    durationHours: (seg.distance * NM_TO_KM) / (SEA_KNOTS * 1.852),
    approximate: false,
  }));

  const leg3 = roadLegFromOsrm(
    destPortPick.port.name, destGeo.label,
    { lat: destPortPick.port.lat, lng: destPortPick.port.lng }, destPoint,
    destPortPick.drivingRoute,
  );

  const legs = [leg1, ...seaLegs, leg3];

  const borderCrossings = [
    ...detectBorderCrossings(leg1.geometry),
    ...detectBorderCrossings(leg3.geometry),
  ];

  const intermediateWaypoints = maritime.waypoints.filter(
    (w) => w.type === "canal" || w.type === "strait" || w.type === "cape",
  );

  const roadKm = leg1.distanceKm + leg3.distanceKm;
  const seaKm = seaLegs.reduce((s, l) => s + l.distanceKm, 0);
  const distanceKm = roadKm + seaKm;
  const transitHours = legs.reduce((s, l) => s + l.durationHours, 0);
  const dwellHours = PORT_DWELL_HOURS * 2 + borderCrossings.length * BORDER_DWELL_HOURS;
  const totalHours = transitHours + dwellHours;

  const roadUsd = roadKm * COST_PER_KM_ROAD_USD;
  const seaUsd = (seaKm / NM_TO_KM) * COST_PER_NM_SEA_USD;
  const customsUsd = borderCrossings.length * COST_PER_BORDER_USD;

  return {
    origin: { label: originGeo.label, coords: [originPoint.lng, originPoint.lat] },
    destination: { label: destGeo.label, coords: [destPoint.lng, destPoint.lat] },
    originPort: { label: originPortPick.port.name, coords: [originPortPick.port.lng, originPortPick.port.lat] },
    destinationPort: { label: destPortPick.port.name, coords: [destPortPick.port.lng, destPortPick.port.lat] },
    legs,
    intermediateWaypoints,
    borderCrossings,
    totals: {
      distanceKm: Math.round(distanceKm),
      transitHours: Math.round(transitHours),
      dwellHours: Math.round(dwellHours),
      totalHours: Math.round(totalHours),
      totalDays: Math.round((totalHours / 24) * 10) / 10,
    },
    estimatedCost: {
      roadUsd: Math.round(roadUsd),
      seaUsd: Math.round(seaUsd),
      customsUsd: Math.round(customsUsd),
      totalUsd: Math.round(roadUsd + seaUsd + customsUsd),
      disclaimer: "Indicative estimate based on blended market rates — not an official carrier quote or price list.",
    },
  };
}
