import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import type { AuthContext } from "@/lib/api/helpers";
import type { User } from "@/lib/supabase/types";
import type { Store } from "@/lib/data/store";

// 11-B-v2 / 9b-N15 + 9b-N8: route-level tests for
// src/app/api/auth/2fa/recovery/route.ts POST.
//
// Covers:
//   1. successful recovery → 200 {used: true} AND bumpUserTokenVersion called once.
//   2. single-use: re-using a consumed code → 400 "Invalid or already-used recovery code."
//   3. per-IP rate limit 5/5min: 5 bad attempts then 6th → 429 + Retry-After.
//   4. no auth session → 401.
//   5. user.totp_enabled=false → 400 "Two-factor authentication is not active on this account."
//
// Mocking strategy (mirrors tests/unit/notification-dedup.test.ts):
//   • `vi.hoisted` declares the controllable mock fns so they're visible inside
//     `vi.mock` factories (which vitest hoists to file top).
//   • `@/lib/api/helpers` is mocked: `requireAuth` returns a fake AuthContext
//     (or a 401 NextResponse for the unauthenticated case); `audit`, `getIp`,
//     `sanitizeError` are stubs.
//   • `@/lib/auth/totp` `hashRecoveryCode` uses the REAL sha256 impl (we re-
//     implement it locally to avoid pulling otplib transitively through the
//     module). The route calls `hashRecoveryCode(code)` then looks the result
//     up in `user.recovery_codes` (which stores hashes); our fixtures bake in
//     the sha256 of the recovery code so the lookup succeeds / fails as the
//     test case demands.
//   • `@/lib/security/rate-limiter` `checkRateLimit` is a controllable fn
//     that returns allowed=true N times then allowed=false (for case 3).
//   • The fake Store (returned by `requireAuth` as `auth.store`) implements
//     `getUserById`, `upsertUser`, `bumpUserTokenVersion` as mock fns whose
//     return values match the test case. `getUserById` returns mutable state
//     so a single test can exercise "first call succeeds, second call sees
//     the post-upsert user (no recovery_codes left)".

const { mockRequireAuth, mockAudit, mockGetIp, mockSanitizeError, mockBump, mockGetUserById, mockUpsertUser } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockAudit: vi.fn(async () => {}),
  mockGetIp: vi.fn(() => "1.2.3.4"),
  mockSanitizeError: vi.fn((e: unknown) => String(e)),
  mockBump: vi.fn(async (_id: string) => 1),
  mockGetUserById: vi.fn(),
  mockUpsertUser: vi.fn(),
}));

vi.mock("@/lib/api/helpers", () => ({
  requireAuth: mockRequireAuth,
  audit: mockAudit,
  getIp: mockGetIp,
  sanitizeError: mockSanitizeError,
}));

vi.mock("@/lib/auth/totp", () => ({
  // Use the REAL sha256 hex digest — the route hashes the inbound code and
  // looks it up against user.recovery_codes (an array of hashes). Our fixtures
  // pre-bake the same hash so the comparison works end-to-end.
  hashRecoveryCode: vi.fn((code: string) =>
    createHash("sha256").update(code).digest("hex"),
  ),
}));

const { mockCheckRateLimit } = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
}));

vi.mock("@/lib/security/rate-limiter", () => ({
  checkRateLimit: mockCheckRateLimit,
  resetRateLimit: vi.fn(async () => {}),
}));

import { POST } from "@/app/api/auth/2fa/recovery/route";

// ── Test fixtures ────────────────────────────────────────────────────────

const VALID_CODE = "ABCD1234EFGH5678";
const VALID_HASH = createHash("sha256").update(VALID_CODE).digest("hex");

