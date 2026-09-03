import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Unit tests for src/lib/monitoring/error-audit.ts (task 8-c) ────────────
//
// Covers:
//   • computeFingerprint — stability, format, what it does/doesn't include
//   • buildErrorRow — sanitization (control chars, length caps, context
//     JSON round-trip, level normalization)
//   • recordError — RPC path payload, fallback two-step semantics
//     (increment + coalesce + never-overwrite-stack-with-null), and the
//     never-throws contract
//   • resolveError / unresolveError — update call shapes
//   • errorStats — the five head-count queries
//
// Mock strategy: @/lib/supabase/client is replaced with a fluent builder
// mock (same approach as rate-limiter.test.ts — hoisted mutable state the
// factory reads at call time). Every await pops the next result from a
// queue (falling back to `rowResult` when the queue is empty) so
// multi-step flows (select → update/insert) get deterministic sequential
// results. Builder method calls are recorded on the most recent from()
// chain, which is safe because the production code builds each chain
// synchronously.

interface BuilderCalls {
  table: string;
  selectCols?: string;
  eq: Array<[string, unknown]>;
  is: Array<[string, unknown]>;
  not: Array<[string, unknown]>;
  payload: Record<string, unknown> | null;
}

const mockState = vi.hoisted(() => ({
  rpcData: null as unknown,
  rpcError: null as { message: string } | null,
  rpcThrow: null as Error | null,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rowQueue: [] as Array<unknown>,
  rowResult: null as unknown,
  rowError: null as { message: string } | null,
  countQueue: [] as Array<number>,
  countResult: null as number | null,
  fromCalls: [] as BuilderCalls[],
  updateCalls: [] as BuilderCalls[],
  insertCalls: [] as BuilderCalls[],
}));

vi.mock("@/lib/supabase/client", () => ({
  getSupabase: () => {
    const nextResult = () => {
      const data = mockState.rowQueue.length > 0 ? mockState.rowQueue.shift() : mockState.rowResult;
      const count = mockState.countQueue.length > 0 ? mockState.countQueue.shift() : mockState.countResult;
      return { data, error: mockState.rowError, count };
    };
    const lazy = () => new Promise((resolve) => resolve(nextResult()));
    const b: Record<string, unknown> = {};
    const last = () => mockState.fromCalls[mockState.fromCalls.length - 1]!;
    b.select = (cols?: string) => {
      last().selectCols = cols;
      return b;
    };
    b.eq = (col: string, v: unknown) => {
      last().eq.push([col, v]);
      return b;
    };
    b.is = (col: string, v: unknown) => {
      last().is.push([col, v]);
      return b;
    };
    b.not = (col: string, _op: string, v: unknown) => {
      last().not.push([col, v]);
      return b;
    };
    b.gte = () => b;
    b.lte = () => b;
    b.ilike = () => b;
    b.or = () => b;
    b.order = () => b;
    b.range = lazy;
    b.maybeSingle = lazy;
    b.single = lazy;
    b.update = (payload: Record<string, unknown>) => {
      last().payload = payload;
      mockState.updateCalls.push(last());
      return b;
    };
    b.insert = (payload: Record<string, unknown>) => {
      last().payload = payload;
      mockState.insertCalls.push(last());
      return b;
    };
    b.delete = () => b;
    b.then = (res: unknown, rej: unknown) => lazy().then(res as never, rej as never);
    return {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        mockState.rpcCalls.push({ fn, args });
        if (mockState.rpcThrow) throw mockState.rpcThrow;
        return { data: mockState.rpcData, error: mockState.rpcError };
      },
      from: (table: string) => {
        mockState.fromCalls.push({ table, eq: [], is: [], not: [], payload: null });
        return b;
      },
    };
  },
}));

import {
  computeFingerprint,
  buildErrorRow,
  recordError,
  resolveError,
  unresolveError,
  errorStats,
  ERROR_FIELD_LIMITS,
} from "@/lib/monitoring/error-audit";

