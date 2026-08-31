import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type { AuthContext } from "@/lib/api/helpers";
import type { User } from "@/lib/supabase/types";

// 11-B-v2 / 9b-N13: route-level tests for the dashboard rate-limit gate
// on src/app/api/dashboard/route.ts + src/app/api/dashboard/charts/route.ts.
//
// Covers:
//   1. 60 GET requests from same IP → all pass the rate-limit gate (200 or
//      401 — either is fine; the rate-limit gate must NOT block them).
//   2. 61st GET from same IP → 429 + Retry-After header.
//   3. Different IP → counter resets, requests pass through again.
//   4. Same for /api/dashboard/charts.
//
// Mocking strategy:
//   • `@/lib/security/rate-limiter` `checkRateLimit` is replaced with a
//     real in-memory per-IP counter (mirrors the source's DB-backed impl
//     for the in-window increment + cap logic) so we can drive it through
//     the 60/61 boundary without DB round-trips. The Map key is the
//     rate-limit key the route passes in (`dashboard:ip:<ip>`).
//   • `@/lib/api/helpers` `requireAuthOrApiKey` returns a 401 NextResponse
//     (no auth) — case 1 in the prompt explicitly allows 401 here; we
//     just want to assert the rate-limit gate LET the request through to
//     the auth stage. `requireAuthOrApiKeyPermission` returns null (no
//     denial). `resolveTenantId` returns null. `getIp` reads the
//     `cf-connecting-ip` header (real impl) so the per-IP key changes
//     when we vary the IP across cases.
//   • `@/lib/monitoring/apm` `withApm` is a pass-through `(fn) => fn` so
//     the charts route's wrapped GET is directly callable.
//   • No store mock needed — the rate limit fires BEFORE the store call,
//     and unauthenticated requests 401 before reaching getInsights() /
//     getDashboardCharts().

const MAX_REQUESTS = 60;
const WINDOW_MS = 60_000;

// In-memory rate-limit fake (mirrors the source's atomic UPSERT logic
// closely enough to drive the 60→61 boundary + the per-IP scoping tests).
const rateBuckets = new Map<string, { count: number; windowStart: number }>();

function fakeCheckRateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    bucket = { count: 0, windowStart: now };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > max) {
    const retryAfter = Math.max(1000, bucket.windowStart + windowMs - now);
    return Promise.resolve({
      allowed: false,
      remaining: 0,
      retryAfter,
      count: bucket.count,
    });
  }
  return Promise.resolve({
    allowed: true,
    remaining: max - bucket.count,
    count: bucket.count,
  });
}

const { mockRequireAuthOrApiKey, mockRequireAuthOrApiKeyPermission, mockResolveTenantId, mockGetIp } = vi.hoisted(() => ({
  mockRequireAuthOrApiKey: vi.fn(),
  mockRequireAuthOrApiKeyPermission: vi.fn(() => null),
  mockResolveTenantId: vi.fn(() => null),
  mockGetIp: vi.fn(),
}));

vi.mock("@/lib/security/rate-limiter", () => ({
  // Real-ish in-memory impl — driven by the source's own (key, max, window)
  // triplet. Map key includes the IP the route derived from `getIp(req)`,
  // so different IPs land in different buckets.
  checkRateLimit: vi.fn((key: string, max: number, windowMs: number) =>
    fakeCheckRateLimit(key, max, windowMs),
  ),
  resetRateLimit: vi.fn(async () => {}),
}));

vi.mock("@/lib/api/helpers", () => ({
  requireAuthOrApiKey: mockRequireAuthOrApiKey,
  requireAuthOrApiKeyPermission: mockRequireAuthOrApiKeyPermission,
  resolveTenantId: mockResolveTenantId,
  getIp: mockGetIp,
  sanitizeError: vi.fn((e: unknown) => String(e)),
}));

vi.mock("@/lib/monitoring/apm", () => ({
  withApm: vi.fn(<T extends (...args: unknown[]) => unknown>(fn: T): T => fn),
}));

import { GET as dashboardGET } from "@/app/api/dashboard/route";
import { GET as chartsGET } from "@/app/api/dashboard/charts/route";

// ── Test fixtures ────────────────────────────────────────────────────────

function makeReq(ip: string, path = "/api/dashboard"): NextRequest {
  return new NextRequest(new Request(`http://localhost${path}`, {
    method: "GET",
    headers: { "cf-connecting-ip": ip },
  }));
}

function makeUser(over: Partial<User> = {}): User {
  return {
    id: "u-1",
    tenant_id: "tenant-A",
    username: "alice",
    email: "alice@example.com",
    full_name: null,
    role: "user",
    permissions: ["dashboard.read"],
    password_hash: "x",
    totp_secret: null,
    totp_enabled: false,
    recovery_codes: null,
    locked_until: null,
    failed_attempts: 0,
    last_login_at: null,
    last_login_ip: null,
    last_login_country: null,
    must_change_password: false,
    token_version: 0,
    signature: null,
    notif_prefs: null,
    active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  } as User;
}

function makeAuthCtx(): AuthContext {
  const user = makeUser();
  return {
    user: {
      id: user.id,
      tenant_id: user.tenant_id,
      username: user.username,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
      permissions: user.permissions,
      active: user.active,
    } as any,
    store: { getInsights: vi.fn(async () => ({ totalRevenue: 0 })) } as any,
    ip: "1.2.3.4",
    tenantId: user.tenant_id,
    isSuperAdmin: false,
    impersonation: undefined,
  };
}

