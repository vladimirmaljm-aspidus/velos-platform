import { NextRequest, NextResponse } from "next/server";
import { getIp } from "@/lib/utils/ip";

/**
 * Rate limiting — a THREE-layer model (audit 4-a P0-1 closed).
 *
 *   L1 — in-memory, ALL /api/* (this file). Per-route caps + a global
 *        per-IP ceiling, O(1) Map, zero network cost. Per-instance: on
 *        Vercel serverless each lambda invocation can land on a fresh
 *        instance, so this layer alone is evadable by rotating instances
 *        (the original P0-1 finding).
 *
 *   L2 — DB-backed, auth-critical surface only (this file). A shared
 *        `rate_limits` counter (Supabase `check_rate_limit` RPC, migration
 *        024) keyed `mw:auth:<ip>`, checked AFTER L1 passes. The counter
 *        lives in Postgres, so it is shared by EVERY serverless instance
 *        and survives cold starts — rotating lambdas no longer resets the
 *        budget. The auth surface gets this layer because it is where
 *        brute-force / enumeration damage is irreversible and where the
 *        route-level guards (L3) are the real, precise caps — L2 is the
 *        coarse outer net for distributed abuse that L1 cannot see.
 *
 *   L3 — DB-backed, inside the route handlers (audit 6-a / 29 fixes).
 *        The precise per-route guards: login per-IP/per-user/super_admin
 *        throttle, verify POST 20/5min, 2FA TOTP replay markers, portal
 *        per-IP, and the DB-configured caps from /api/settings/rate-limits.
 *        These remain the authoritative limits; L2 is deliberately
 *        generous (60/5min) so it only ever catches scripted abuse.
 *
 * L1 detail: two tiers within the in-memory layer:
 *   1. Per-route limits — strict caps on sensitive endpoints (login,
 *      uploads, RFQs, password reset, code verification, …).
 *   2. Global limit — a generous ceiling on ALL /api/* routes per IP to
 *      blunt generic API abuse (scraping, 枚举, fuzzing) on endpoints that
 *      don't have a specific cap.
 *
 * For non-auth /api/* traffic, L1 remains per-instance — acceptable, since
 * that traffic is not credential-abuse-shaped and a Redis/service limiter
 * can replace the Map later without changing the layer contract.
 */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

/**
 * Per-route limits. Keys are path *prefixes* — a request matches the longest
 * matching prefix, so `/api/products/abc` falls under `/api/products`.
 *
 * ─── Audit finding 8a-13: this object is the STATIC DEFAULT layer only.
 *
 * Against the three-layer model above, the caps here are L1; they are
 * layered NARROWLY against the route-level (L3) DB-CONFIGURED caps:
 *
 *   1. THIS layer — `RATE_LIMITS_DEFAULT` below, optionally overridden
 *      at deploy time via the `RATE_LIMIT_OVERRIDE_JSON` env var (see
 *      `buildRateLimits()`). This is the OUTERMOST backstop: a coarse,
 *      in-memory, per-instance cap whose only job is to blunt generic
 *      API abuse (scripted enumeration, scraping, fuzzing) before the
 *      request reaches the route handler. It is intentionally
 *      conservative — generous enough that no normal UI workflow ever
 *      trips it.
 *
 *   2. THE DB-CONFIGURED layer (L3) — `/api/settings/rate-limits`
 *      (managed by super_admin via the platform-config panel). Route
 *      handlers that need a tighter, tenant-aware, or per-user cap than
 *      the middleware provides query this endpoint at runtime and apply
 *      a SECOND check on top of the middleware's verdict. Because it
 *      sits ABOVE the middleware layers, it can only NARROW the cap
 *      (e.g. tighten 30/min → 10/min for a specific tenant); it can
 *      never WIDEN it. A request the middleware 429s (at L1 or L2)
 *      never reaches the DB-configured layer.
 *
 * The split keeps the hot path cheap: the middleware Map is O(1), no
 * DB round-trip, no auth required. The DB layer is only consulted by
 * the small set of routes whose policy needs to differ per-tenant or
 * per-user (auth flows, billing, exports). The env-var override on
 * layer 1 lets operators ship an urgent cap-tightening without a
 * redeploy — set `RATE_LIMIT_OVERRIDE_JSON`, restart the process,
 * done. It is NOT a substitute for the DB layer: it is per-instance,
 * not per-tenant, and not auth-aware.
 */
