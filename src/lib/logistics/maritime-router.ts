/**
 * Maritime routing network.
 *
 * Instead of drawing straight lines between ports (which cross land),
 * routes go through a network of key maritime waypoints:
 * - Canals: Suez, Panama, Kiel
 * - Straits: Hormuz, Malacca, Gibraltar, Bab-el-Mandeb, Bosphorus
 * - Capes: Cape of Good Hope, Cape Horn, Cape Leeuwin
 * - Major shipping hubs: Singapore, Rotterdam, Dubai, Hamburg, etc.
 *
 * The route finder uses Dijkstra's algorithm to find the shortest
 * path between any two ports through this waypoint network.
 */

export interface Waypoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
  type: "canal" | "strait" | "cape" | "port" | "hub";
}

export interface WaypointConnection {
  from: string;
  to: string;
  distance: number; // nautical miles (pre-calculated via Haversine)
}

// ── Major maritime waypoints ──────────────────────────────────────
export const WAYPOINTS: Waypoint[] = [
  // Canals
  { id: "suez_north", name: "Suez Canal (North)", lat: 31.5, lng: 32.3, type: "canal" },
  { id: "suez_south", name: "Suez Canal (South)", lat: 29.9, lng: 32.5, type: "canal" },
  { id: "panama_north", name: "Panama Canal (North)", lat: 9.3, lng: -79.9, type: "canal" },
  { id: "panama_south", name: "Panama Canal (South)", lat: 8.9, lng: -79.5, type: "canal" },
  { id: "kiel", name: "Kiel Canal", lat: 54.4, lng: 9.5, type: "canal" },

  // Straits
  { id: "hormuz", name: "Strait of Hormuz", lat: 26.6, lng: 56.3, type: "strait" },
  { id: "malacca", name: "Strait of Malacca", lat: 2.5, lng: 101.3, type: "strait" },
  { id: "gibraltar", name: "Strait of Gibraltar", lat: 35.9, lng: -5.6, type: "strait" },
  { id: "bab_el_mandeb", name: "Bab-el-Mandeb", lat: 12.6, lng: 43.4, type: "strait" },
  { id: "bosporus", name: "Bosphorus", lat: 41.1, lng: 29.1, type: "strait" },
  { id: "sunda", name: "Sunda Strait", lat: -6.0, lng: 105.5, type: "strait" },
  { id: "lombok", name: "Lombok Strait", lat: -8.5, lng: 115.8, type: "strait" },
  { id: "english_channel", name: "English Channel", lat: 50.0, lng: -1.5, type: "strait" },
  { id: "taiwan", name: "Taiwan Strait", lat: 24.5, lng: 119.5, type: "strait" },
  { id: "tora", name: "Strait of Tora", lat: 27.7, lng: 33.8, type: "strait" },

  // Capes
  { id: "cape_good_hope", name: "Cape of Good Hope", lat: -34.4, lng: 18.5, type: "cape" },
  { id: "cape_horn", name: "Cape Horn", lat: -56.0, lng: -67.3, type: "cape" },
  { id: "cape_leewin", name: "Cape Leeuwin", lat: -34.4, lng: 115.1, type: "cape" },
  { id: "cape_agulhas", name: "Cape Agulhas", lat: -34.8, lng: 20.0, type: "cape" },

  // Major ports (shipping hubs)
  { id: "rotterdam", name: "Rotterdam", lat: 51.9, lng: 4.5, type: "hub" },
  { id: "hamburg", name: "Hamburg", lat: 53.5, lng: 10.0, type: "hub" },
  { id: "singapore", name: "Singapore", lat: 1.3, lng: 103.8, type: "hub" },
  { id: "dubai", name: "Dubai (Jebel Ali)", lat: 25.0, lng: 55.1, type: "hub" },
  { id: "hong_kong", name: "Hong Kong", lat: 22.3, lng: 114.2, type: "hub" },
  { id: "shanghai", name: "Shanghai", lat: 31.2, lng: 121.5, type: "hub" },
  { id: "los_angeles", name: "Los Angeles", lat: 33.7, lng: -118.3, type: "hub" },
  { id: "new_york", name: "New York", lat: 40.7, lng: -74.0, type: "hub" },
  { id: "mumbai", name: "Mumbai (Nhava Sheva)", lat: 18.9, lng: 72.9, type: "hub" },
  { id: "istanbul", name: "Istanbul", lat: 41.0, lng: 29.0, type: "hub" },
  { id: "novorossiysk", name: "Novorossiysk", lat: 44.7, lng: 37.8, type: "hub" },
  { id: "constantza", name: "Constantza", lat: 44.2, lng: 28.7, type: "hub" },
  { id: "jeddah", name: "Jeddah", lat: 21.5, lng: 39.2, type: "hub" },
  { id: "colombo", name: "Colombo", lat: 6.9, lng: 79.8, type: "hub" },
  { id: "durban", name: "Durban", lat: -29.9, lng: 31.0, type: "hub" },
  { id: "fremantle", name: "Fremantle", lat: -32.1, lng: 115.7, type: "hub" },
  { id: "valencia", name: "Valencia", lat: 39.4, lng: -0.3, type: "hub" },
  { id: "genoa", name: "Genoa", lat: 44.4, lng: 8.9, type: "hub" },
  { id: "piraeus", name: "Piraeus", lat: 37.9, lng: 23.6, type: "hub" },
  { id: "dakar", name: "Dakar", lat: 14.7, lng: -17.4, type: "hub" },
  { id: "abidjan", name: "Abidjan", lat: 5.3, lng: -4.0, type: "hub" },
  { id: "lagos", name: "Lagos", lat: 6.4, lng: 3.4, type: "hub" },
  { id: "mombasa", name: "Mombasa", lat: -4.0, lng: 39.7, type: "hub" },
  { id: "djibouti", name: "Djibouti", lat: 11.6, lng: 43.1, type: "hub" },
  { id: "karachi", name: "Karachi", lat: 24.8, lng: 66.9, type: "hub" },
  { id: "chittagong", name: "Chittagong", lat: 22.3, lng: 91.8, type: "hub" },
  { id: "ho_chi_minh", name: "Ho Chi Minh City", lat: 10.7, lng: 106.8, type: "hub" },
  { id: "busan", name: "Busan", lat: 35.1, lng: 129.0, type: "hub" },
  { id: "tokyo", name: "Tokyo", lat: 35.6, lng: 139.8, type: "hub" },
  { id: "sydney", name: "Sydney", lat: -33.9, lng: 151.2, type: "hub" },
  { id: "santos_br", name: "Santos (Brazil)", lat: -23.9, lng: -46.3, type: "hub" },
  { id: "buenos_aires", name: "Buenos Aires", lat: -34.6, lng: -58.4, type: "hub" },
  { id: "callao", name: "Callao (Peru)", lat: -12.0, lng: -77.1, type: "hub" },
  { id: "guayaquil", name: "Guayaquil", lat: -2.2, lng: -79.9, type: "hub" },
  { id: "manila", name: "Manila", lat: 14.6, lng: 120.9, type: "hub" },
  { id: "jakarta", name: "Jakarta", lat: -6.1, lng: 106.9, type: "hub" },
  { id: "auckland", name: "Auckland", lat: -36.85, lng: 174.76, type: "hub" },
];