function makeUser(over: Partial<User> = {}): User {
  return {
    id: "u-1",
    tenant_id: null,
    username: "alice",
    email: "alice@example.com",
    full_name: null,
    role: "user",
    permissions: null,
    password_hash: "x",
    totp_secret: "KQTASDFASDFASDF",
    totp_enabled: true,
    recovery_codes: [VALID_HASH],
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

function makeAuthContext(user: User): AuthContext {
  const fakeStore: Store = {
    getUserById: mockGetUserById,
    upsertUser: mockUpsertUser,
    bumpUserTokenVersion: mockBump,
    // Stubs the route never reaches in these tests but are on the Store
    // interface — typed as `never`-ish via casting.
  } as unknown as Store;
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
    store: fakeStore,
    ip: "1.2.3.4",
    tenantId: user.tenant_id,
    isSuperAdmin: false,
    impersonation: undefined,
  };
}

function makeReq(body: unknown): NextRequest {
  return new NextRequest(new Request("http://localhost/api/auth/2fa/recovery", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("POST /api/auth/2fa/recovery (9b-N15 + 9b-N8)", () => {
  beforeEach(() => {
    mockRequireAuth.mockReset();
    mockAudit.mockReset();
    mockGetIp.mockReset();
    mockSanitizeError.mockReset();
    mockBump.mockReset();
    mockGetUserById.mockReset();
    mockUpsertUser.mockReset();
    mockCheckRateLimit.mockReset();

    // Sensible defaults: rate limit always allows; audit is a no-op;
    // getIp returns a fixed IP; sanitizeError stringifies.
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 5, count: 1 });
    mockAudit.mockResolvedValue(undefined);
    mockGetIp.mockReturnValue("1.2.3.4");
    mockSanitizeError.mockImplementation((e: unknown) => String(e));
    // Default: bump succeeds.
    mockBump.mockResolvedValue(1);
    // Default: upsertUser just echoes back the input (the route doesn't
    // read the return value of upsertUser for the recovery flow).
    mockUpsertUser.mockImplementation(async (u: any) => ({ ...makeUser(), ...u }));
  });

  // ── 1. Valid code → 200 {used: true} AND bumpUserTokenVersion called ──
  it("returns 200 {used: true} and bumps token_version on a valid recovery code", async () => {
    const user = makeUser({ recovery_codes: [VALID_HASH], totp_enabled: true });
    mockGetUserById.mockResolvedValue(user);
    mockRequireAuth.mockResolvedValue(makeAuthContext(user));

    const res = await POST(makeReq({ code: VALID_CODE }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.used).toBe(true);
    expect(body.remaining).toBe(0); // one code, consumed
    // 9b-N15: bumpUserTokenVersion was called once on success.
    expect(mockBump).toHaveBeenCalledTimes(1);
    expect(mockBump).toHaveBeenCalledWith(user.id);
    // upsertUser cleared recovery_codes + disabled totp.
    expect(mockUpsertUser).toHaveBeenCalledTimes(1);
    const upsertArg = mockUpsertUser.mock.calls[0][0];
    expect(upsertArg.totp_enabled).toBe(false);
    expect(upsertArg.recovery_codes).toBeNull();
  });

  // ── 2. Re-using the same code → 400 (single-use). ─────────────────────
  // NOTE on wording: the prompt's expected message was "Invalid or already-
  // used recovery code." The source route, on a SUCCESSFUL recovery, sets
  // BOTH `recovery_codes: null` (line 95) AND `totp_enabled: false` (line
  // 91) — it wipes ALL hashes AND disables 2FA (rationale: a partial drain
  // leaves stale codes that won't work after re-enrollment, so the user
  // re-enrolls via /verify which mints a fresh set; and 2FA must be off so
  // the user can log back in without TOTP). Therefore the SECOND call (same
  // code) hits the `totp_enabled=false` gate at line 50-55 BEFORE the
  // recovery_codes empty gate (line 56-61) → 400 "Two-factor authentication
  // is not active on this account." The single-use enforcement is correct
  // (a successful recovery immediately closes the door to further attempts
  // at the same endpoint), just the wording differs from the prompt's
  // expected message. Test 2b below covers the "wrong code with a non-empty
  // array" path which DOES surface "Invalid or already-used recovery code."
  it("returns 400 on a re-used code (single-use) — source disables 2FA after first use, blocking further attempts", async () => {
    // Stateful fake: getUserById returns the live user; upsertUser mutates
    // the live user in-place so the second call sees the post-recovery state.
    const liveUser = makeUser({
      recovery_codes: [VALID_HASH],
      totp_enabled: true,
    });
    mockGetUserById.mockImplementation(async () => liveUser);
    mockUpsertUser.mockImplementation(async (patch: any) => {
      // Mirror the source's upsert: recovery_codes=null + totp_enabled=false.
      if (patch.recovery_codes !== undefined) liveUser.recovery_codes = patch.recovery_codes;
      if (patch.totp_enabled !== undefined) liveUser.totp_enabled = patch.totp_enabled;
      return liveUser;
    });
    mockRequireAuth.mockResolvedValue(makeAuthContext(liveUser));

    // First POST → 200, code consumed, all hashes wiped + 2FA disabled.
    const first = await POST(makeReq({ code: VALID_CODE }));
    expect(first.status).toBe(200);
    expect(mockBump).toHaveBeenCalledTimes(1);

    // Second POST with the SAME code → 400. The live user now has
    // totp_enabled=false → the gate at line 50-55 fires BEFORE the empty-
    // array gate. Single-use is enforced: a successful recovery immediately
    // closes the door to further attempts at the same endpoint.
    const second = await POST(makeReq({ code: VALID_CODE }));
    expect(second.status).toBe(400);
    const body = await second.json();
    expect(body.error).toBe("Two-factor authentication is not active on this account.");
    // Bump was called ONCE (the first successful POST); not called on the
    // second failure path.
    expect(mockBump).toHaveBeenCalledTimes(1);
  });

  // ── 2b. Wrong code with non-empty array → "Invalid or already-used
  //        recovery code." (proves the message DOES fire when the supplied
  //        code's hash isn't in a non-empty array — the "already-used"
  //        wording refers to a code whose hash isn't in the live list). ──
  it("returns 400 'Invalid or already-used recovery code.' when the supplied code is not in a non-empty recovery_codes array", async () => {
    const user = makeUser({ recovery_codes: [VALID_HASH], totp_enabled: true });
    mockGetUserById.mockResolvedValue(user);
    mockRequireAuth.mockResolvedValue(makeAuthContext(user));

    const res = await POST(makeReq({ code: "NEVER-A-VALID-CODE" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid or already-used recovery code.");
    // Bump + upsert must NOT have fired (failure path).
    expect(mockBump).not.toHaveBeenCalled();
    expect(mockUpsertUser).not.toHaveBeenCalled();
  });

  // ── 3. Per-IP rate limit (5/5min): 6th wrong attempt → 429 + Retry-After
  it("returns 429 with Retry-After after 5 wrong attempts from same IP (per-IP rate limit)", async () => {
    // Each attempt has a code that won't match any stored hash. The rate
    // limiter allows the first 5 calls then denies the 6th.
    const user = makeUser({ recovery_codes: [VALID_HASH], totp_enabled: true });
    mockGetUserById.mockResolvedValue(user);
    mockRequireAuth.mockResolvedValue(makeAuthContext(user));

    // First 5 calls: allowed=true. 6th call: allowed=false with retryAfter.
    for (let i = 0; i < 5; i++) {
      mockCheckRateLimit.mockResolvedValueOnce({
        allowed: true,
        remaining: 5 - i,
        count: i + 1,
      });
    }
    mockCheckRateLimit.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      retryAfter: 5 * 60_000, // 5 minutes
      count: 6,
    });

    // First 5 wrong attempts → each 400 "Invalid or already-used…".
    for (let i = 0; i < 5; i++) {
      const r = await POST(makeReq({ code: "WRONG-CODE-" + i }));
      expect(r.status).toBe(400);
    }

    // 6th attempt → 429 with Retry-After header.
    const blocked = await POST(makeReq({ code: "WRONG-CODE-6" }));
    expect(blocked.status).toBe(429);
    const blockedBody = await blocked.json();
    expect(blockedBody.error).toMatch(/Too many recovery attempts/i);
    // Retry-After header is set (in seconds).
    const retryAfter = blocked.headers.get("retry-after");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
    // The 6th attempt must NOT have reached the user lookup (rate limit
    // gate is BEFORE requireAuth) — assert requireAuth was never called.
    // We expect requireAuth to have been called for the 5 allowed calls
    // (since rate limit ran first and allowed them through) but NOT for
    // the 6th.
    expect(mockRequireAuth).toHaveBeenCalledTimes(5);
  });

  // ── 4. No auth session → 401 ─────────────────────────────────────────
  it("returns 401 when there is no auth session", async () => {
    mockRequireAuth.mockResolvedValue(
      NextResponse.json({ error: "Not authenticated." }, { status: 401 }),
    );

    const res = await POST(makeReq({ code: VALID_CODE }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Not authenticated.");
    // No bump, no user fetch, no upsert.
    expect(mockBump).not.toHaveBeenCalled();
    expect(mockGetUserById).not.toHaveBeenCalled();
    expect(mockUpsertUser).not.toHaveBeenCalled();
  });

  // ── 5. user.totp_enabled=false → 400 ──────────────────────────────────
  it("returns 400 'Two-factor authentication is not active on this account.' when totp_enabled=false", async () => {
    const user = makeUser({ totp_enabled: false, recovery_codes: [VALID_HASH] });
    mockGetUserById.mockResolvedValue(user);
    mockRequireAuth.mockResolvedValue(makeAuthContext(user));

    const res = await POST(makeReq({ code: VALID_CODE }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Two-factor authentication is not active on this account.");
    // Bump + upsert must NOT have fired (the gate is before body parse).
    expect(mockBump).not.toHaveBeenCalled();
    expect(mockUpsertUser).not.toHaveBeenCalled();
  });
});
