/**
 * IP geolocation utility.
 *
 * Resolves an IP address to a country (and a few other geographic fields)
 * using the free `ipapi.co` API. Results are cached in-memory for one hour.
 *
 * Failures are non-fatal: every call returns a `GeoData` object whose fields
 * are `null` on error, so login / audit flows never break when the lookup
 * service is unavailable or rate-limited.
 *
 * Free tier: ~1000 requests/day per source IP — fine for back-office logins
 * because we cache every unique IP for an hour.
 */

export interface GeoData {
  country: string | null;
  city: string | null;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
}

const EMPTY_GEO: GeoData = {
  country: null,
  city: null,
  region: null,
  latitude: null,
  longitude: null,
};

// In-memory cache (1 hour TTL). Keyed by IP.
const cache = new Map<string, { data: GeoData; expiresAt: number }>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Sentinel "no geo" entries (loopback / private / lookup-failed) are cached
// with a shorter TTL so a transient failure doesn't pin null for an hour.
const NEGATIVE_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function isLoopbackOrPrivate(ip: string): boolean {
  if (!ip) return true;
  if (ip === "unknown" || ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return true;
  // Private IPv4 ranges (10.x, 172.16-31.x, 192.168.x)
  const v4 = ip.split(":").pop() || ip; // strip IPv6 prefix
  const parts = v4.split(".");
  if (parts.length === 4) {
    const [a, b] = parts.map(Number);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
  }
  return false;
}

/**
 * Look up geographic data for a single IP address.
 *
 * Uses ipapi.co (free, no API key required, ~1000 requests/day).
 * Falls back to `null` country if the API is unavailable.
 */
export async function lookupIp(ip: string): Promise<GeoData> {
  if (!ip || ip === "unknown" || isLoopbackOrPrivate(ip)) {
    return { ...EMPTY_GEO };
  }

  const now = Date.now();
  const cached = cache.get(ip);
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  try {
    // 5 second timeout — geo lookup must never block a login.
    // AbortSignal.timeout is supported on Node 17.3+ (the project requires Node 18+).
    const res = await fetch(`https://ipapi.co/${ip}/json/`, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      country_name?: string;
      country?: string;
      city?: string;
      region?: string;
      latitude?: number;
      longitude?: number;
      error?: boolean;
      reason?: string;
    };

    // ipapi.co returns 200 with { error: true, reason: "..." } for reserved IPs.
    if (data && data.error) {
      throw new Error(data.reason || "ipapi.co error");
    }

    const geo: GeoData = {
      country: data.country_name || data.country || null,
      city: data.city || null,
      region: data.region || null,
      latitude: typeof data.latitude === "number" ? data.latitude : null,
      longitude: typeof data.longitude === "number" ? data.longitude : null,
    };

    cache.set(ip, { data: geo, expiresAt: now + CACHE_TTL });
    return geo;
  } catch (e) {
    // Silently fail — don't block login if geo lookup fails.
    // Cache the negative result briefly so we don't hammer the API on retries.
    console.warn("[geo-ip] lookup failed for", ip, ":", e instanceof Error ? e.message : e);
    cache.set(ip, { data: { ...EMPTY_GEO }, expiresAt: now + NEGATIVE_CACHE_TTL });
    return { ...EMPTY_GEO };
  }
}

/**
 * Batch lookup for multiple IPs (for admin views).
 *
 * Limits concurrency to 5 parallel requests to stay friendly with the upstream
 * API. Returns a Map keyed by the original IP string.
 */
export async function lookupIpBatch(ips: string[]): Promise<Map<string, GeoData>> {
  const results = new Map<string, GeoData>();
  const uniqueIps = [...new Set(ips)].filter(
    (ip) => ip && ip !== "unknown" && !isLoopbackOrPrivate(ip)
  );

  const batchSize = 5;
  for (let i = 0; i < uniqueIps.length; i += batchSize) {
    const batch = uniqueIps.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (ip) => {
        const geo = await lookupIp(ip);
        results.set(ip, geo);
      })
    );
  }

  return results;
}