// ── Connections between waypoints (shipping lanes) ──────────────────
// These define which waypoints are directly connected by sea routes.
// The route finder uses these to build a graph and find the shortest path.
export const CONNECTIONS: WaypointConnection[] = [
  // Mediterranean → Atlantic via Gibraltar
  { from: "gibraltar", to: "valencia", distance: 380 },
  { from: "gibraltar", to: "genoa", distance: 950 },
  { from: "gibraltar", to: "piraeus", distance: 1620 },
  { from: "valencia", to: "genoa", distance: 600 },
  { from: "genoa", to: "piraeus", distance: 1050 },
  { from: "piraeus", to: "istanbul", distance: 350 },
  { from: "istanbul", to: "bosporus", distance: 20 },
  { from: "bosporus", to: "novorossiysk", distance: 320 },
  { from: "istanbul", to: "constantza", distance: 180 },

  // Gibraltar → Northern Europe
  { from: "gibraltar", to: "english_channel", distance: 900 },
  { from: "english_channel", to: "rotterdam", distance: 180 },
  { from: "rotterdam", to: "hamburg", distance: 280 },
  { from: "english_channel", to: "kiel", distance: 380 },
  { from: "kiel", to: "hamburg", distance: 65 },

  // Mediterranean → Suez Canal → Red Sea → Indian Ocean
  { from: "piraeus", to: "suez_north", distance: 700 },
  { from: "valencia", to: "suez_north", distance: 1650 },
  { from: "suez_north", to: "suez_south", distance: 100 },
  { from: "suez_south", to: "jeddah", distance: 650 },
  { from: "suez_south", to: "tora", distance: 200 },
  { from: "jeddah", to: "bab_el_mandeb", distance: 700 },
  { from: "tora", to: "bab_el_mandeb", distance: 650 },
  { from: "bab_el_mandeb", to: "djibouti", distance: 100 },
  { from: "djibouti", to: "mombasa", distance: 950 },
  { from: "bab_el_mandeb", to: "hormuz", distance: 1200 },
  { from: "hormuz", to: "dubai", distance: 80 },
  { from: "hormuz", to: "karachi", distance: 520 },
  { from: "karachi", to: "mumbai", distance: 490 },
  { from: "mumbai", to: "colombo", distance: 320 },
  { from: "colombo", to: "malacca", distance: 1200 },

  // Indian Ocean → Cape of Good Hope → Atlantic
  { from: "mombasa", to: "cape_good_hope", distance: 2100 },
  { from: "djibouti", to: "cape_good_hope", distance: 2900 },
  { from: "cape_good_hope", to: "cape_agulhas", distance: 100 },
  { from: "cape_agulhas", to: "dakar", distance: 2800 },
  { from: "cape_agulhas", to: "abidjan", distance: 2400 },
  { from: "abidjan", to: "dakar", distance: 950 },
  { from: "abidjan", to: "lagos", distance: 350 },
  { from: "dakar", to: "gibraltar", distance: 1700 },
  { from: "dakar", to: "santos_br", distance: 1750 },
  { from: "cape_agulhas", to: "durban", distance: 280 },
  { from: "durban", to: "cape_good_hope", distance: 350 },

  // South America
  { from: "santos_br", to: "buenos_aires", distance: 1050 },
  { from: "santos_br", to: "callao", distance: 2200 },
  { from: "buenos_aires", to: "cape_horn", distance: 1100 },
  { from: "callao", to: "guayaquil", distance: 1250 },
  { from: "guayaquil", to: "panama_south", distance: 700 },
  { from: "panama_south", to: "panama_north", distance: 40 },
  { from: "panama_north", to: "los_angeles", distance: 2900 },
  { from: "panama_north", to: "new_york", distance: 1800 },
  { from: "cape_horn", to: "callao", distance: 2400 },

  // North Atlantic
  { from: "new_york", to: "english_channel", distance: 3000 },
  { from: "los_angeles", to: "new_york", distance: 4800 }, // via Panama
  { from: "santos_br", to: "dakar", distance: 1850 },
  { from: "santos_br", to: "cape_good_hope", distance: 3400 },

  // Pacific
  { from: "los_angeles", to: "tokyo", distance: 4800 },
  { from: "los_angeles", to: "busan", distance: 4600 },
  { from: "tokyo", to: "busan", distance: 600 },
  { from: "busan", to: "shanghai", distance: 500 },
  { from: "busan", to: "hong_kong", distance: 1100 },
  { from: "shanghai", to: "hong_kong", distance: 900 },
  { from: "shanghai", to: "taiwan", distance: 400 },
  { from: "taiwan", to: "hong_kong", distance: 350 },
  { from: "hong_kong", to: "manila", distance: 650 },
  { from: "manila", to: "ho_chi_minh", distance: 600 },
  { from: "ho_chi_minh", to: "singapore", distance: 600 },
  { from: "hong_kong", to: "singapore", distance: 1450 },
  { from: "singapore", to: "malacca", distance: 100 },
  { from: "malacca", to: "jakarta", distance: 500 },
  { from: "jakarta", to: "sunda", distance: 200 },
  { from: "sunda", to: "fremantle", distance: 900 },
  { from: "lombok", to: "fremantle", distance: 800 },
  { from: "jakarta", to: "lombok", distance: 400 },

  // Australia
  { from: "fremantle", to: "cape_leewin", distance: 100 },
  { from: "fremantle", to: "sydney", distance: 1900 },
  { from: "sydney", to: "auckland", distance: 1300 },

  // Southeast Asia → India
  { from: "singapore", to: "colombo", distance: 1450 },
  { from: "malacca", to: "colombo", distance: 1400 },
  { from: "chittagong", to: "colombo", distance: 1100 },
  { from: "chittagong", to: "singapore", distance: 1700 },

  // Dubai → Asia
  { from: "dubai", to: "karachi", distance: 550 },
  { from: "dubai", to: "mumbai", distance: 950 },

  // Cape Horn → Pacific
  { from: "cape_horn", to: "fremantle", distance: 6000 },
];

