import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// Task 40 — global server-side error capture (console.error tee).
//
// Covers installServerConsoleCapture() in src/lib/monitoring/error-audit.ts:
//   1. console.error("[route]", new Error(...)) is tee'd into record_error
//      with source 'server' and the route tag preserved as context.
//   2. Plain-string console.error diagnostics are NOT recorded (only
//      Error instances / PostgREST-shaped objects count).
//   3. PostgREST-style plain-object errors ({message, code}) are captured.
//   4. Rate cap: beyond 30 recordings/minute the tee drops silently.
//   5. Install is idempotent (double install = single patch — the
//      module-level install-once guard persists for the whole process).
//   6. The original console.error behaviour is preserved (message still
//      reaches the real console → Vercel function logs).
//
// The tee is installed ONCE in beforeAll (mirroring production: once per
// server process). The passthrough is a spy so we can assert the original
// behaviour without noise.
//
// Mock: @/lib/supabase/client — recordError's record_error RPC call is
// captured; the RPC always succeeds so recordError returns early and no
// fallback queries run.

const state = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));

vi.mock("@/lib/supabase/client", () => ({
  getSupabase: () => ({
    rpc: vi.fn((fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return Promise.resolve({ data: { id: "row" }, error: null });
    }),
  }),
}));

import { installServerConsoleCapture, buildErrorRow } from "@/lib/monitoring/error-audit";

/** The console.error the tee saved at install time (our passthrough spy). */
let passthrough: ReturnType<typeof vi.fn>;

beforeAll(() => {
  passthrough = vi.fn();
  console.error = passthrough as unknown as typeof console.error;
  installServerConsoleCapture();
});

beforeEach(() => {
  state.rpcCalls = [];
  passthrough.mockClear();
});

async function flush(): Promise<void> {
  // recordError awaits the RPC; give microtasks a few ticks.
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function recordCalls(): Array<{ fn: string; args: Record<string, unknown> }> {
  return state.rpcCalls.filter((c) => c.fn === "record_error");
}

function lastPayload(): Record<string, unknown> {
  const calls = recordCalls();
  const call = calls[calls.length - 1];
  if (!call) return {};
  return (call.args.p_payload as Record<string, unknown>) ?? {};
}

describe("installServerConsoleCapture — console.error tee", () => {
  it("records an Error instance with source 'server' and the route tag", async () => {
    console.error("[tenants DELETE id]", new Error("boom"));
    await flush();

    expect(recordCalls()).toHaveLength(1);
    const payload = lastPayload();
    expect(payload.source).toBe("server");
    expect(payload.message).toBe("boom");
    expect(payload.url).toBe("[tenants DELETE id]");
    expect((payload.context as Record<string, unknown>)?.capturedBy).toBe("console-tee");
  });

  it("preserves the original console.error passthrough (Vercel logs keep working)", () => {
    const err = new Error("passthrough-check");
    console.error("[x]", err);
    expect(passthrough).toHaveBeenCalledWith("[x]", err);
  });

  it("ignores plain-string diagnostics (no Error arg → no record)", async () => {
    console.error("[cron] nothing to do today");
    await flush();
    expect(recordCalls()).toHaveLength(0);
  });

  it("captures PostgREST-shaped plain-object errors", async () => {
    console.error("[offers GET]", { message: "column does not exist", code: "42703" });
    await flush();

    expect(recordCalls()).toHaveLength(1);
    const payload = lastPayload();
    expect(payload.source).toBe("server");
    expect(payload.message).toBe("column does not exist");
  });

  it("is idempotent — installing twice does not double-patch", async () => {
    installServerConsoleCapture();
    console.error("[dup]", new Error("once"));
    await flush();
    expect(recordCalls()).toHaveLength(1);
  });

  it("deduplicates identical errors via fingerprint semantics (recordError side)", async () => {
    // Same signature twice → recordError receives the same fingerprint in
    // both payloads (the DB upsert increments occurrence_count). The two
    // errors are created via a factory so their stacks share the same
    // throw-site line (a fingerprint keys on message + first "at " frame).
    const makeErr = () => new Error("same");
    console.error("[route]", makeErr());
    console.error("[route]", makeErr());
    await flush();
    const calls = recordCalls();
    expect(calls).toHaveLength(2);
    const fp1 = (calls[0].args.p_payload as Record<string, unknown>).fingerprint;
    const fp2 = (calls[1].args.p_payload as Record<string, unknown>).fingerprint;
    expect(fp1).toBe(fp2);
  });

  // Runs LAST on purpose: the rate cap below consumes the per-minute
  // budget for this test file — earlier assertions would be dropped if
  // this ran first.
  it("rate caps at 30 recordings per minute (the 31st+ is dropped silently)", async () => {
    for (let i = 0; i < 35; i++) {
      console.error(`[burst ${i}]`, new Error(`err-${i}`));
    }
    await flush();
    expect(recordCalls().length).toBeLessThanOrEqual(30);
  });
});

describe("buildErrorRow — server tee payload shape", () => {
  it("fingerprint is stable for the same server error (occurrence aggregation)", () => {
    const a = buildErrorRow({
      source: "server",
      message: "boom",
      stack: "Error: boom\n    at Object.handler (route.ts:10:15)",
      url: "[route]",
    });
    const b = buildErrorRow({
      source: "server",
      message: "boom",
      stack: "Error: boom\n    at Object.handler (route.ts:10:15)",
      url: "[route]",
    });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.source).toBe("server");
  });
});
