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
