import { NextRequest, NextResponse } from "next/server";

/**
 * Simple in-memory rate limiter.
 *
 * Two tiers:
 *   1. Per-route limits — strict caps on sensitive endpoints (login,
 *      uploads, RFQs, password reset, code verification, …).
 *   2. Global limit — a generous ceiling on ALL /api/* routes per IP to
 *      blunt generic API abuse (scraping,枚举, fuzzing) on endpoints that
 *      don't have a specific cap.
 *
 * In production, use Redis or a proper rate-limiting service. The in-memory
 * Map here is per-instance (resets on cold start and is not shared across
 * horizontal replicas) but is sufficient as a defense-in-depth layer.
 */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

/**
 * Per-route limits. Keys are path *prefixes* — a request matches the longest
 * matching prefix, so `/api/products/abc` falls under `/api/products`.
 */
const RATE_LIMITS: Record<string, { maxRequests: number; windowMs: number }> = {
  // ── auth flows (pre-existing) ────────────────────────────────────────────
  "/api/auth/login": { maxRequests: 30, windowMs: 60_000 },            // 30/min
  "/api/portal/login": { maxRequests: 30, windowMs: 60_000 },         // 30/min
  "/api/setup": { maxRequests: 3, windowMs: 300_000 },               // 3/5min
  "/api/auth/logout": { maxRequests: 20, windowMs: 60_000 },          // 20/min

  // ── upload / KYC (slow, expensive, file-system side effects) ────────────
  "/api/portal/upload": { maxRequests: 10, windowMs: 60_000 },         // 10/min
  "/api/portal/kyc/document": { maxRequests: 10, windowMs: 60_000 },  // 10/min

  // ── read-heavy list endpoints (search / API access) ─────────────────────
  "/api/products": { maxRequests: 30, windowMs: 60_000 },             // 30/min
  "/api/offers": { maxRequests: 30, windowMs: 60_000 },               // 30/min
  "/api/invoices": { maxRequests: 30, windowMs: 60_000 },             // 30/min
  "/api/partners": { maxRequests: 30, windowMs: 60_000 },             // 30/min

  // ── portal write actions (prevent spam / abuse) ─────────────────────────
  "/api/portal/rfqs": { maxRequests: 5, windowMs: 60_000 },           // 5/min (RFQ spam)
  "/api/portal/messages": { maxRequests: 20, windowMs: 60_000 },      // 20/min

  // ── account recovery / verification ─────────────────────────────────────
  // SEC-L1: removed dead `/api/auth/forgot-password` entry — that route
  // does not exist (the CRM flow uses /api/auth/change-password; the
  // portal flow is at /api/portal/forgot-password which is rate-limited
  // on the next line). The stale entry was a no-op that gave a false
  // sense of coverage for a brute-force vector that the route didn't
  // actually present, AND would have silently failed to rate-limit a
  // future /api/auth/forgot-password implementation if one was added
  // because `findRouteConfig` longest-prefix matches by full path
  // segment (the dead key matched only the exact pathname).
  "/api/portal/forgot-password": { maxRequests: 3, windowMs: 60_000 },// 3/min (portal email flood)
  "/api/verify": { maxRequests: 10, windowMs: 60_000 },               // 10/min (code brute-force)
};

/**
 * Global ceiling — applied to every /api/* request that doesn't match a
 * specific cap above. Generous enough (100/min) that normal UI workflows
 * never hit it, but tight enough to stop a script scanning endpoints.
 */
const GLOBAL_LIMIT = { maxRequests: 100, windowMs: 60_000 };

function getRateLimitKey(path: string, ip: string): string {
  return `${path}:${ip}`;
}

function getIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    // Render's proxy appends the real client IP at the END of the chain.
    // The first value is attacker-controlled and must NOT be trusted.
    const parts = xff.split(",").map(s => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return req.headers.get("x-real-ip") || "unknown";
}

// Clean up expired entries every 5 minutes
let lastCleanup = Date.now();

/**
 * Hard cap on the rate-limit Map's size. Without this, the Map can grow
 * without bound under sustained traffic from many distinct IPs (DDoS,
 * scraper botnet, cloud egress) — the 5-minute cleanup interval only
 * runs on a request boundary, so between cleanups the Map keeps every
 * distinct `path:ip` key it has seen. A single render.com instance has
 * ~512MB RAM; at ~80 bytes per Map entry, 10k entries is ~800KB —
 * negligible — but 1M entries is ~80MB which starts to matter. The cap
 * below is deliberately generous (10k) so it never trips in normal
 * traffic, but kicks in BEFORE memory becomes a concern.
 */
const MAX_RATE_LIMIT_ENTRIES = 10_000;