// ── Haversine distance (nautical miles) ─────────────────────────────
export function haversineNm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3440.065; // Earth radius in nautical miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

// ── Find nearest waypoint to given coordinates ──────────────────────
export function findNearestWaypoint(lat: number, lng: number): Waypoint {
  let nearest = WAYPOINTS[0];
  let minDist = Infinity;
  for (const wp of WAYPOINTS) {
    const dist = haversineNm(lat, lng, wp.lat, wp.lng);
    if (dist < minDist) {
      minDist = dist;
      nearest = wp;
    }
  }
  return nearest;
}

// ── Dijkstra route finder through waypoint network ──────────────────
export interface RouteSegment {
  from: Waypoint;
  to: Waypoint;
  distance: number; // nautical miles
}

export interface RouteResult {
  segments: RouteSegment[];
  totalDistance: number; // nautical miles
  waypoints: Waypoint[];
  transitDays: number; // estimated at 14 knots average speed
}

/**
 * Build a direct route (fallback when no waypoint graph path exists or
 * when origin/destination snap to the same waypoint).
 */
function directRoute(
  originLat: number, originLng: number,
  destLat: number, destLng: number,
): RouteResult {
  const originVirtual: Waypoint = {
    id: "origin", name: "Origin", lat: originLat, lng: originLng, type: "port",
  };
  const destVirtual: Waypoint = {
    id: "destination", name: "Destination", lat: destLat, lng: destLng, type: "port",
  };
  const dist = haversineNm(originLat, originLng, destLat, destLng);
  return {
    segments: [{ from: originVirtual, to: destVirtual, distance: dist }],
    totalDistance: dist,
    waypoints: [originVirtual, destVirtual],
    transitDays: Math.ceil(dist / 336), // 14 knots * 24h = 336 nm/day
  };
}

