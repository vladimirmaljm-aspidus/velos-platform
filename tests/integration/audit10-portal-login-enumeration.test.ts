import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Store } from "@/lib/data/store";
import type { PortalAccess } from "@/lib/supabase/types";

// 11-B-v2 / 8b-4 + 8b-5: route-level tests for
// src/app/api/portal/login/route.ts POST.
//
// Covers:
//   1. POST with non-existent email → 401 "Invalid email or password."
//      (generic — no email-existence leak).
//   2. POST with existing email + wrong password → 401 same generic message.
//   3. POST with existing email + correct password + account suspended → 401
//      SAME generic message (fix 8b-5: suspended-account branch was collapsed
//      into the uniform 401 so a probe can't distinguish suspended-account
//      from wrong-password from no-such-email).
//   4. POST with existing email + correct password + multiple tenants → 409
//      `multiple_tenants: true, tenants: [{tenant_id: "..."}]` with NO
//      `tenant_name` field (fix 8b-4/8a-10: tenant-name leak closed).
//   5. Verify the 3 401 responses (cases 1-3) are byte-identical in body
//      (no leak via different wording / different `error` strings).
//
// Mocking strategy:
//   • `@/lib/data/store` getStore() → returns a fake Store with the portal-
//     access lookup methods (`listPortalAccessByEmail`,
//     `getPortalAccessByEmailAnyTenant`, `getPortalAccessByEmail`,
//     `verifyPortalCredentials`, `verifyPortalCredentialsByEmail`,
//     `upsertPortalAccess`) as controllable mock fns.
//   • `@/lib/api/helpers` `audit` + `getIp` stubbed (audit is a no-op spy so
//     the audit-internal reason capture stays invisible to the HTTP response;
//     getIp returns a fixed IP so the per-IP rate-limit bucket is stable).
//   • `@/lib/security/rate-limiter` checkRateLimit + resetRateLimit stubbed
//     (always allow — these tests aren't about the rate-limit gate).
//   • `@/lib/security/rate-limit-config` getRateLimitConfig stubbed to
//     return the DEFAULT_RATE_LIMIT_CONFIG.
//   • `@/lib/utils/geo-ip` lookupIp stubbed to a fixed country (the route
//     calls it concurrently with the credential verify, awaits it before
//     returning).
//   • `@/lib/auth/session` createSession + setSessionCookie stubbed (the
//     success-path tests for case 4 don't reach them; case 4 short-circuits
//     at the multiple-tenants 409 BEFORE credential verify).

const { mockStore, mockAudit, mockGetIp, mockCheckRateLimit, mockResetRateLimit, mockGetRateLimitConfig, mockLookupIp, mockCreateSession, mockSetSessionCookie } = vi.hoisted(() => ({
  mockStore: vi.fn() as unknown as Store,
  mockAudit: vi.fn(async () => {}),
  mockGetIp: vi.fn(() => "1.2.3.4"),
  mockCheckRateLimit: vi.fn(),
  mockResetRateLimit: vi.fn(async () => {}),
  mockGetRateLimitConfig: vi.fn(),
  mockLookupIp: vi.fn(),
  mockCreateSession: vi.fn(),
  mockSetSessionCookie: vi.fn(async () => {}),
}));

vi.mock("@/lib/data/store", () => ({
  getStore: vi.fn(async () => mockStore),
}));

vi.mock("@/lib/api/helpers", () => ({
  audit: mockAudit,
  getIp: mockGetIp,
}));

vi.mock("@/lib/security/rate-limiter", () => ({
  checkRateLimit: mockCheckRateLimit,
  resetRateLimit: mockResetRateLimit,
}));