beforeEach(() => {
  mockState.rpcData = null;
  mockState.rpcError = null;
  mockState.rpcThrow = null;
  mockState.rpcCalls = [];
  mockState.rowQueue = [];
  mockState.rowResult = null;
  mockState.rowError = null;
  mockState.countQueue = [];
  mockState.countResult = null;
  mockState.fromCalls = [];
  mockState.updateCalls = [];
  mockState.insertCalls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── computeFingerprint ──────────────────────────────────────────────────────

describe("computeFingerprint — stability + format", () => {
  it("is deterministic for identical input", () => {
    const a = computeFingerprint("client", "Cannot read properties of undefined", "at Foo (bar.tsx:12:3)");
    const b = computeFingerprint("client", "Cannot read properties of undefined", "at Foo (bar.tsx:12:3)");
    expect(a).toBe(b);
  });

  it("returns a 16-char lowercase hex string", () => {
    const fp = computeFingerprint("server", "boom", null);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).toHaveLength(16);
  });

  it("separates client from server for the same message", () => {
    expect(computeFingerprint("client", "boom", "at x")).not.toBe(computeFingerprint("server", "boom", "at x"));
  });

  it("separates different throw sites (stack first line) with the same message", () => {
    expect(computeFingerprint("client", "boom", "at A.ts:1:1")).not.toBe(
      computeFingerprint("client", "boom", "at B.ts:2:2"),
    );
  });

  it("ignores stack lines BELOW the first line (same bug, different depths)", () => {
    const one = computeFingerprint("client", "boom", "at A.ts:1:1\n    at deeper (B.ts:9:9)\n    at deepest (C.ts:3:3)");
    const two = computeFingerprint("client", "boom", "at A.ts:1:1\n    at totally (Z.ts:9:9)");
    expect(one).toBe(two);
  });

  it("tolerates a multi-line stackFirstLine by using only the first line", () => {
    const asOne = computeFingerprint("client", "boom", "at A.ts:1:1");
    const asMulti = computeFingerprint("client", "boom", "at A.ts:1:1\nat B.ts:2:2");
    expect(asOne).toBe(asMulti);
  });
});

// ── buildErrorRow (sanitization) ────────────────────────────────────────────

describe("buildErrorRow — input sanitization", () => {
  it("strips control characters but keeps newlines in stacks", () => {
    const row = buildErrorRow({
      source: "client",
      message: "bad\x00\x07message",
      stack: "Error: boom\n\x1bat foo.ts:1:1\x0b",
    });
    expect(row.message).toBe("badmessage");
    expect(row.stack).toBe("Error: boom\nat foo.ts:1:1");
  });

  it("caps message at the documented limit", () => {
    const row = buildErrorRow({ source: "client", message: "x".repeat(5000) });
    expect((row.message as string).length).toBe(ERROR_FIELD_LIMITS.message);
  });

  it("caps stack at the documented limit", () => {
    const row = buildErrorRow({ source: "client", message: "m", stack: "s".repeat(6000) });
    expect((row.stack as string).length).toBe(ERROR_FIELD_LIMITS.stack);
  });

  it("caps url and email at their limits", () => {
    const row = buildErrorRow({
      source: "client",
      message: "m",
      url: "https://" + "x".repeat(1000),
      user_email: "e".repeat(500) + "@example.com",
    });
    expect((row.url as string).length).toBeLessThanOrEqual(ERROR_FIELD_LIMITS.url);
    expect((row.user_email as string).length).toBeLessThanOrEqual(ERROR_FIELD_LIMITS.email);
  });

  it("stringifies + caps the context object and returns serializable data", () => {
    const row = buildErrorRow({
      source: "client",
      message: "m",
      context: { big: "y".repeat(ERROR_FIELD_LIMITS.context + 500) },
    });
    // Over-long context is preserved best-effort (truncated raw text), and
    // the row's context must be a serializable object.
    expect(row.context).toBeDefined();
    expect(typeof row.context).toBe("object");
    expect(() => JSON.stringify(row.context)).not.toThrow();
  });

  it("drops unserializable context safely (never throws)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const row = buildErrorRow({ source: "client", message: "m", context: circular });
    expect(row.context).toBeDefined();
  });

  it("normalizes an invalid level to 'error' and keeps 'warning'", () => {
    const bogus = buildErrorRow({ source: "server", message: "m", level: "bogus" as "error" });
    expect(bogus.level).toBe("error");
    const warn = buildErrorRow({ source: "server", message: "m", level: "warning" });
    expect(warn.level).toBe("warning");
  });

  it("substitutes a placeholder for an empty message (message is NOT NULL)", () => {
    const row = buildErrorRow({ source: "client", message: "   " });
    expect(row.message).toBe("(no message)");
  });

  it("computes the fingerprint from the sanitized values", () => {
    const row = buildErrorRow({
      source: "client",
      message: "boom",
      stack: "Error: boom\nat A.ts:1:1",
    });
    expect(row.fingerprint).toBe(computeFingerprint("client", "boom", "at A.ts:1:1"));
  });
});

