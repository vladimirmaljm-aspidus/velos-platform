import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock the Supabase client so we can drive `check_rate_limit` RPC responses.
//
// The rate limiter resolves its behaviour through `@/lib/supabase/client`:
//   - `isSupabaseConfigured()` gates the fallback path (no Supabase → allow)
//   - `getSupabase().rpc("check_rate_limit", {...})` returns the count/allowed
//   - `resetRateLimit()` calls `getSupabase().from("rate_limits").delete().eq(...)`
//
// We hoist mutable state so the mock factory can read it at call time without
// tripping vitest's "cannot reference outer-scope variables" hoisting rule.

interface MockRpcResult {
  cnt: number;
  window_start: string;
  allowed: boolean;
}

const mockState = vi.hoisted(() => ({
  configured: true,
  rpcResult: null as MockRpcResult | MockRpcResult[] | null,
  rpcError: null as { message: string } | null,
  rpcThrow: null as Error | null,
  rpcCalls: [] as Array<{ key: string; max: number; windowMs: number }>,
  deleteCalls: [] as Array<{ key: string }>,
}));

vi.mock("@/lib/supabase/client", () => ({
  isSupabaseConfigured: () => mockState.configured,
  getSupabase: () => ({
    rpc: async (_name: string, args: {
      p_key: string;
      p_max_attempts: number;
      p_window_ms: number;
    }) => {
      mockState.rpcCalls.push({
        key: args.p_key,
        max: args.p_max_attempts,
        windowMs: args.p_window_ms,
      });
      if (mockState.rpcThrow) throw mockState.rpcThrow;
      if (mockState.rpcError) return { data: null, error: mockState.rpcError };
      return { data: mockState.rpcResult, error: null };
    },
    from: (_table: string) => ({
      delete: () => ({
        eq: (_col: string, value: string) => {
          mockState.deleteCalls.push({ key: value });
          return Promise.resolve({ error: null });
        },
      }),
    }),
  }),
}));

import { checkRateLimit, resetRateLimit } from "@/lib/security/rate-limiter";

beforeEach(() => {
  mockState.configured = true;
  mockState.rpcResult = null;
  mockState.rpcError = null;
  mockState.rpcThrow = null;
  mockState.rpcCalls = [];
  mockState.deleteCalls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rate-limiter — under limit", () => {
  it("allows when count is below max", async () => {
    mockState.rpcResult = {
      cnt: 1,
      window_start: new Date().toISOString(),
      allowed: true,
    };
    const r = await checkRateLimit("login:ip:1.2.3.4", 20, 15 * 60_000);
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(1);
    expect(r.remaining).toBe(19);
    expect(r.retryAfter).toBeUndefined();
  });

  it("allows at the exact limit boundary (count === max)", async () => {
    // The RPC uses `count <= max_attempts AS allowed`, so the final allowed
    // request has count === max. One more would push count to max+1 and trip.
    mockState.rpcResult = {
      cnt: 20,
      window_start: new Date().toISOString(),
      allowed: true,
    };
    const r = await checkRateLimit("login:ip:1.2.3.4", 20, 15 * 60_000);
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(20);
    expect(r.remaining).toBe(0);
    expect(r.retryAfter).toBeUndefined();
  });
});

describe("rate-limiter — at / over limit", () => {
  it("blocks when count exceeds max (retryAfter set)", async () => {
    const windowStart = new Date();
    mockState.rpcResult = {
      cnt: 21,
      window_start: windowStart.toISOString(),
      allowed: false,
    };
    const windowMs = 15 * 60_000;
    const r = await checkRateLimit("login:ip:1.2.3.4", 20, windowMs);
    expect(r.allowed).toBe(false);
    expect(r.count).toBe(21);
    expect(r.remaining).toBe(0);
    expect(r.retryAfter).toBeDefined();
    // retryAfter is at least 1 second (Math.max(1000, ...)) and bounded by
    // window length + clock drift. The exact value depends on how much of
    // the window has elapsed; here we only assert the contract.
    expect(r.retryAfter!).toBeGreaterThan(0);
    expect(r.retryAfter!).toBeLessThanOrEqual(windowMs + 1000);
  });

  it("retryAfter is floored to >=1s to avoid sub-second Retry-After headers", async () => {
    // window_start is far in the past — but the floor should kick in if the
    // raw calculation would be negative or near-zero.
    const longAgo = new Date(Date.now() - 30 * 60_000).toISOString();
    mockState.rpcResult = {
      cnt: 50,
      window_start: longAgo,
      allowed: false,
    };
    const r = await checkRateLimit("k", 20, 15 * 60_000);
    expect(r.allowed).toBe(false);
    expect(r.retryAfter).toBeGreaterThanOrEqual(1000);
  });

  it("blocks subsequent requests once over the limit (continues to deny until window reset)", async () => {
    const ws = new Date().toISOString();
    mockState.rpcResult = { cnt: 22, window_start: ws, allowed: false };
    const r1 = await checkRateLimit("k", 20, 60_000);
    expect(r1.allowed).toBe(false);
    mockState.rpcResult = { cnt: 23, window_start: ws, allowed: false };
    const r2 = await checkRateLimit("k", 20, 60_000);
    expect(r2.allowed).toBe(false);
    mockState.rpcResult = { cnt: 24, window_start: ws, allowed: false };
    const r3 = await checkRateLimit("k", 20, 60_000);
    expect(r3.allowed).toBe(false);
  });
});