vi.mock("@/lib/security/rate-limit-config", () => ({
  getRateLimitConfig: mockGetRateLimitConfig,
  DEFAULT_RATE_LIMIT_CONFIG: {
    loginMaxAttempts: 20,
    loginWindowMs: 15 * 60 * 1000,
    portalLoginMaxAttempts: 20,
    portalLoginWindowMs: 15 * 60 * 1000,
    forgotPasswordMaxAttempts: 5,
    forgotPasswordWindowMs: 15 * 60 * 1000,
    setupPasswordMaxAttempts: 10,
    setupPasswordWindowMs: 15 * 60 * 1000,
    middlewareLoginMaxRequests: 30,
    middlewarePortalLoginMaxRequests: 30,
  },
}));

vi.mock("@/lib/utils/geo-ip", () => ({
  lookupIp: mockLookupIp,
}));

vi.mock("@/lib/auth/session", () => ({
  createSession: mockCreateSession,
  setSessionCookie: mockSetSessionCookie,
}));

import { POST } from "@/app/api/portal/login/route";

// ── Test fixtures ────────────────────────────────────────────────────────

function makeAccess(over: Partial<PortalAccess> = {}): PortalAccess {
  return {
    id: "pa-1",
    partner_id: "p-1",
    tenant_id: "tenant-A",
    tier: "standard" as any,
    can_view_offers: true,
    can_view_documents: true,
    can_view_catalog: true,
    can_view_invoices: true,
    can_view_profile: true,
    can_view_company_info: true,
    can_submit_rfq: true,
    can_download_pdf: true,
    exempt_kyc: false,
    exempt_document_upload: false,
    exempt_location_share: false,
    status: "active",
    approved_by: null,
    approved_at: null,
    invited_at: null,
    welcome_email_sent: false,
    portal_email: "bob@example.com",
    password_hash: "hashed",
    must_set_password: false,
    last_login_at: null,
    last_login_ip: null,
    last_login_country: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    failed_attempts: 0,
    locked_until: null,
    token_version: 0,
    ...over,
  } as PortalAccess;
}