// ── recordError ─────────────────────────────────────────────────────────────

describe("recordError — RPC path (migration 086 applied)", () => {
  it("calls record_error with the sanitized row and returns its result", async () => {
    const stored = { id: "e-1", fingerprint: "abc123", occurrence_count: 1 };
    mockState.rpcData = stored;

    const out = await recordError({
      source: "client",
      message: "boom",
      stack: "Error: boom\nat A.ts:1:1",
      url: "https://app/portal",
      user_agent: "UA",
      context: { digest: "d1" },
    });

    expect(out).toBe(stored);
    expect(mockState.rpcCalls).toHaveLength(1);
    expect(mockState.rpcCalls[0]!.fn).toBe("record_error");
    const payload = mockState.rpcCalls[0]!.args.p_payload as Record<string, unknown>;
    expect(payload.source).toBe("client");
    expect(payload.level).toBe("error");
    expect(payload.message).toBe("boom");
    expect(payload.stack).toBe("Error: boom\nat A.ts:1:1");
    expect(payload.url).toBe("https://app/portal");
    expect(payload.user_agent).toBe("UA");
    expect(payload.fingerprint).toBe(computeFingerprint("client", "boom", "at A.ts:1:1"));
    expect((payload.context as Record<string, unknown>).digest).toBe("d1");
    // RPC path only — no fallback table calls.
    expect(mockState.fromCalls).toHaveLength(0);
  });

  it("unwraps the array form of the RPC result (RETURN QUERY shape)", async () => {
    const stored = { id: "e-2", fingerprint: "abc124" };
    mockState.rpcData = [stored];
    const out = await recordError({ source: "server", message: "x" });
    expect(out).toBe(stored);
  });
});

describe("recordError — JS fallback (RPC not installed)", () => {
  beforeEach(() => {
    // The classic "function does not exist" (PGRST202) shape.
    mockState.rpcError = { message: "function public.record_error(jsonb) does not exist" };
  });

  it("increments occurrence_count on an existing fingerprint and coalesces fields", async () => {
    const existing = {
      id: "e-3",
      fingerprint: "fp",
      occurrence_count: 3,
      first_seen_at: "2026-01-01T00:00:00Z",
      last_seen_at: "2026-01-01T00:00:00Z",
      stack: "old stack",
      url: "old url",
      level: "warning",
      context: { keep: true },
      tenant_id: "t-1",
    };
    const updated = { id: "e-3", occurrence_count: 4 };
    // 1st await (select.maybeSingle) → existing; 2nd (update.single) → updated.
    mockState.rowQueue = [existing, updated];

    const out = await recordError({
      source: "client",
      message: "boom",
      stack: null, // must NOT overwrite the existing stack
      url: "https://new",
      level: "error",
      context: { digest: "d" },
      tenant_id: null,
    });

    expect(mockState.updateCalls).toHaveLength(1);
    const payload = mockState.updateCalls[0]!.payload!;
    expect(payload.occurrence_count).toBe(4);
    // coalesce: stack stays (incoming was null)
    expect(payload.stack).toBe("old stack");
    // coalesce: url upgrades (incoming non-null)
    expect(payload.url).toBe("https://new");
    // tenant stays when incoming is null
    expect(payload.tenant_id).toBe("t-1");
    // level escalates to error, never downgrades
    expect(payload.level).toBe("error");
    // non-empty existing context is preserved
    expect(payload.context).toEqual({ keep: true });
    // recurrence reopens a resolved row
    expect(payload.resolved_at).toBeNull();
    expect(payload.resolved_by).toBeNull();
    // last_seen_at bumped to ~now
    expect(typeof payload.last_seen_at).toBe("string");
    expect(new Date(payload.last_seen_at as string).getTime()).toBeGreaterThan(Date.now() - 10_000);
    // first_seen_at is NEVER touched by the update
    expect(payload.first_seen_at).toBeUndefined();
    expect(out).toBe(updated);
    expect(mockState.insertCalls).toHaveLength(0);
    // the select was scoped by the computed fingerprint (stack null →
    // message-only signature)
    const expectedFp = computeFingerprint("client", "boom", null);
    expect(mockState.fromCalls[0]!.eq).toContainEqual(["fingerprint", expectedFp]);
  });

  it("inserts a fresh row when the fingerprint is unseen", async () => {
    const inserted = { id: "e-4", occurrence_count: 1 };
    // 1st await (select.maybeSingle) → null; 2nd (insert.single) → inserted.
    mockState.rowQueue = [null, inserted];

    const out = await recordError({ source: "server", message: "fresh" });

    expect(mockState.insertCalls).toHaveLength(1);
    const payload = mockState.insertCalls[0]!.payload!;
    expect(payload.source).toBe("server");
    expect(payload.message).toBe("fresh");
    expect(payload.occurrence_count).toBeUndefined(); // DB default 1
    expect(typeof payload.fingerprint).toBe("string");
    expect(out).toBe(inserted);
    expect(mockState.updateCalls).toHaveLength(0);
  });
});