/**
 * Convenience wrapper: returns just the country name (or null).
 * Useful when callers don't care about city/region/coords.
 */
export async function lookupCountry(ip: string): Promise<string | null> {
  const geo = await lookupIp(ip);
  return geo.country;
}

/**
 * Clear the geo-ip cache. Useful for tests.
 */
export function clearGeoIpCache(): void {
  cache.clear();
}

// ─── GPS-coordinate validation (audit 8a-3 / 8b-1) ────────────────────────
//
// Both the CRM `/api/verify/[code]` route and the Portal `/api/portal/log-location`
// route implemented a "GPS gate" as a security control — non-premium clients
// must share their geolocation before they can read portal data / full
// document payloads. Both gates trusted client-supplied `latitude` / `longitude`
// values without validating they were real or near the IP-derived location, so
// `curl ... -d '{"latitude":0,"longitude":0,"source":"browser"}'` bypassed
// the gate entirely.
//
// This helper performs the shared validation logic:
//   1. Coords must be finite numbers in the valid lat/lng range.
//   2. Caller must claim `source === "browser"` (IP-only fixes don't count).
//   3. If we have IP-derived geo, the supplied coords must be within
//      `MAX_DEVIATION_KM` of the IP location. A larger gap almost always means
//      the client is lying (or using a VPN — out-of-scope for non-premium
//      gate, the IP itself gets logged for forensic review).
//   4. (0, 0) is the Atlantic Ocean off the African coast — even if it passes
//      the range check, we reject it because that's the textbook "browser
//      denied geolocation" fallback the client hook sends.

export const GPS_GATE_MAX_DEVIATION_KM = 500; // 500 km — generous to allow ISP-city imprecision + VPN edge

export interface GpsValidationResult {
  valid: boolean;
  reason?: "not_browser" | "out_of_range" | "zero_zero" | "too_far_from_ip" | "non_finite";
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // km
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Validate that client-supplied GPS coordinates are plausibly real for the
 * caller's IP. Async because it calls `lookupIp` for the distance check.
 *
 * Returns `valid: true` ONLY when all checks pass. Callers MUST ignore the
 * coordinates (treat them as a null `latitude`/`longitude` row) when
 * `valid === false`, and SHOULD log the failure reason into the row's
 * `details` JSON for forensic review (without exposing it to the client).
 */
export async function validateGpsAgainstIp(
  ip: string,
  latitude: unknown,
  longitude: unknown,
  claimedSource: unknown,
): Promise<GpsValidationResult> {
  if (claimedSource !== "browser") {
    return { valid: false, reason: "not_browser" };
  }
  if (typeof latitude !== "number" || typeof longitude !== "number" ||
      !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { valid: false, reason: "non_finite" };
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return { valid: false, reason: "out_of_range" };
  }
  // (0, 0) is the textbook "browser denied geolocation" fallback that the
  // Portal `use-geolocation` hook sends as the placeholder value.
  if (latitude === 0 && longitude === 0) {
    return { valid: false, reason: "zero_zero" };
  }
  // Distance-check vs IP-derived geo — failure tolerant (we don't have geo for
  // loopback/private IPs, and the upstream API may be down; in those cases we
  // accept the coords, but they're still logged for forensic review).
  try {
    const geo = await lookupIp(ip);
    if (geo.latitude != null && geo.longitude != null) {
      const dist = haversineKm(latitude, longitude, geo.latitude, geo.longitude);
      if (dist > GPS_GATE_MAX_DEVIATION_KM) {
        return { valid: false, reason: "too_far_from_ip" };
      }
    }
  } catch {
    // Non-fatal — fall through to "valid" so an upstream outage doesn't lock
    // out legitimate users. The (0,0) + range + source-browser checks above
    // already close the trivial bypass vectors.
  }
  return { valid: true };
}
