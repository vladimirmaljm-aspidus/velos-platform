import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type { AuthContext } from "@/lib/api/helpers";

// ── Route tests for /api/admin/errors (task 8-c) ────────────────────────────
//
// Covers:
//   • auth: 401 without a session (requireAuth gate) — listErrors is never
//     reached; 403 when the audit.read permission check denies
//   • tenant scoping: tenant admins get listErrors/errorStats scoped to
//     their tenant; super_admins get the cross-tenant view (undefined)
//   • filter parsing from searchParams (source/level/resolved/q/limit/offset)
//   • response shape { items, total, stats }
//   • PUT resolve / unresolve: body validation, resolveError call shape,
//     audit_logs event ("error_audit.resolve"), 404 on missing rows
//   • the route records its OWN 500s as source 'server' (dogfooding)
//
// Mock strategy (mirrors tests/integration/audit10-dashboard-rate-limit):
//   • requireAuth is mocked to return either a 401 NextResponse or a full
//     AuthContext (tenant admin / super-admin flavours)
//   • requirePermission (dynamic import) returns null (allowed) or a 403
//   • the error-audit data layer is spied — it has its own unit tests

const { mockRequireAuth, mockAudit, mockListErrors, mockErrorStats, mockResolveError, mockUnresolveError, mockRecordError } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockAudit: vi.fn(async () => {}),
  mockListErrors: vi.fn(),
  mockErrorStats: vi.fn(),
  mockResolveError: vi.fn(),
  mockUnresolveError: vi.fn(),
  mockRecordError: vi.fn(async () => null),
}));