describe("/api/dashboard GET — per-IP rate limit (9b-N13)", () => {
  beforeEach(() => {
    rateBuckets.clear();
    mockRequireAuthOrApiKey.mockReset();
    mockRequireAuthOrApiKeyPermission.mockReset();
    mockResolveTenantId.mockReset();
    mockGetIp.mockReset();

    // Default: getIp reads from the cf-connecting-ip header (real impl
    // behaviour — the source route passes `req` to `getIp`). Auth
    // returns 401 (no auth) so each rate-limit-passing request 401s
    // without ever reaching the store layer.
    mockGetIp.mockImplementation((req?: any) => {
      const ip = req?.headers?.get?.("cf-connecting-ip");
      return ip || "0.0.0.0";
    });
    mockRequireAuthOrApiKey.mockResolvedValue(
      NextResponse.json({ error: "Not authenticated." }, { status: 401 }),
    );
    mockRequireAuthOrApiKeyPermission.mockReturnValue(null);
    mockResolveTenantId.mockReturnValue(null);
  });

  // ── 1. 60 GETs from same IP → all pass the rate-limit gate ─────────
  it("lets the first 60 GETs from the same IP pass the rate-limit gate (9b-N13)", async () => {
    const ip = "1.2.3.4";
    for (let i = 0; i < MAX_REQUESTS; i++) {
      const res = await dashboardGET(makeReq(ip));
      // 401 is fine — the prompt says "either 200 or 401". The key
      // assertion is that the rate-limit gate did NOT 429 these.
      expect(res.status).not.toBe(429);
      expect(res.status).toBe(401); // unauthenticated — reached the auth gate
    }
  });

  // ── 2. 61st GET from same IP → 429 + Retry-After ────────────────────
  it("returns 429 + Retry-After on the 61st GET from the same IP (9b-N13)", async () => {
    const ip = "1.2.3.5";
    // Burn through the first 60.
    for (let i = 0; i < MAX_REQUESTS; i++) {
      await dashboardGET(makeReq(ip));
    }
    // 61st → 429.
    const blocked = await dashboardGET(makeReq(ip));
    expect(blocked.status).toBe(429);
    const body = await blocked.json();
    expect(body.error).toMatch(/Too many dashboard requests/i);
    const retryAfter = blocked.headers.get("retry-after");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
    // requireAuthOrApiKey was NOT called for the 61st (rate limit fires
    // BEFORE auth — defense-in-depth so unauthenticated probes are also
    // capped). The first 60 DID reach auth, so we expect 60 calls.
    expect(mockRequireAuthOrApiKey).toHaveBeenCalledTimes(60);
  });

  // ── 3. Different IP → counter resets ────────────────────────────────
  it("resets the rate-limit counter for a different IP (per-IP bucketing)", async () => {
    const ip1 = "1.2.3.6";
    const ip2 = "9.8.7.6";
    // Burn 60 from ip1.
    for (let i = 0; i < MAX_REQUESTS; i++) {
      await dashboardGET(makeReq(ip1));
    }
    // 61st from ip1 → 429.
    expect((await dashboardGET(makeReq(ip1))).status).toBe(429);
    // First request from ip2 → passes the rate-limit gate (counter is
    // per-IP, so ip2 starts fresh).
    const fresh = await dashboardGET(makeReq(ip2));
    expect(fresh.status).not.toBe(429);
    expect(fresh.status).toBe(401); // reached auth, got 401 (no auth)
  });
});

describe("/api/dashboard/charts GET — per-IP rate limit (9b-N13)", () => {
  beforeEach(() => {
    rateBuckets.clear();
    mockRequireAuthOrApiKey.mockReset();
    mockRequireAuthOrApiKeyPermission.mockReset();
    mockResolveTenantId.mockReset();
    mockGetIp.mockReset();

    mockGetIp.mockImplementation((req?: any) => {
      const ip = req?.headers?.get?.("cf-connecting-ip");
      return ip || "0.0.0.0";
    });
    mockRequireAuthOrApiKey.mockResolvedValue(
      NextResponse.json({ error: "Not authenticated." }, { status: 401 }),
    );
    mockRequireAuthOrApiKeyPermission.mockReturnValue(null);
    mockResolveTenantId.mockReturnValue(null);
  });

  // ── 4a. 60 GETs from same IP to /api/dashboard/charts → all pass ──
  it("lets the first 60 GETs to /api/dashboard/charts from the same IP pass the rate-limit gate", async () => {
    const ip = "2.3.4.5";
    for (let i = 0; i < MAX_REQUESTS; i++) {
      const res = await chartsGET(makeReq(ip, "/api/dashboard/charts"));
      expect(res.status).not.toBe(429);
      expect(res.status).toBe(401);
    }
  });

  // ── 4b. 61st GET to /api/dashboard/charts → 429 + Retry-After ──────
  it("returns 429 + Retry-After on the 61st GET to /api/dashboard/charts from the same IP", async () => {
    const ip = "2.3.4.6";
    for (let i = 0; i < MAX_REQUESTS; i++) {
      await chartsGET(makeReq(ip, "/api/dashboard/charts"));
    }
    const blocked = await chartsGET(makeReq(ip, "/api/dashboard/charts"));
    expect(blocked.status).toBe(429);
    const body = await blocked.json();
    expect(body.error).toMatch(/Too many dashboard requests/i);
    const retryAfter = blocked.headers.get("retry-after");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });
});
