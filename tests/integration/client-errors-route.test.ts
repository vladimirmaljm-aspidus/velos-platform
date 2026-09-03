import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Route tests for /api/client-errors (task 8-c) ───────────────────────────
//
// Covers the endpoint's PUBLIC ingest contract:
//   • 204 on a valid body, with recordError called (source 'client') and
//     session enrichment applied when a cookie is present
//   • 204 (silent drop) on: invalid JSON, missing message, oversized body,
//     recordError throwing — the endpoint must NEVER surface an error
//     (an error response here would feed the client error-reporting loop)
//   • 429 + Retry-After after the 30/min per-IP cap (the ONE non-204
//     response, and not an error)
//   • Cache-Control: no-store on every response
//
// Mock strategy (mirrors tests/integration/audit10-dashboard-rate-limit):
//   • checkRateLimit is replaced with a real in-memory per-key counter so
//     we can drive the 30→31 boundary
//   • recordError is a spy (the DB layer has its own unit tests)
//   • getSessionFromCookie / getStore drive the enrichment path
//   • getIp reads the cf-connecting-ip header so per-IP keys vary

const MAX_REQUESTS = 30;
const WINDOW_MS = 60_000;

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
    return Promise.resolve({
      allowed: false,
      remaining: 0,
      retryAfter: Math.max(1000, bucket.windowStart + windowMs - now),
      count: bucket.count,
    });
  }
  return Promise.resolve({
    allowed: true,
    remaining: max - bucket.count,
    count: bucket.count,
  });
}

const { mockGetIp, mockRecordError, mockGetSession, mockGetStore } = vi.hoisted(() => ({
  mockGetIp: vi.fn(),
  mockRecordError: vi.fn(async () => null),
  mockGetSession: vi.fn(async () => null),
  mockGetStore: vi.fn(async () => ({
    getUserById: async () => ({ email: "dejan@aspidus.co" }),
  })),
}));

vi.mock("@/lib/security/rate-limiter", () => ({
  checkRateLimit: vi.fn((key: string, max: number, windowMs: number) =>
    fakeCheckRateLimit(key, max, windowMs)),
  resetRateLimit: vi.fn(async () => {}),
}));

vi.mock("@/lib/monitoring/error-audit", () => ({
  recordError: mockRecordError,
}));

vi.mock("@/lib/auth/session", () => ({
  getSessionFromCookie: mockGetSession,
}));

vi.mock("@/lib/data/store", () => ({
  getStore: mockGetStore,
}));

vi.mock("@/lib/api/helpers", () => ({
  getIp: mockGetIp,
}));

import { POST } from "@/app/api/client-errors/route";

function makeReq(ip: string, body?: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new Request("http://localhost/api/client-errors", {
    method: "POST",
    headers: { "cf-connecting-ip": ip, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : body,
  }));
}

const VALID_BODY = JSON.stringify({
  message: "TypeError: cannot read 'id' of undefined",
  stack: "TypeError: cannot read 'id' of undefined\n    at PortalOffers (portal-offers.tsx:212:19)",
  url: "https://app.example.com/portal/offers",
  level: "error",
  context: { digest: "abc123", boundary: "route-error" },
});

beforeEach(() => {
  rateBuckets.clear();
  mockRecordError.mockClear();
  mockRecordError.mockImplementation(async () => null);
  mockGetSession.mockClear();
  mockGetSession.mockImplementation(async () => null);
  mockGetStore.mockClear();
  mockGetIp.mockReset();
  mockGetIp.mockImplementation(((req: Request) => req.headers.get("cf-connecting-ip") || "127.0.0.1") as never);
});

// ── Happy path ──────────────────────────────────────────────────────────────