vi.mock("@/lib/api/helpers", () => ({
  requireAuth: mockRequireAuth,
  audit: mockAudit,
  getAuthUser: (auth: AuthContext) => auth.user,
  sanitizeError: vi.fn((e: unknown) => String(e)),
  getIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("@/lib/monitoring/error-audit", () => ({
  listErrors: mockListErrors,
  errorStats: mockErrorStats,
  resolveError: mockResolveError,
  unresolveError: mockUnresolveError,
  recordError: mockRecordError,
}));

vi.mock("@/lib/permissions/can", () => ({
  requirePermission: vi.fn(() => null),
}));

import { GET, PUT } from "@/app/api/admin/errors/route";

function makeAuthCtx(over: Partial<AuthContext> = {}): AuthContext {
  return {
    user: {
      id: "u-1",
      tenant_id: "tenant-A",
      username: "dejan",
      email: "dejan@aspidus.co",
      full_name: null,
      role: "admin",
      permissions: null,
      active: true,
      token_version: 1,
    } as unknown as AuthContext["user"],
    store: { appendAudit: vi.fn(async () => ({})) } as unknown as AuthContext["store"],
    ip: "127.0.0.1",
    tenantId: "tenant-A",
    isSuperAdmin: false,
    ...over,
  };
}

function getReq(path = "/api/admin/errors"): NextRequest {
  return new NextRequest(new Request(`http://localhost${path}`, { method: "GET" }));
}

function putReq(body: unknown): NextRequest {
  return new NextRequest(new Request("http://localhost/api/admin/errors", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

const STATS_FIXTURE = { total: 12, open: 5, client: 9, server: 3, last24h: 4 };

beforeEach(() => {
  mockRequireAuth.mockReset();
  mockRequireAuth.mockImplementation(async () => makeAuthCtx());
  mockAudit.mockClear();
  mockListErrors.mockReset();
  mockListErrors.mockImplementation(async () => ({
    items: [{ id: "e-1", source: "client", level: "error", message: "boom", occurrence_count: 2 }],
    total: 1,
  }));
  mockErrorStats.mockReset();
  mockErrorStats.mockImplementation(async () => ({ ...STATS_FIXTURE }));
  mockResolveError.mockReset();
  mockResolveError.mockImplementation(async () => true);
  mockUnresolveError.mockReset();
  mockUnresolveError.mockImplementation(async () => true);
  mockRecordError.mockClear();
});

// ── Auth ────────────────────────────────────────────────────────────────────

describe("admin errors — auth gate", () => {
  it("GET returns 401 without a session and never touches the data layer", async () => {
    mockRequireAuth.mockImplementation(async () =>
      NextResponse.json({ error: "Not authenticated." }, { status: 401 }),
    );
    const res = await GET(getReq());
    expect(res.status).toBe(401);
    expect(mockListErrors).not.toHaveBeenCalled();
    expect(mockErrorStats).not.toHaveBeenCalled();
  });

  it("PUT returns 401 without a session", async () => {
    mockRequireAuth.mockImplementation(async () =>
      NextResponse.json({ error: "Not authenticated." }, { status: 401 }),
    );
    const res = await PUT(putReq({ id: "e-1", resolved: true }));
    expect(res.status).toBe(401);
    expect(mockResolveError).not.toHaveBeenCalled();
  });

  it("GET returns 403 when the audit.read permission is denied", async () => {
    const { requirePermission } = await import("@/lib/permissions/can");
    (requirePermission as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      NextResponse.json({ error: "Insufficient permissions." }, { status: 403 }),
    );
    const res = await GET(getReq());
    expect(res.status).toBe(403);
    expect(mockListErrors).not.toHaveBeenCalled();
  });
});

// ── GET: filters + scoping + shape ──────────────────────────────────────────

describe("admin errors — GET", () => {
  it("returns { items, total, stats } with no-store", async () => {
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.stats).toEqual(STATS_FIXTURE);
  });

  it("scopes listErrors + errorStats to the tenant admin's tenant", async () => {
    await GET(getReq());
    expect(mockListErrors).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-A" }));
    expect(mockErrorStats).toHaveBeenCalledWith("tenant-A");
  });

  it("gives super_admins the cross-tenant view (tenantId undefined)", async () => {
    mockRequireAuth.mockImplementation(async () =>
      makeAuthCtx({ isSuperAdmin: true, tenantId: null }),
    );
    await GET(getReq());
    expect(mockListErrors).toHaveBeenCalledWith(expect.objectContaining({ tenantId: undefined }));
    expect(mockErrorStats).toHaveBeenCalledWith(undefined);
  });

  it("parses source/level/resolved/q/limit/offset from searchParams", async () => {
    await GET(getReq("/api/admin/errors?source=client&level=error&resolved=open&q=boom&limit=25&offset=50"));
    expect(mockListErrors).toHaveBeenCalledWith({
      tenantId: "tenant-A",
      source: "client",
      level: "error",
      resolved: "open",
      q: "boom",
      limit: 25,
      offset: 50,
    });
  });

  it("caps limit at 500 and falls back to defaults", async () => {
    await GET(getReq("/api/admin/errors?limit=99999&offset=-5"));
    expect(mockListErrors).toHaveBeenCalledWith(expect.objectContaining({ limit: 500, offset: 0 }));
  });

  it("records its own 500s as source 'server' (dogfooding)", async () => {
    mockListErrors.mockImplementation(async () => { throw new Error("db exploded"); });
    const res = await GET(getReq());
    expect(res.status).toBe(500);
    expect(mockRecordError).toHaveBeenCalledTimes(1);
    const input = mockRecordError.mock.calls[0][0] as Record<string, unknown>;
    expect(input.source).toBe("server");
    expect(input.message).toBe("db exploded");
    expect(input.url).toBe("/api/admin/errors");
  });
});

// ── PUT: resolve / unresolve ────────────────────────────────────────────────

describe("admin errors — PUT resolve / unresolve", () => {
  it("resolves: calls resolveError with (id, email, tenantId) + writes the audit event", async () => {
    const res = await PUT(putReq({ id: "e-1", resolved: true }));
    expect(res.status).toBe(200);
    expect(mockResolveError).toHaveBeenCalledWith("e-1", "dejan@aspidus.co", "tenant-A");
    expect(mockUnresolveError).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledTimes(1);
    const [, user, , action, entityType, entityId] = mockAudit.mock.calls[0];
    expect(action).toBe("error_audit.resolve");
    expect(entityType).toBe("error_log");
    expect(entityId).toBe("e-1");
    expect(user.username).toBe("dejan");
  });

  it("re-opens: calls unresolveError + writes the unresolve audit event", async () => {
    const res = await PUT(putReq({ id: "e-1", resolved: false }));
    expect(res.status).toBe(200);
    expect(mockUnresolveError).toHaveBeenCalledWith("e-1", "tenant-A");
    expect(mockResolveError).not.toHaveBeenCalled();
    expect(mockAudit.mock.calls[0][3]).toBe("error_audit.unresolve");
  });

  it("super_admin resolves cross-tenant (tenantId undefined)", async () => {
    mockRequireAuth.mockImplementation(async () =>
      makeAuthCtx({ isSuperAdmin: true, tenantId: null }),
    );
    await PUT(putReq({ id: "e-9", resolved: true }));
    expect(mockResolveError).toHaveBeenCalledWith("e-9", "dejan@aspidus.co", undefined);
  });

  it("returns 400 on an invalid body", async () => {
    expect((await PUT(putReq({ id: "e-1" }))).status).toBe(400);       // resolved missing
    expect((await PUT(putReq({ resolved: true }))).status).toBe(400);  // id missing
    expect((await PUT(putReq({ id: 42, resolved: true }))).status).toBe(400);
    expect((await PUT(putReq("not json"))).status).toBe(400);
    expect(mockResolveError).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("returns 404 when the row is missing / already in the target state", async () => {
    mockResolveError.mockImplementation(async () => false);
    const res = await PUT(putReq({ id: "ghost", resolved: true }));
    expect(res.status).toBe(404);
    // No audit entry for a no-op failure.
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