const RATE_LIMITS_DEFAULT: Record<string, { maxRequests: number; windowMs: number }> = {
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
 * Build the effective per-route rate-limit map by deep-merging the
 * `RATE_LIMIT_OVERRIDE_JSON` env var (if present and valid) over
 * `RATE_LIMITS_DEFAULT`. The override can replace existing entries
 * OR add new path caps — operators use the latter to ship an urgent
 * cap-tightening on a route the defaults don't yet cover without
 * waiting for a redeploy.
 *
 * Validation is STRICT and FAIL-OPEN to defaults on any error:
 *   • key must be a string starting with `/`
 *   • value must be `{ maxRequests, windowMs }` where both are
 *     Number.isInteger AND Number.isFinite AND > 0
 *   • `JSON.parse` is wrapped in try/catch — invalid JSON is treated
 *     as "no override" (a warning is logged) so a typo'd env var
 *     cannot take the entire middleware offline.
 *
 * Memoized at module-init time — `RATE_LIMITS` below is computed
 * exactly once per process so the JSON parse + validation overhead
 * never lands on the hot path.
 */
function buildRateLimits(): Record<string, { maxRequests: number; windowMs: number }> {
  const merged: Record<string, { maxRequests: number; windowMs: number }> = { ...RATE_LIMITS_DEFAULT };
  const raw = process.env.RATE_LIMIT_OVERRIDE_JSON;
  if (!raw) return merged;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // Invalid JSON in env var → log + fall back to defaults. The
    // middleware must NEVER crash on a config error: fail-open to the
    // static defaults rather than 500 every request.
    console.warn(
      "[rate-limit] RATE_LIMIT_OVERRIDE_JSON is set but failed to parse — ignoring override.",
      e instanceof Error ? e.message : String(e),
    );
    return merged;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn("[rate-limit] RATE_LIMIT_OVERRIDE_JSON must be a JSON object — ignoring override.");
    return merged;
  }
  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof key !== "string" || !key.startsWith("/")) continue; // strict: only path keys
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;
    const cfg = val as Record<string, unknown>;
    const maxRequests = Number(cfg.maxRequests);
    const windowMs = Number(cfg.windowMs);
    if (
      !Number.isFinite(maxRequests) || !Number.isInteger(maxRequests) || maxRequests <= 0
      || !Number.isFinite(windowMs) || !Number.isInteger(windowMs) || windowMs <= 0
    ) {
      continue; // silently skip — one bad entry shouldn't kill the rest
    }
    // Override (if key exists) or add (new path cap). findRouteConfig's
    // longest-prefix logic will route correctly either way.
    merged[key] = { maxRequests, windowMs };
  }
  return merged;
}

// Memoized effective rate-limit map. Computed once at module init.
const RATE_LIMITS: Record<string, { maxRequests: number; windowMs: number }> = buildRateLimits();

/**
 * Global ceiling — applied to every /api/* request that doesn't match a
 * specific cap above. Generous enough (100/min) that normal UI workflows
 * never hit it, but tight enough to stop a script scanning endpoints.
 */
const GLOBAL_LIMIT = { maxRequests: 100, windowMs: 60_000 };

