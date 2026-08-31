import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// 11-A-v2 / 10-D-v2: pure-logic tests for `buildRateLimits` (the env-var
// override merger added by Task 10-D-v2). The function itself is NOT
// exported from `src/middleware.ts`, and the prompt explicitly sanctions
// testing against a copy-paste of the function logic when the source
// can't be modified ("write the test against a copy-paste of the
// function logic, or skip the test with a comment"). Below is a
// verbatim copy of the source's `buildRateLimits` + `RATE_LIMITS_DEFAULT`
// (as of the Task 10-D-v2 implementation; a header comment notes the
// drift risk if the source is later edited).
//
// DRIFT-RISK: if `src/middleware.ts` is edited (e.g. a new default cap
// is added, or the validation regex changes), this test file must be
// re-synced. The simplest way is to grep for `RATE_LIMITS_DEFAULT` and
// `function buildRateLimits` in `src/middleware.ts` and copy them here.
//
// Tests use `vi.stubEnv` + `vi.unstubAllEnvs` per the prompt spec.

// ─── BEGIN verbatim copy from src/middleware.ts (10-D-v2) ──────────────
// (drift-monitor: keep in sync with src/middleware.ts; if the source's
// default map or validation regex changes, this block must be re-pasted.)
const RATE_LIMITS_DEFAULT: Record<string, { maxRequests: number; windowMs: number }> = {
  "/api/auth/login": { maxRequests: 30, windowMs: 60_000 },
  "/api/portal/login": { maxRequests: 30, windowMs: 60_000 },
  "/api/setup": { maxRequests: 3, windowMs: 300_000 },
  "/api/auth/logout": { maxRequests: 20, windowMs: 60_000 },
  "/api/portal/upload": { maxRequests: 10, windowMs: 60_000 },
  "/api/portal/kyc/document": { maxRequests: 10, windowMs: 60_000 },
  "/api/products": { maxRequests: 30, windowMs: 60_000 },
  "/api/offers": { maxRequests: 30, windowMs: 60_000 },
  "/api/invoices": { maxRequests: 30, windowMs: 60_000 },
  "/api/partners": { maxRequests: 30, windowMs: 60_000 },
  "/api/portal/rfqs": { maxRequests: 5, windowMs: 60_000 },
  "/api/portal/messages": { maxRequests: 20, windowMs: 60_000 },
  "/api/portal/forgot-password": { maxRequests: 3, windowMs: 60_000 },
  "/api/verify": { maxRequests: 10, windowMs: 60_000 },
};

function buildRateLimits(): Record<string, { maxRequests: number; windowMs: number }> {
  const merged: Record<string, { maxRequests: number; windowMs: number }> = { ...RATE_LIMITS_DEFAULT };
  const raw = process.env.RATE_LIMIT_OVERRIDE_JSON;
  if (!raw) return merged;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
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
    if (typeof key !== "string" || !key.startsWith("/")) continue;
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;
    const cfg = val as Record<string, unknown>;
    const maxRequests = Number(cfg.maxRequests);
    const windowMs = Number(cfg.windowMs);
    if (
      !Number.isFinite(maxRequests) || !Number.isInteger(maxRequests) || maxRequests <= 0
      || !Number.isFinite(windowMs) || !Number.isInteger(windowMs) || windowMs <= 0
    ) {
      continue;
    }
    merged[key] = { maxRequests, windowMs };
  }
  return merged;
}
// ─── END verbatim copy ────────────────────────────────────────────────