describe("recordError — never-throws contract", () => {
  it("returns null when the RPC throws", async () => {
    mockState.rpcThrow = new Error("connection refused");
    const out = await recordError({ source: "client", message: "boom" });
    expect(out).toBeNull();
  });

  it("returns null when the fallback select errors", async () => {
    mockState.rpcError = { message: "not installed" };
    mockState.rowError = { message: "schema cache missing" };
    const out = await recordError({ source: "client", message: "boom" });
    expect(out).toBeNull();
  });
});

// ── resolve / unresolve / stats ─────────────────────────────────────────────

describe("resolveError / unresolveError", () => {
  it("updates resolved_at + resolved_by scoped by id and open state", async () => {
    mockState.rowQueue = [{ id: "e-1" }];
    const ok = await resolveError("e-1", "dejan@aspidus.co");
    expect(ok).toBe(true);
    expect(mockState.updateCalls).toHaveLength(1);
    const payload = mockState.updateCalls[0]!.payload!;
    expect(payload.resolved_by).toBe("dejan@aspidus.co");
    expect(typeof payload.resolved_at).toBe("string");
    const calls = mockState.updateCalls[0]!;
    expect(calls.eq).toContainEqual(["id", "e-1"]);
    expect(calls.is).toContainEqual(["resolved_at", null]);
  });

  it("caps resolved_by at the email limit", async () => {
    mockState.rowQueue = [{ id: "e-1" }];
    await resolveError("e-1", "z".repeat(1000));
    const payload = mockState.updateCalls[0]!.payload!;
    expect((payload.resolved_by as string).length).toBeLessThanOrEqual(ERROR_FIELD_LIMITS.email);
  });

  it("returns false when the row is missing (route maps to 404)", async () => {
    mockState.rowQueue = [null];
    const ok = await resolveError("nope", "x@example.com");
    expect(ok).toBe(false);
  });

  it("adds the tenant scope when a tenantId is passed (tenant admin)", async () => {
    mockState.rowQueue = [{ id: "e-1" }];
    await resolveError("e-1", "x@example.com", "tenant-A");
    const calls = mockState.updateCalls[0]!;
    expect(calls.eq).toContainEqual(["id", "e-1"]);
    expect(calls.eq).toContainEqual(["tenant_id", "tenant-A"]);
  });

  it("unresolve clears resolved_at/by on a resolved row", async () => {
    mockState.rowQueue = [{ id: "e-1" }];
    const ok = await unresolveError("e-1");
    expect(ok).toBe(true);
    const payload = mockState.updateCalls[0]!.payload!;
    expect(payload.resolved_at).toBeNull();
    expect(payload.resolved_by).toBeNull();
    expect(mockState.updateCalls[0]!.not).toContainEqual(["resolved_at", null]);
  });

  it("never throws on DB failure", async () => {
    mockState.rowError = { message: "boom" };
    const ok = await unresolveError("e-1");
    expect(ok).toBe(false);
  });
});

describe("errorStats", () => {
  it("runs the five head-count queries and maps them into the stats shape", async () => {
    // Promise.all awaits the (shared) thenable builder once per element —
    // each await pops the next queued count.
    mockState.countQueue = [10, 4, 6, 3, 2];
    mockState.rowError = null;
    const stats = await errorStats();
    expect(stats).toEqual({ total: 10, open: 4, client: 6, server: 3, last24h: 2 });
  });

  it("propagates DB errors (the route surfaces a sanitized 500)", async () => {
    mockState.rowError = { message: "boom" };
    await expect(errorStats()).rejects.toThrow("boom");
  });
});
