import { describe, it, expect, beforeEach } from "vitest";
// 11-A-v2 / audit 8a-3 / 8b-1: pure-logic tests for the GPS-gate validator.
// `validateGpsAgainstIp` is async because it consults the IP-geo lookup
// cache (which itself calls fetch — but for the cases below, the IP is
// either loopback (lookupIp short-circuits to EMPTY_GEO) or the source-
// browser / range / zero_zero / non_finite checks fail BEFORE the distance
// check fires, so no real HTTP request is issued. `clearGeoIpCache()` is
// called in beforeEach to keep each test independent.
import {
  validateGpsAgainstIp,
  clearGeoIpCache,
} from "@/lib/utils/geo-ip";

describe("validateGpsAgainstIp — pure-logic edge cases", () => {
  beforeEach(() => {
    // Wipe the in-memory IP→geo cache between tests so each test runs from
    // a clean slate. None of the tests below issue a real HTTP request
    // (the IP is either loopback → EMPTY_GEO short-circuit, or the source /
    // range / zero_zero / non_finite checks fail BEFORE the distance check
    // fires), but the cache reset keeps the tests independent regardless.
    clearGeoIpCache();
  });

  // ── zero_zero ────────────────────────────────────────────────────────
  it("rejects (0, 0, browser) as zero_zero", async () => {
    // (0, 0) is the textbook "browser denied geolocation" placeholder the
    // Portal `use-geolocation` hook sends when the user declines the
    // permission prompt. Even though (0, 0) is a real point in the
    // Atlantic off the African coast, accepting it would let any client
    // bypass the GPS gate by supplying the placeholder.
    const r = await validateGpsAgainstIp("8.8.8.8", 0, 0, "browser");
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("zero_zero");
  });

  // ── out_of_range ─────────────────────────────────────────────────────
  it("rejects latitude > 90 (91, 0) as out_of_range", async () => {
    const r = await validateGpsAgainstIp("8.8.8.8", 91, 0, "browser");
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("out_of_range");
  });

  it("rejects latitude < -90 (-91, 0) as out_of_range", async () => {
    const r = await validateGpsAgainstIp("8.8.8.8", -91, 0, "browser");
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("out_of_range");
  });

  it("rejects longitude > 180 (0, 181) as out_of_range", async () => {
    const r = await validateGpsAgainstIp("8.8.8.8", 0, 181, "browser");
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("out_of_range");
  });

  // ── non_finite ────────────────────────────────────────────────────────
  it("rejects NaN latitude as non_finite", async () => {
    // `Number.isFinite(NaN) === false`, so this is caught by the
    // non_finite guard BEFORE the range check (which would otherwise
    // treat NaN as "neither > 90 nor < -90" and let it through).
    const r = await validateGpsAgainstIp("8.8.8.8", NaN, 0, "browser");
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("non_finite");
  });

  it("rejects Infinity latitude as non_finite", async () => {
    const r = await validateGpsAgainstIp("8.8.8.8", Infinity, 0, "browser");
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("non_finite");
  });

  // ── not_browser ────────────────────────────────────────────────────────
  it("rejects (40.7, -74.0, ip) as not_browser", async () => {
    // `source === "browser"` is required because the audit fix must
    // verify the user actively granted geolocation permission — IP-only
    // "fixes" (auto-derive coords from the IP) are NOT sufficient for
    // the GPS gate.
    const r = await validateGpsAgainstIp("8.8.8.8", 40.7, -74.0, "ip");
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("not_browser");
  });

  // ── loopback bypasses deviation check ────────────────────────────────
  it("accepts (40.7, -74.0, browser) when IP is loopback (127.0.0.1)", async () => {
    // 127.0.0.1 is treated as a private/loopback IP — `lookupIp` returns
    // EMPTY_GEO immediately, so `geo.latitude` is null and the deviation
    // check is skipped (legitimate, because we have no IP-derived coords
    // to compare against on a localhost call). The coords are still
    // range-valid + non-zero + browser-supplied, so the verdict is valid.
    const r = await validateGpsAgainstIp("127.0.0.1", 40.7, -74.0, "browser");
    expect(r.valid).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  // ── ip source combined with zero_zero ─────────────────────────────────
  it("rejects (0, 0, ip) — at minimum one of the failure reasons", async () => {
    // The source check fires FIRST (before range / zero_zero), so the
    // verdict is `not_browser` for any ip-source coords. The spec only
    // requires "at minimum one of the reasons" — we additionally assert
    // the reason is one of the documented enum values.
    const r = await validateGpsAgainstIp("8.8.8.8", 0, 0, "ip");
    expect(r.valid).toBe(false);
    expect(["not_browser", "out_of_range", "zero_zero", "too_far_from_ip", "non_finite"])
      .toContain(r.reason);
  });
});