function cleanupIfNeeded() {
  const now = Date.now();
  // Time-based cleanup: every 5 minutes, sweep expired entries.
  if (now - lastCleanup > 5 * 60_000) {
    for (const [key, val] of rateLimitMap) {
      if (val.resetAt < now) rateLimitMap.delete(key);
    }
    lastCleanup = now;
  }
  // Size-based cleanup (P2 / task C-6 Fix 3): if the Map has grown past
  // the cap between scheduled sweeps (a burst of distinct IPs inside 5
  // minutes), force a sweep NOW. If even that doesn't free enough (all
  // entries are still inside their window), evict the oldest 50% by
  // resetAt — we'd rather drop rate-limit state for some clients than
  // let the Map consume unbounded memory.
  if (rateLimitMap.size > MAX_RATE_LIMIT_ENTRIES) {
    for (const [key, val] of rateLimitMap) {
      if (val.resetAt < now) rateLimitMap.delete(key);
    }
    if (rateLimitMap.size > MAX_RATE_LIMIT_ENTRIES) {
      const entries = [...rateLimitMap.entries()].sort(
        (a, b) => a[1].resetAt - b[1].resetAt,
      );
      const evictCount = Math.floor(entries.length / 2);
      for (let i = 0; i < evictCount; i++) {
        rateLimitMap.delete(entries[i][0]);
      }
      console.warn(
        `[rate-limit] Map exceeded ${MAX_RATE_LIMIT_ENTRIES} entries ` +
          `(${rateLimitMap.size + evictCount} before eviction); ` +
          `evicted oldest ${evictCount} entries by resetAt. ` +
          `This indicates sustained traffic from many distinct IPs — ` +
          `consider Redis-backed rate limiting for production scale.`,
      );
    }
    lastCleanup = now;
  }
}

/**
 * Find the most specific rate-limit config for a path. Returns the matching
 * prefix key + config, or null if no specific rule applies.
 *
 * Matches longest-prefix-first so `/api/products/export` is governed by
 * `/api/products` (not, say, `/api`).
 */
function findRouteConfig(pathname: string): { key: string; config: { maxRequests: number; windowMs: number } } | null {
  // Exact match wins outright.
  if (RATE_LIMITS[pathname]) {
    return { key: pathname, config: RATE_LIMITS[pathname] };
  }
  // Otherwise longest-prefix match.
  let bestKey: string | null = null;
  for (const prefix of Object.keys(RATE_LIMITS)) {
    if (pathname.startsWith(prefix + "/")) {
      if (!bestKey || prefix.length > bestKey.length) {
        bestKey = prefix;
      }
    }
  }
  if (bestKey) return { key: bestKey, config: RATE_LIMITS[bestKey] };
  return null;
}

function tooManyRequests(resetAt: number): NextResponse {
  const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  return NextResponse.json(
    { error: "Too many requests. Please try again later." },
    { status: 429, headers: { "Retry-After": String(retryAfter) } }
  );
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const ip = getIp(req);
  const now = Date.now();

  // ── Capture external host for AI relay auto-configuration ──────────────
  // Fire-and-forget — pings /api/capture-host which writes the external
  // Host header to /tmp/discovered-host.txt. Only runs on the sandbox
  // (skipped on Vercel). Non-blocking so it doesn't add latency.
  //
  // Audit H3 fix: previously this fired on EVERY non-Vercel request, adding
  // a fetch() to /api/capture-host on every page/API load. Now gated
  // behind SANDBOX_HOST_CAPTURE=1 so it only runs when the sandbox
  // auto-discovery is explicitly enabled. Production (Vercel) already
  // skipped it via the VERCEL check.
  if (process.env.VERCEL !== "1" && process.env.SANDBOX_HOST_CAPTURE === "1") {
    try {
      const extHost = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
      const extProto = req.headers.get("x-forwarded-proto") || "https";
      if (extHost && !extHost.startsWith("localhost") && !extHost.startsWith("127.")) {
        const captureUrl = new URL("/api/capture-host", req.url);
        captureUrl.searchParams.set("h", extHost);
        captureUrl.searchParams.set("p", extProto);
        fetch(captureUrl.toString(), { method: "GET" }).catch(() => {});
      }
    } catch {}
  }

  cleanupIfNeeded();

  // ── 1. Specific route limit ─────────────────────────────────────────────
  const route = findRouteConfig(pathname);
  if (route) {
    const key = getRateLimitKey(route.key, ip);
    const entry = rateLimitMap.get(key);
    if (!entry || entry.resetAt < now) {
      rateLimitMap.set(key, { count: 1, resetAt: now + route.config.windowMs });
      return NextResponse.next();
    }
    entry.count++;
    if (entry.count > route.config.maxRequests) {
      return tooManyRequests(entry.resetAt);
    }
    return NextResponse.next();
  }

  // ── 2. Global API ceiling (any other /api/* route) ──────────────────────
  // Applies to every /api/* request that didn't match a specific rule above.
  // Belt-and-braces against generic endpoint scraping / enumeration.
  const globalKey = `global:${ip}`;
  const globalEntry = rateLimitMap.get(globalKey);
  if (!globalEntry || globalEntry.resetAt < now) {
    rateLimitMap.set(globalKey, { count: 1, resetAt: now + GLOBAL_LIMIT.windowMs });
    return NextResponse.next();
  }
  globalEntry.count++;
  if (globalEntry.count > GLOBAL_LIMIT.maxRequests) {
    return tooManyRequests(globalEntry.resetAt);
  }

  return NextResponse.next();
}

// Run on ALL routes (pages + API). The rate limiter only applies to /api/*
// (checked via pathname inside the function). The host capture runs on
// every request so we can discover the sandbox's external URL.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon|sw\\.js|manifest).*)"],
};