describe("middleware — buildRateLimits (RATE_LIMIT_OVERRIDE_JSON merger)", () => {
  beforeEach(() => {
    // Ensure a clean env before each test.
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ── 1. Env unset → default map ──────────────────────────────────────
  it("returns the default map when RATE_LIMIT_OVERRIDE_JSON is unset", () => {
    // Ensure the env var is unset.
    vi.stubEnv("RATE_LIMIT_OVERRIDE_JSON", "");
    // Delete is the cleanest way to simulate "unset"; vi.stubEnv with ""
    // sets it to the empty string, which the source's `if (!raw) return
    // merged;` early-returns on. Both shapes are equivalent for the
    // assertion below.
    const out = buildRateLimits();
    // Spot-check several entries from the default map to confirm no
    // override leaked through.
    expect(out["/api/auth/login"]).toEqual({ maxRequests: 30, windowMs: 60_000 });
    expect(out["/api/portal/login"]).toEqual({ maxRequests: 30, windowMs: 60_000 });
    expect(out["/api/verify"]).toEqual({ maxRequests: 10, windowMs: 60_000 });
    // The default map's full size — no new keys were added.
    expect(Object.keys(out).length).toBe(Object.keys(RATE_LIMITS_DEFAULT).length);
  });

  // ── 2. Valid override merges ────────────────────────────────────────
  it("merges a valid override (login tightened to 5/min)", () => {
    vi.stubEnv(
      "RATE_LIMIT_OVERRIDE_JSON",
      JSON.stringify({ "/api/auth/login": { maxRequests: 5, windowMs: 60000 } }),
    );
    const out = buildRateLimits();
    // The override REPLACES the default entry for this key.
    expect(out["/api/auth/login"]).toEqual({ maxRequests: 5, windowMs: 60000 });
    // Other defaults are untouched.
    expect(out["/api/portal/login"]).toEqual({ maxRequests: 30, windowMs: 60_000 });
    // Map size is unchanged (override replaced, not added).
    expect(Object.keys(out).length).toBe(Object.keys(RATE_LIMITS_DEFAULT).length);
  });

  // ── 3. Invalid JSON → falls back to defaults (no throw) ─────────────
  it("falls back to defaults when RATE_LIMIT_OVERRIDE_JSON is invalid JSON (no throw)", () => {
    vi.stubEnv("RATE_LIMIT_OVERRIDE_JSON", "{ not valid json ]");
    // The function MUST NOT throw — a config error must NEVER take the
    // middleware offline (the source's try/catch around JSON.parse
    // returns `merged` defaults instead of throwing).
    let out: ReturnType<typeof buildRateLimits> | null = null;
    expect(() => {
      out = buildRateLimits();
    }).not.toThrow();
    expect(out).not.toBeNull();
    expect(out!["/api/auth/login"]).toEqual({ maxRequests: 30, windowMs: 60_000 });
    expect(out!["/api/verify"]).toEqual({ maxRequests: 10, windowMs: 60_000 });
  });

  // ── 4. Negative maxRequests → override rejected ─────────────────────
  it("rejects a negative maxRequests (falls back to default for that key)", () => {
    vi.stubEnv(
      "RATE_LIMIT_OVERRIDE_JSON",
      JSON.stringify({ "/api/auth/login": { maxRequests: -5, windowMs: 60000 } }),
    );
    const out = buildRateLimits();
    // The override entry is rejected — the default for that key persists.
    expect(out["/api/auth/login"]).toEqual({ maxRequests: 30, windowMs: 60_000 });
  });

  // ── 5. Key without leading `/` → override rejected ─────────────────
  it("rejects a key without a leading `/` (falls back to default for that key)", () => {
    vi.stubEnv(
      "RATE_LIMIT_OVERRIDE_JSON",
      JSON.stringify({ "api/auth/login": { maxRequests: 5, windowMs: 60000 } }),
    );
    const out = buildRateLimits();
    // The override key `api/auth/login` (no leading slash) is rejected.
    // The default for `/api/auth/login` persists.
    expect(out["/api/auth/login"]).toEqual({ maxRequests: 30, windowMs: 60_000 });
    // The bad key was NOT added to the map.
    expect(out).not.toHaveProperty("api/auth/login");
  });

  // ── 6. Missing windowMs → override rejected ──────────────────────────
  it("rejects an entry missing windowMs (falls back to default for that key)", () => {
    vi.stubEnv(
      "RATE_LIMIT_OVERRIDE_JSON",
      JSON.stringify({ "/api/auth/login": { maxRequests: 5 } }),
    );
    const out = buildRateLimits();
    // The override entry is rejected — the default for that key persists.
    expect(out["/api/auth/login"]).toEqual({ maxRequests: 30, windowMs: 60_000 });
  });

  // ── Bonus: a NEW path cap (not in defaults) is ADDED ────────────────
  it("adds a new path cap for a route not in the default map", () => {
    // Sanity: the source spec says operators can use the override to
    // ship an urgent cap-tightening on a route the defaults don't yet
    // cover. This isn't in the prompt's 6 cases but it's a useful
    // regression guard for the "add new path" branch.
    vi.stubEnv(
      "RATE_LIMIT_OVERRIDE_JSON",
      JSON.stringify({ "/api/new/route": { maxRequests: 7, windowMs: 30000 } }),
    );
    const out = buildRateLimits();
    expect(out["/api/new/route"]).toEqual({ maxRequests: 7, windowMs: 30000 });
    // Defaults are all still there.
    expect(out["/api/auth/login"]).toEqual({ maxRequests: 30, windowMs: 60_000 });
    // Map size grew by 1.
    expect(Object.keys(out).length).toBe(Object.keys(RATE_LIMITS_DEFAULT).length + 1);
  });
});