function makeReq(body: unknown): NextRequest {
  return new NextRequest(new Request("http://localhost/api/portal/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function makeFakeStore(over: Partial<Store> = {}): Store {
  return {
    listPortalAccessByEmail: vi.fn(async () => []),
    getPortalAccessByEmail: vi.fn(async () => null),
    getPortalAccessByEmailAnyTenant: vi.fn(async () => null),
    verifyPortalCredentials: vi.fn(async () => null),
    verifyPortalCredentialsByEmail: vi.fn(async () => null),
    upsertPortalAccess: vi.fn(async (p: any) => ({ ...makeAccess(), ...p })),
    getTenant: vi.fn(async () => ({ id: "tenant-A", name: "Acme Corp", status: "active" })),
    ...over,
  } as unknown as Store;
}

describe("POST /api/portal/login (8b-4 / 8b-5 — enumeration defenses)", () => {
  beforeEach(() => {
    // Reset all hoisted mocks to a clean state per test.
    mockAudit.mockReset();
    mockGetIp.mockReset();
    mockCheckRateLimit.mockReset();
    mockResetRateLimit.mockReset();
    mockGetRateLimitConfig.mockReset();
    mockLookupIp.mockReset();
    mockCreateSession.mockReset();
    mockSetSessionCookie.mockReset();

    // Sensible defaults: rate limit always allows; audit is a no-op;
    // getIp returns a fixed IP; geo lookup returns a fixed country;
    // getRateLimitConfig returns the DEFAULT config.
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 20, count: 1 });
    mockAudit.mockResolvedValue(undefined);
    mockGetIp.mockReturnValue("1.2.3.4");
    mockLookupIp.mockResolvedValue({
      country: "US", city: null, region: null, latitude: null, longitude: null,
    });
    mockGetRateLimitConfig.mockResolvedValue({
      loginMaxAttempts: 20,
      loginWindowMs: 15 * 60 * 1000,
      portalLoginMaxAttempts: 20,
      portalLoginWindowMs: 15 * 60 * 1000,
      forgotPasswordMaxAttempts: 5,
      forgotPasswordWindowMs: 15 * 60 * 1000,
      setupPasswordMaxAttempts: 10,
      setupPasswordWindowMs: 15 * 60 * 1000,
      middlewareLoginMaxRequests: 30,
      middlewarePortalLoginMaxRequests: 30,
    });

    // Replace the singleton store with a fresh fake per test.
    Object.assign(mockStore as object, makeFakeStore());
  });

  // ── 1. Non-existent email → 401 generic ──────────────────────────────
  it("returns 401 'Invalid email or password.' for a non-existent email (no email-existence leak)", async () => {
    const store = makeFakeStore({
      listPortalAccessByEmail: vi.fn(async () => []),
      getPortalAccessByEmailAnyTenant: vi.fn(async () => null),
      verifyPortalCredentialsByEmail: vi.fn(async () => null),
    });
    Object.assign(mockStore as object, store);

    const res = await POST(makeReq({ email: "nobody@example.com", password: "anything" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Invalid email or password.");
  });

  // ── 2. Existing email + wrong password → 401 same generic ────────────
  it("returns 401 'Invalid email or password.' for an existing email with a wrong password", async () => {
    const existing = makeAccess({ status: "active" });
    const store = makeFakeStore({
      listPortalAccessByEmail: vi.fn(async () => [existing]),
      getPortalAccessByEmailAnyTenant: vi.fn(async () => existing),
      verifyPortalCredentialsByEmail: vi.fn(async () => null), // wrong password
    });
    Object.assign(mockStore as object, store);

    const res = await POST(makeReq({ email: "bob@example.com", password: "WRONG" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Invalid email or password.");
  });

  // ── 3. Existing email + correct password + account suspended → 401
  //        SAME generic (fix 8b-5) ───────────────────────────────────────
  it("returns 401 'Invalid email or password.' for a suspended account with correct password (8b-5)", async () => {
    // The suspended-account flow: `existing` lookup returns a row with
    // status="suspended"; `verifyPortalCredentialsByEmail` returns null
    // (the store layer rejects credentials for suspended accounts); the
    // route's old `existing.status === "suspended"` branch was REMOVED
    // (fix 8b-5), so it falls through to the uniform 401 below.
    const suspended = makeAccess({ status: "suspended" });
    const store = makeFakeStore({
      listPortalAccessByEmail: vi.fn(async () => [suspended]),
      getPortalAccessByEmailAnyTenant: vi.fn(async () => suspended),
      verifyPortalCredentialsByEmail: vi.fn(async () => null), // credentials rejected for suspended
    });
    Object.assign(mockStore as object, store);

    const res = await POST(makeReq({ email: "bob@example.com", password: "correct-password" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Invalid email or password.");
    // The detailed reason is still captured in the audit log (audit-
    // internal-only, never in the HTTP response).
    expect(mockAudit).toHaveBeenCalled();
    const auditCall = mockAudit.mock.calls[0];
    // The 6th positional arg is the `details` object — it carries
    // `reason: "invalid_credentials"` for the suspended-but-correct-pwd case.
    expect(auditCall?.[6]?.reason).toBe("invalid_credentials");
  });

  // ── 4. Existing email + correct password + multiple tenants → 409 with
  //        `multiple_tenants: true, tenants: [{tenant_id: "..."}]` and NO
  //        `tenant_name` field (fix 8b-4 / 8a-10) ────────────────────────
  it("returns 409 multiple_tenants with only opaque tenant_ids (no tenant_name leak — 8b-4/8a-10)", async () => {
    const pa1 = makeAccess({ id: "pa-1", tenant_id: "tenant-A" });
    const pa2 = makeAccess({ id: "pa-2", tenant_id: "tenant-B" });
    const store = makeFakeStore({
      listPortalAccessByEmail: vi.fn(async () => [pa1, pa2]),
      // The route returns 409 BEFORE calling these, but keep them as
      // no-ops so the test breaks loudly if the route logic regresses.
      getPortalAccessByEmailAnyTenant: vi.fn(async () => null),
      verifyPortalCredentialsByEmail: vi.fn(async () => null),
    });
    Object.assign(mockStore as object, store);

    const res = await POST(makeReq({ email: "bob@example.com", password: "any-password" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.multiple_tenants).toBe(true);
    expect(Array.isArray(body.tenants)).toBe(true);
    expect(body.tenants).toHaveLength(2);
    // Each tenant entry is { tenant_id: "..." } — and NOTHING ELSE.
    for (const t of body.tenants) {
      expect(t).toHaveProperty("tenant_id");
      expect(Object.keys(t).sort()).toEqual(["tenant_id"]);
    }
    // The tenant_ids are the opaque UUIDs from the portal_access rows.
    const tenantIds = body.tenants.map((t: any) => t.tenant_id).sort();
    expect(tenantIds).toEqual(["tenant-A", "tenant-B"]);
    // CRITICAL: no `tenant_name` is surfaced anywhere in the response —
    // an unauthenticated attacker probing an email can no longer walk
    // away with the list of organizations that email is registered with.
    expect(JSON.stringify(body)).not.toContain("tenant_name");
    expect(JSON.stringify(body)).not.toContain("Acme");
    expect(JSON.stringify(body)).not.toContain("Unknown");
  });

  // ── 5. The 3 401 responses (cases 1-3) are byte-identical in body ─────
  it("emits byte-identical 401 bodies for the no-such-email / wrong-password / suspended-account cases (no leak via different wording)", async () => {
    // Case 1 — non-existent email.
    const store1 = makeFakeStore({
      listPortalAccessByEmail: vi.fn(async () => []),
      getPortalAccessByEmailAnyTenant: vi.fn(async () => null),
      verifyPortalCredentialsByEmail: vi.fn(async () => null),
    });
    Object.assign(mockStore as object, store1);
    const res1 = await POST(makeReq({ email: "nobody@example.com", password: "anything" }));
    const body1 = await res1.json();

    // Case 2 — existing email + wrong password.
    const existing = makeAccess({ status: "active" });
    const store2 = makeFakeStore({
      listPortalAccessByEmail: vi.fn(async () => [existing]),
      getPortalAccessByEmailAnyTenant: vi.fn(async () => existing),
      verifyPortalCredentialsByEmail: vi.fn(async () => null),
    });
    Object.assign(mockStore as object, store2);
    const res2 = await POST(makeReq({ email: "bob@example.com", password: "WRONG" }));
    const body2 = await res2.json();

    // Case 3 — existing email + correct password + suspended.
    const suspended = makeAccess({ status: "suspended" });
    const store3 = makeFakeStore({
      listPortalAccessByEmail: vi.fn(async () => [suspended]),
      getPortalAccessByEmailAnyTenant: vi.fn(async () => suspended),
      verifyPortalCredentialsByEmail: vi.fn(async () => null),
    });
    Object.assign(mockStore as object, store3);
    const res3 = await POST(makeReq({ email: "bob@example.com", password: "correct" }));
    const body3 = await res3.json();

    // All three: 401, same body.
    expect(res1.status).toBe(401);
    expect(res2.status).toBe(401);
    expect(res3.status).toBe(401);

    // Byte-identical body JSON. Comparing the parsed+re-stringified form
    // catches ordering / extra-key / different-value leaks. The bodies
    // MUST be byte-identical so an attacker probing with timing equalised
    // can't distinguish the three failure cases from one another.
    expect(JSON.stringify(body1)).toBe(JSON.stringify(body2));
    expect(JSON.stringify(body2)).toBe(JSON.stringify(body3));
    // And the shared body is exactly { error: "Invalid email or password." }.
    expect(body1).toEqual({ error: "Invalid email or password." });
  });
});