function getRateLimitKey(path: string, ip: string): string {
  return `${path}:${ip}`;
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

// ═══════════════════════════════════════════════════════════════════════════
// L2 — DB-backed rate limit for the auth-critical surface (audit 4-a P0-1).
// Checked AFTER the in-memory L1 lets a request through; the counter lives
// in the shared `rate_limits` table so it is global across every serverless
// instance (per-instance Map rotation can no longer reset the budget).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Auth-critical surface, derived from the actual API tree (src/app/api):
 *
 *   • /api/auth/*        — login, register (the ONLY register flow — there
 *                          is no top-level /api/register), logout,
 *                          logout-all, me, touch (session heartbeat),
 *                          change-password, 2fa/{login,enroll,verify,
 *                          disable,recovery}
 *   • /api/portal/login  — portal partner authentication
 *   • /api/verify/*      — public document verification. Its POST already
 *                          has a precise in-route DB limit (20/5min, audit
 *                          6-a M6); the middleware adds a coarse outer
 *                          cap for it and for the (unlimited in-route)
 *                          GETs.
 */
function isAuthCriticalPath(pathname: string): boolean {
  return (
    pathname === "/api/auth" ||
    pathname.startsWith("/api/auth/") ||
    pathname === "/api/portal/login" ||
    pathname.startsWith("/api/portal/login/") ||
    pathname === "/api/verify" ||
    pathname.startsWith("/api/verify/")
  );
}

/**
 * L2 cap — deliberately generous: 60 requests per rolling 5-minute window
 * per IP, one shared bucket for the whole auth surface. A normal user
 * issues only a handful of auth-surface requests per 5 minutes (the
 * session heartbeat POSTs /api/auth/touch every 5 min; login, 2FA, logout
 * are one-offs), so this can only be reached by scripted abuse. The
 * precise, much tighter per-route DB limits (login 20/15min, verify
 * 20/5min, portal per-IP, …) live INSIDE the route handlers (L3) and
 * remain the real guards.
 */
const AUTH_DB_LIMIT = { maxAttempts: 60, windowMs: 5 * 60_000 };

/** Bucket key prefix for the L2 layer — shared across ALL instances. */
const AUTH_DB_BUCKET_PREFIX = "mw:auth";

/**
 * Hard timeout for the L2 RPC fetch. The middleware sits on the hot path
 * of EVERY request, so a slow/hung Supabase must never stall the chain —
 * the fetch is aborted and the check fails open.
 */
const AUTH_DB_TIMEOUT_MS = 1_500;

/**
 * L2 check — one plain `fetch()` to the Supabase REST RPC endpoint.
 *
 * Why plain fetch instead of importing `checkRateLimit` from
 * src/lib/security/rate-limiter.ts: that helper pulls in
 * @supabase/supabase-js (via lib/supabase/client), a heavy node-oriented
 * dependency graph that does not belong in the edge-runtime middleware
 * bundle. We therefore inline the EXACT same RPC contract here (mirroring
 * the lib): POST {SUPABASE_URL}/rest/v1/rpc/check_rate_limit with the
 * parameters `p_key` / `p_max_attempts` / `p_window_ms` (migration 024)
 * and the service-role key in the `apikey` + `Authorization: Bearer`
 * headers — the same header pair supabase-js sends on `.rpc()` calls.
 *
 * Semantics copied from the lib (and its fail-open philosophy):
 *   • shared `rate_limits` row (UNIQUE key) → atomic single-statement
 *     UPSERT increment, race-free across concurrent lambda invocations;
 *   • FAIL-OPEN on every error shape (non-2xx HTTP, malformed payload,
 *     network error, timeout): rate limiting is defense-in-depth, not
 *     the primary auth gate — failing closed would lock every user out
 *     of the auth surface during a transient DB outage;
 *   • feature-detect: if SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are
 *     absent (local dev, self-hosted, DB_BACKEND=mock) the DB call is
 *     skipped entirely (L1 only) — the middleware must never crash on
 *     configuration.
 *
 * @param ip Client IP, extracted exactly the way the middleware already
 *           does it (getIp() from lib/utils/ip — Vercel-trusted headers).
 * @returns  A 429 NextResponse when the IP exceeded the shared bucket
 *           (mirroring the middleware's existing 429 shape exactly), or
 *           null when the request may proceed (allowed, or fail-open).
 */
async function checkAuthDbLimit(ip: string): Promise<NextResponse | null> {
  // ── Feature-detect: no Supabase env → L1 only, no DB round-trip. ────────
  const baseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceKey) return null;

  // AbortController so a slow DB can never stall the middleware chain.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_DB_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${baseUrl.replace(/\/+$/, "")}/rest/v1/rpc/check_rate_limit`,
      {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
        },
        // Same parameter names/types as the RPC (migration 024):
        // check_rate_limit(p_key TEXT, p_max_attempts INTEGER, p_window_ms BIGINT)
        body: JSON.stringify({
          p_key: `${AUTH_DB_BUCKET_PREFIX}:${ip}`,
          p_max_attempts: AUTH_DB_LIMIT.maxAttempts,
          p_window_ms: AUTH_DB_LIMIT.windowMs,
        }),
        signal: controller.signal,
      },
    );

    if (!res.ok) {
      // RPC not installed (migration 024 not applied), auth failure, or a
      // 5xx → FAIL-OPEN: L1 is still in front, the in-route L3 guards are
      // still behind. Log loudly so ops sees the limiter is degraded.
      console.error(
        `[middleware] L2 auth rate-limit RPC returned HTTP ${res.status} — failing open.`,
      );
      return null;
    }

    // PostgREST serialises the RPC's RETURNS TABLE as a JSON array of rows
    // (the same shape supabase-js surfaces from .rpc() — see rate-limiter.ts);
    // accept both array and single-object shapes to be safe.
    const payload: unknown = await res.json();
    const row: unknown = Array.isArray(payload) ? payload[0] : payload;
    if (!row || typeof row !== "object") {
      console.error(
        "[middleware] L2 auth rate-limit RPC returned an unexpected payload — failing open.",
      );
      return null;
    }
    const fields = row as Record<string, unknown>;
    const allowed = fields.allowed;
    if (typeof allowed !== "boolean") {
      console.error(
        "[middleware] L2 auth rate-limit RPC row has no boolean 'allowed' — failing open.",
      );
      return null;
    }
    if (allowed) return null;

    // ── Limit exceeded → 429, same shape as the L1 429s. ──────────────────
    // resetAt = window_start + window. If window_start is unusable, fall
    // back to "full window from now" (an upper bound — never under-sets
    // Retry-After… see tooManyRequests' Math.max(1, …) clamp).
    const startMs =
      typeof fields.window_start === "string" ? Date.parse(fields.window_start) : Number.NaN;
    const resetAt = Number.isFinite(startMs)
      ? startMs + AUTH_DB_LIMIT.windowMs
      : Date.now() + AUTH_DB_LIMIT.windowMs;
    return tooManyRequests(resetAt);
  } catch (e) {
    // AbortController timeout, DNS failure, network error → FAIL-OPEN.
    // Same rationale as src/lib/security/rate-limiter.ts: rate limiting is
    // defense-in-depth; the primary auth gates (passwords, lockouts, L3
    // in-route limits) are unaffected by this layer being unavailable.
    console.error("[middleware] L2 auth rate-limit check failed — failing open:", e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Async because the L2 check (DB-backed, auth surface only) is awaited —
// Next.js middleware supports returning a Promise<NextResponse>.
export async function middleware(req: NextRequest): Promise<NextResponse> {
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

  // ── 0. Pages are NEVER rate-limited ─────────────────────────────────────
  // UX P0 (audit26): the global ceiling below used to count PAGE navigations
  // (/portal/dashboard, /, …) toward the per-IP API budget. When a user
  // browsed pages quickly (or an SPA reloaded repeatedly) the middleware
  // returned a raw JSON 429 for a PAGE request — the browser rendered
  // `{"error":"Too many requests..."}` with its built-in JSON viewer instead
  // of the app. Rate limiting only ever makes sense for /api/* requests.
  if (!pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  // ── 1. L1: specific route limit (in-memory, per-instance) ───────────────
  const route = findRouteConfig(pathname);
  if (route) {
    const key = getRateLimitKey(route.key, ip);
    const entry = rateLimitMap.get(key);
    if (!entry || entry.resetAt < now) {
      rateLimitMap.set(key, { count: 1, resetAt: now + route.config.windowMs });
    } else {
      entry.count++;
      if (entry.count > route.config.maxRequests) {
        return tooManyRequests(entry.resetAt);
      }
    }
  } else {
    // ── 2. L1: global API ceiling (any other /api/* route) ────────────────
    // Applies to every /api/* request that didn't match a specific rule
    // above. Belt-and-braces against generic endpoint scraping /
    // enumeration.
    const globalKey = `global:${ip}`;
    const globalEntry = rateLimitMap.get(globalKey);
    if (!globalEntry || globalEntry.resetAt < now) {
      rateLimitMap.set(globalKey, { count: 1, resetAt: now + GLOBAL_LIMIT.windowMs });
    } else {
      globalEntry.count++;
      if (globalEntry.count > GLOBAL_LIMIT.maxRequests) {
        return tooManyRequests(globalEntry.resetAt);
      }
    }
  }

  // ── 3. L2: DB-backed check for the auth-critical surface ────────────────
  // Only reached AFTER L1 (per-instance) has let the request through. The
  // shared `rate_limits` row makes this counter GLOBAL across all serverless
  // instances, closing the instance-rotation evasion of P0-1: an attacker
  // landing on a fresh lambda (fresh L1 Map) still hits the same DB bucket.
  // Non-auth /api/* traffic never pays the DB round-trip.
  if (isAuthCriticalPath(pathname)) {
    const blocked = await checkAuthDbLimit(ip);
    if (blocked) return blocked;
  }

  return NextResponse.next();
}

// Run on ALL routes (pages + API). The rate limiter only applies to /api/*
// (checked via pathname inside the function). The host capture runs on
// every request so we can discover the sandbox's external URL.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon|sw\\.js|manifest).*)"],
};