export function findMaritimeRoute(
  originLat: number, originLng: number,
  destLat: number, destLng: number,
): RouteResult {
  const originWp = findNearestWaypoint(originLat, originLng);
  const destWp = findNearestWaypoint(destLat, destLng);

  // If same waypoint, direct route
  if (originWp.id === destWp.id) {
    return directRoute(originLat, originLng, destLat, destLng);
  }

  // Build adjacency list from connections (bidirectional)
  const adj = new Map<string, Array<{ to: string; distance: number }>>();
  for (const conn of CONNECTIONS) {
    if (!adj.has(conn.from)) adj.set(conn.from, []);
    if (!adj.has(conn.to)) adj.set(conn.to, []);
    adj.get(conn.from)!.push({ to: conn.to, distance: conn.distance });
    adj.get(conn.to)!.push({ to: conn.from, distance: conn.distance });
  }

  // Dijkstra's algorithm
  const dist = new Map<string, number>();
  const prev = new Map<string, string | null>();
  const visited = new Set<string>();
  const queue: Array<{ id: string; dist: number }> = [];

  for (const wp of WAYPOINTS) {
    dist.set(wp.id, Infinity);
    prev.set(wp.id, null);
  }

  // Start: origin waypoint + distance from actual origin to nearest waypoint
  const originToWp = haversineNm(originLat, originLng, originWp.lat, originWp.lng);
  dist.set(originWp.id, originToWp);
  queue.push({ id: originWp.id, dist: originToWp });

  let reached = false;
  while (queue.length > 0) {
    // Sort by distance (simple priority queue)
    queue.sort((a, b) => a.dist - b.dist);
    const current = queue.shift()!;

    if (visited.has(current.id)) continue;
    visited.add(current.id);

    if (current.id === destWp.id) {
      reached = true;
      break;
    }

    const neighbors = adj.get(current.id) || [];
    for (const neighbor of neighbors) {
      if (visited.has(neighbor.to)) continue;
      const newDist = current.dist + neighbor.distance;
      if (newDist < (dist.get(neighbor.to) || Infinity)) {
        dist.set(neighbor.to, newDist);
        prev.set(neighbor.to, current.id);
        queue.push({ id: neighbor.to, dist: newDist });
      }
    }
  }

  // No path through waypoint graph → fall back to direct great-circle
  if (!reached || prev.get(destWp.id) === null) {
    return directRoute(originLat, originLng, destLat, destLng);
  }

  // Reconstruct path
  const path: string[] = [];
  let current: string | null = destWp.id;
  while (current) {
    path.unshift(current);
    current = prev.get(current) || null;
  }

  // Build segments
  const segments: RouteSegment[] = [];
  let totalDistance = 0;

  const firstWp = WAYPOINTS.find(w => w.id === path[0])!;
  const distToFirst = haversineNm(originLat, originLng, firstWp.lat, firstWp.lng);
  totalDistance += distToFirst;

  // Create a virtual "origin" waypoint
  const originVirtual: Waypoint = {
    id: "origin", name: "Origin", lat: originLat, lng: originLng, type: "port",
  };
  segments.push({ from: originVirtual, to: firstWp, distance: distToFirst });

  // Between waypoints
  for (let i = 0; i < path.length - 1; i++) {
    const fromWp = WAYPOINTS.find(w => w.id === path[i])!;
    const toWp = WAYPOINTS.find(w => w.id === path[i + 1])!;
    const segDist = haversineNm(fromWp.lat, fromWp.lng, toWp.lat, toWp.lng);
    segments.push({ from: fromWp, to: toWp, distance: segDist });
    totalDistance += segDist;
  }

  // Last waypoint → destination
  const lastWp = WAYPOINTS.find(w => w.id === path[path.length - 1])!;
  const distFromLast = haversineNm(lastWp.lat, lastWp.lng, destLat, destLng);
  const destVirtual: Waypoint = {
    id: "destination", name: "Destination", lat: destLat, lng: destLng, type: "port",
  };
  segments.push({ from: lastWp, to: destVirtual, distance: distFromLast });
  totalDistance += distFromLast;

  const waypoints = [
    originVirtual,
    ...path.map(id => WAYPOINTS.find(w => w.id === id)!),
    destVirtual,
  ];

  return {
    segments,
    totalDistance: Math.round(totalDistance),
    waypoints,
    transitDays: Math.ceil(totalDistance / 336), // 14 knots * 24h = 336 nm/day
  };
}