describe("client-errors — valid reports", () => {
  it("returns 204 + no-store and calls recordError with source 'client'", async () => {
    const res = await POST(makeReq("1.2.3.4", VALID_BODY));
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mockRecordError).toHaveBeenCalledTimes(1);
    const input = mockRecordError.mock.calls[0][0] as Record<string, unknown>;
    expect(input.source).toBe("client");
    expect(input.level).toBe("error");
    expect(input.message).toBe("TypeError: cannot read 'id' of undefined");
    expect(input.stack).toContain("portal-offers.tsx");
    expect(input.url).toBe("https://app.example.com/portal/offers");
    expect(input.context).toEqual({ digest: "abc123", boundary: "route-error" });
  });

  it("passes level 'warning' through and normalizes anything else to 'error'", async () => {
    await POST(makeReq("1.2.3.4", JSON.stringify({ message: "deprecation", level: "warning" })));
    expect((mockRecordError.mock.calls[0][0] as Record<string, unknown>).level).toBe("warning");

    await POST(makeReq("5.6.7.8", JSON.stringify({ message: "m", level: "critical" })));
    expect((mockRecordError.mock.calls[1][0] as Record<string, unknown>).level).toBe("error");
  });

  it("forwards the user-agent header", async () => {
    await POST(makeReq("1.2.3.4", JSON.stringify({ message: "m" }), {
      "user-agent": "Mozilla/5.0 (TestRunner)",
    }));
    const input = mockRecordError.mock.calls[0][0] as Record<string, unknown>;
    expect(input.user_agent).toBe("Mozilla/5.0 (TestRunner)");
  });

  it("enriches email/role/tenant from the session cookie when present", async () => {
    mockGetSession.mockImplementation(async () => ({
      sub: "user-1",
      username: "dejan",
      role: "admin",
      tenant_id: "tenant-A",
      token_version: 1,
    }));
    await POST(makeReq("1.2.3.4", JSON.stringify({ message: "m" })));
    expect(mockGetStore).toHaveBeenCalled();
    const input = mockRecordError.mock.calls[0][0] as Record<string, unknown>;
    expect(input.user_email).toBe("dejan@aspidus.co");
    expect(input.user_role).toBe("admin");
    expect(input.tenant_id).toBe("tenant-A");
  });

  it("records portal sessions as role 'portal_client' without a user lookup", async () => {
    mockGetSession.mockImplementation(async () => ({
      sub: "portal:abc-123",
      username: "portal:vladimir",
      role: "portal_client",
      tenant_id: "tenant-A",
      token_version: 1,
    }));
    await POST(makeReq("1.2.3.4", JSON.stringify({ message: "m" })));
    expect(mockGetStore).not.toHaveBeenCalled();
    const input = mockRecordError.mock.calls[0][0] as Record<string, unknown>;
    expect(input.user_role).toBe("portal_client");
    expect(input.tenant_id).toBe("tenant-A");
    expect(input.user_email).toBeNull();
  });

  it("stays 204 when the session lookup itself fails (enrichment is best-effort)", async () => {
    mockGetSession.mockImplementation(async () => { throw new Error("cookie read failed"); });
    const res = await POST(makeReq("1.2.3.4", VALID_BODY));
    expect(res.status).toBe(204);
    expect(mockRecordError).toHaveBeenCalledTimes(1);
  });
});

// ── Silent-drop contract (never error) ──────────────────────────────────────

describe("client-errors — invalid payloads are dropped, not rejected", () => {
  it("returns 204 on non-JSON bodies without calling recordError", async () => {
    const res = await POST(makeReq("1.2.3.4", "this is not json"));
    expect(res.status).toBe(204);
    expect(mockRecordError).not.toHaveBeenCalled();
  });

  it("returns 204 when message is missing / empty / not a string", async () => {
    expect((await POST(makeReq("1.2.3.4", JSON.stringify({ stack: "s" })))).status).toBe(204);
    expect((await POST(makeReq("5.6.7.8", JSON.stringify({ message: "   " })))).status).toBe(204);
    expect((await POST(makeReq("9.9.9.9", JSON.stringify({ message: 42 })))).status).toBe(204);
    expect(mockRecordError).not.toHaveBeenCalled();
  });

  it("returns 204 on arrays / null bodies (object shape check)", async () => {
    expect((await POST(makeReq("1.2.3.4", "[1,2,3]"))).status).toBe(204);
    expect((await POST(makeReq("5.6.7.8", "null"))).status).toBe(204);
    expect(mockRecordError).not.toHaveBeenCalled();
  });

  it("returns 204 and drops oversized bodies (> 8KB cap)", async () => {
    const big = JSON.stringify({ message: "x".repeat(9 * 1024) });
    const res = await POST(makeReq("1.2.3.4", big));
    expect(res.status).toBe(204);
    expect(mockRecordError).not.toHaveBeenCalled();
  });

  it("stays 204 when recordError throws (DB outage must not create a loop)", async () => {
    mockRecordError.mockImplementation(async () => { throw new Error("db down"); });
    const res = await POST(makeReq("1.2.3.4", VALID_BODY));
    expect(res.status).toBe(204);
  });
});

// ── Rate limit ──────────────────────────────────────────────────────────────

describe("client-errors — per-IP rate limit (30/min)", () => {
  it("allows 30 requests from the same IP, blocks the 31st with 429 + Retry-After", async () => {
    const ip = "10.0.0.1";
    for (let i = 0; i < MAX_REQUESTS; i++) {
      const res = await POST(makeReq(ip, JSON.stringify({ message: `m${i}` })));
      expect(res.status).toBe(204);
    }
    expect(mockRecordError).toHaveBeenCalledTimes(MAX_REQUESTS);

    const blocked = await POST(makeReq(ip, JSON.stringify({ message: "one too many" })));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    expect(blocked.headers.get("cache-control")).toBe("no-store");
    // The blocked request never reached recordError.
    expect(mockRecordError).toHaveBeenCalledTimes(MAX_REQUESTS);
  });

  it("scopes the counter per IP — a different IP is unaffected", async () => {
    const ip = "10.0.0.2";
    for (let i = 0; i < MAX_REQUESTS; i++) {
      await POST(makeReq(ip, JSON.stringify({ message: "m" })));
    }
    const other = await POST(makeReq("10.0.0.3", JSON.stringify({ message: "fresh ip" })));
    expect(other.status).toBe(204);
  });
});