describe("rate-limiter — window reset", () => {
  it("allows again when the RPC reports a fresh window (count=1, allowed=true)", async () => {
    // Simulate the window having rolled over: window_start is "now" and
    // the count is 1 (the RPC's CASE expression resets count to 1 when
    // the old window has expired — see migration 024).
    const freshWindow = new Date().toISOString();
    mockState.rpcResult = { cnt: 1, window_start: freshWindow, allowed: true };
    const r = await checkRateLimit("login:ip:1.2.3.4", 20, 15 * 60_000);
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(1);
    expect(r.remaining).toBe(19);
  });

  it("supports a reset() helper that deletes the counter row", async () => {
    await resetRateLimit("login:ip:1.2.3.4");
    expect(mockState.deleteCalls).toEqual([{ key: "login:ip:1.2.3.4" }]);
  });

  it("reset() is a no-op when Supabase is not configured", async () => {
    mockState.configured = false;
    await resetRateLimit("login:ip:1.2.3.4");
    expect(mockState.deleteCalls).toEqual([]);
  });
});

describe("rate-limiter — fallback / fail-open behaviour", () => {
  it("fails open (allowed=true) when Supabase is not configured", async () => {
    mockState.configured = false;
    const r = await checkRateLimit("k", 20, 60_000);
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(1);
    expect(r.remaining).toBe(20);
    // No RPC should have been issued.
    expect(mockState.rpcCalls).toHaveLength(0);
  });

  it("fails open when the RPC returns an error (migration not applied yet)", async () => {
    mockState.rpcError = { message: "function check_rate_limit does not exist" };
    const r = await checkRateLimit("k", 20, 60_000);
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(0); // unknown count → 0
    expect(r.remaining).toBe(20);
  });

  it("fails open when the RPC throws (network / DB outage)", async () => {
    mockState.rpcThrow = new Error("connection refused");
    const r = await checkRateLimit("k", 20, 60_000);
    expect(r.allowed).toBe(true);
  });

  it("fails open when the RPC returns null data", async () => {
    mockState.rpcResult = null;
    const r = await checkRateLimit("k", 20, 60_000);
    expect(r.allowed).toBe(true);
  });

  it("fails open when the RPC returns an empty array", async () => {
    mockState.rpcResult = [];
    const r = await checkRateLimit("k", 20, 60_000);
    expect(r.allowed).toBe(true);
  });
});

describe("rate-limiter — multi-instance atomicity contract", () => {
  it("passes max_attempts + window_ms to the RPC so it can decide atomically", async () => {
    mockState.rpcResult = {
      cnt: 1,
      window_start: new Date().toISOString(),
      allowed: true,
    };
    await checkRateLimit("login:ip:10.0.0.1", 7, 5 * 60_000);
    expect(mockState.rpcCalls).toHaveLength(1);
    expect(mockState.rpcCalls[0]).toEqual({
      key: "login:ip:10.0.0.1",
      max: 7,
      windowMs: 5 * 60_000,
    });
  });

  it("accepts the array form of the RPC response (RETURN QUERY SELECT shape)", async () => {
    // The Postgres RPC uses `RETURN QUERY SELECT ...`, which the Supabase JS
    // client surfaces as an ARRAY of rows. A single-row result looks like
    // `[{ cnt, window_start, allowed }]`. The limiter must extract [0].
    mockState.rpcResult = [
      {
        cnt: 5,
        window_start: new Date().toISOString(),
        allowed: true,
      },
    ];
    const r = await checkRateLimit("k", 10, 60_000);
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(5);
    expect(r.remaining).toBe(5);
  });
});
