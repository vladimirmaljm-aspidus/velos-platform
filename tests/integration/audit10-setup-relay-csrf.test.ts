import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type { AuthContext } from "@/lib/api/helpers";
import type { User } from "@/lib/supabase/types";

// 11-B-v2 / 9b-N12: route-level tests for
// src/app/api/setup-relay/route.ts.
//
// Covers:
//   1. GET /api/setup-relay → 405 with `Allow: POST` header (CSRF vector
//      closed — fix 9b-N12: state-changing GET was a CSRF vector because
//      an attacker could embed `<img src="/api/setup-relay?host=evil.com">`
//      in any page the super_admin visits; the browser would issue the
//      request with the super_admin's session cookie attached. Defense-in-
//      depth: state changes only via POST).
//   2. POST with valid super_admin auth → 200 (host captured).
//   3. POST without super_admin auth → 403.
//
// Mocking strategy:
//   • `@/lib/api/helpers` `requireSuperAdmin` is the only helper the route
//     imports — mocked to return either a fake super_admin AuthContext
//     (success) or a 403 NextResponse (denial).
//   • `fs` `writeFileSync` + `appendFileSync` + `existsSync` stubbed to no-
//     ops to avoid /tmp side effects during tests.
//   • `fetch` (global) is mocked via vi.stubGlobal to a no-op for the
//     VERCEL_TOKEN branch (which we won't exercise in these tests — we
//     leave VERCEL_TOKEN unset so the route takes the local-capture path).
//   • `process.env` is stubbed via vi.stubEnv for ALLOWED_HOST + VERCEL_TOKEN
//     + VERCEL_PROJECT_ID + NEXT_PUBLIC_APP_URL so the host-allowlist logic
//     is deterministic.

const { mockRequireSuperAdmin } = vi.hoisted(() => ({
  mockRequireSuperAdmin: vi.fn(),
}));

vi.mock("@/lib/api/helpers", () => ({
  requireSuperAdmin: mockRequireSuperAdmin,
}));

vi.mock("fs", () => ({
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

import { POST, GET } from "@/app/api/setup-relay/route";

// ── Test fixtures ────────────────────────────────────────────────────────

function makeSuperAdminUser(over: Partial<User> = {}): User {
  return {
    id: "u-super",
    tenant_id: null,
    username: "root",
    email: "root@example.com",
    full_name: "Root",
    role: "super_admin",
    permissions: null,
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

function makeSuperAdminAuth(): AuthContext {
  const user = makeSuperAdminUser();
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
    store: {} as any,
    ip: "1.2.3.4",
    tenantId: null,
    isSuperAdmin: true,
    impersonation: undefined,
  };
}

function makeReq(method: "GET" | "POST", headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new Request("http://localhost/api/setup-relay", {
    method,
    headers: { "content-type": "application/json", ...headers },
  }));
}

describe("/api/setup-relay (9b-N12 — CSRF vector closed)", () => {
  beforeEach(() => {
    mockRequireSuperAdmin.mockReset();
    // Sensible defaults: stub env so the host-allowlist is deterministic
    // and VERCEL_TOKEN is unset (route takes the local-capture success
    // path, no external fetch).
    vi.stubEnv("ALLOWED_HOST", "example.com");
    vi.stubEnv("VERCEL_TOKEN", "");
    vi.stubEnv("VERCEL_PROJECT_ID", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://example.com");
    vi.stubEnv("APP_BASE_URL", "https://example.com");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ── 1. GET → 405 + Allow: POST (9b-N12) ─────────────────────────────
  it("rejects GET with 405 + Allow: POST header (state-changing GET was a CSRF vector)", async () => {
    // No auth needed — the GET handler 405s before any auth check.
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/Method Not Allowed/i);
    // 9b-N12: the body MUST NOT reflect the request URL or headers (would
    // be an information-leak on a probe).
    expect(JSON.stringify(body)).not.toContain("evil");
    expect(JSON.stringify(body)).not.toContain("host=");
  });

  // ── 2. POST with valid super_admin auth → 200 (host captured) ───────
  it("returns 200 and captures the host when a super_admin POSTs an allow-listed host", async () => {
    mockRequireSuperAdmin.mockResolvedValue(makeSuperAdminAuth());

    const res = await POST(makeReq("POST", {
      host: "example.com",
      "x-forwarded-proto": "https",
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.captured).toBe(true);
    expect(body.host).toContain("example.com");
  });

  // ── 3. POST without super_admin auth → 403 ───────────────────────────
  it("returns 403 when the caller is NOT a super_admin", async () => {
    mockRequireSuperAdmin.mockResolvedValue(
      NextResponse.json({ error: "Super-admin access required." }, { status: 403 }),
    );

    const res = await POST(makeReq("POST", { host: "example.com" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/Super-admin/i);
  });
});