// ── Geocode a port name to coordinates ──────────────────────────────
export function geocodePort(portName: string): { lat: number; lng: number } | null {
  if (!portName || portName.trim() === "") return null;
  const lower = portName.toLowerCase().trim();

  // Try to match a waypoint by name
  const wp = WAYPOINTS.find(w =>
    w.name.toLowerCase().includes(lower) || lower.includes(w.name.toLowerCase()),
  );
  if (wp) return { lat: wp.lat, lng: wp.lng };

  // Try partial matching on common port names
  const portMap: Record<string, { lat: number; lng: number }> = {
    hamburg: { lat: 53.5, lng: 10.0 },
    rotterdam: { lat: 51.9, lng: 4.5 },
    dubai: { lat: 25.0, lng: 55.1 },
    "jebel ali": { lat: 25.0, lng: 55.1 },
    singapore: { lat: 1.3, lng: 103.8 },
    "hong kong": { lat: 22.3, lng: 114.2 },
    shanghai: { lat: 31.2, lng: 121.5 },
    santos: { lat: -23.9, lng: -46.3 },
    mumbai: { lat: 18.9, lng: 72.9 },
    "nhava sheva": { lat: 18.9, lng: 72.9 },
    istanbul: { lat: 41.0, lng: 29.0 },
    novorossiysk: { lat: 44.7, lng: 37.8 },
    bar: { lat: 42.1, lng: 19.1 },
    koper: { lat: 45.6, lng: 13.7 },
    rijeka: { lat: 45.3, lng: 14.3 },
    split: { lat: 43.5, lng: 16.4 },
    dubrovnik: { lat: 42.7, lng: 18.1 },
    kotor: { lat: 42.4, lng: 18.8 },
    tivat: { lat: 42.4, lng: 18.7 },
    podgorica: { lat: 42.4, lng: 19.3 },
    belgrade: { lat: 44.8, lng: 20.5 },
    jeddah: { lat: 21.5, lng: 39.2 },
    colombo: { lat: 6.9, lng: 79.8 },
    durban: { lat: -29.9, lng: 31.0 },
    fremantle: { lat: -32.1, lng: 115.7 },
    valencia: { lat: 39.4, lng: -0.3 },
    genoa: { lat: 44.4, lng: 8.9 },
    piraeus: { lat: 37.9, lng: 23.6 },
    dakar: { lat: 14.7, lng: -17.4 },
    lagos: { lat: 6.4, lng: 3.4 },
    mombasa: { lat: -4.0, lng: 39.7 },
    djibouti: { lat: 11.6, lng: 43.1 },
    karachi: { lat: 24.8, lng: 66.9 },
    busan: { lat: 35.1, lng: 129.0 },
    tokyo: { lat: 35.6, lng: 139.8 },
    sydney: { lat: -33.9, lng: 151.2 },
    "buenos aires": { lat: -34.6, lng: -58.4 },
    callao: { lat: -12.0, lng: -77.1 },
    guayaquil: { lat: -2.2, lng: -79.9 },
    manila: { lat: 14.6, lng: 120.9 },
    jakarta: { lat: -6.1, lng: 106.9 },
    "ho chi minh": { lat: 10.7, lng: 106.8 },
    chittagong: { lat: 22.3, lng: 91.8 },
    "new york": { lat: 40.7, lng: -74.0 },
    "los angeles": { lat: 33.7, lng: -118.3 },
    panama: { lat: 9.0, lng: -79.5 },
    suez: { lat: 30.5, lng: 32.3 },
    constantza: { lat: 44.2, lng: 28.7 },
    auckland: { lat: -36.85, lng: 174.76 },
  };

  for (const [name, coords] of Object.entries(portMap)) {
    if (lower.includes(name) || name.includes(lower)) {
      return coords;
    }
  }

  return null;
}
