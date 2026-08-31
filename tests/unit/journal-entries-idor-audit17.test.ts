import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// AUDIT17 / P0 — journal-entries POST IDOR fix.
//
// The RPC upsert_journal_entry (migration 038) matched its UPDATE purely on
// `WHERE id = v_id` with NO tenant filter and reassigned tenant_id from the
// payload — a POST carrying a victim entry's id silently MOVED that entry
// (and replaced its lines) into the caller's tenant, and the same path
// bypassed PUT's draft-only guard (posted ledger rows could be rewritten).
//
// Route-level defense (this test): body.id present → entry must exist,
// belong to THIS tenant, and be a draft. status/posted_by/posted_at are
// stripped from the payload before the upsert.

const { mockRequireAuth, mockGetStore, mockAudit } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockGetStore: vi.fn(),
  mockAudit: vi.fn(async () => {}),
}));

vi.mock("@/lib/api/helpers", () => ({
  requireAuth: mockRequireAuth,
  resolveTenantId: vi.fn((auth: any) => auth.tenantId ?? null),
  audit: mockAudit,
  sanitizeError: vi.fn((e: any) => e?.message || "error"),
}));

vi.mock("@/lib/supabase/client", () => ({
  getSupabase: vi.fn(() => ({
    // erp_accounts validation: return every requested account id as valid;
    // fiscal_periods: no period configured (open).
    from: (table: string) => {
      if (table === "erp_accounts") {
        return {
          select: () => ({
            eq: () => ({
              in: (_col: string, ids: string[]) =>
                Promise.resolve({ data: ids.map((id) => ({ id })), error: null }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            lte: () => ({
              gte: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
              }),
            }),
          }),
        }),
      };
    },
  })),
  isSupabaseConfigured: vi.fn(() => true),
}));

vi.mock("@/lib/permissions/can", () => ({
  requirePermission: vi.fn(() => null),
}));

vi.mock("@/lib/api/feature-guard", () => ({
  requireFeature: vi.fn(async () => null),
}));

beforeEach(() => {
  vi.resetModules();
  mockRequireAuth.mockReset();
  mockGetStore.mockReset();
});

function jsonReq(body: unknown) {
  return new NextRequest("http://localhost/api/erp/journal-entries", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function makeAuth(store: any) {
  return {
    user: { id: "u1", username: "accountant", role: "user" },
    tenantId: "tenant-A",
    isSuperAdmin: false,
    store,
  };
}

const LINES = [
  { account_id: "acc-1", description: "L1", debit: 100, credit: 0 },
  { account_id: "acc-2", description: "L2", debit: 0, credit: 100 },
];

describe("AUDIT17 P0 — journal-entries POST IDOR guard", () => {
  it("404s when body.id references another tenant's entry (no cross-tenant move)", async () => {
    const upsertErpJournalEntry = vi.fn(async (m: any) => ({ id: m.id, ...m }));
    const store = {
      getErpJournalEntry: vi.fn(async (id: string) => ({ id, tenant_id: "tenant-B", status: "draft" })),
      upsertErpJournalEntry,
      listErpJournalEntries: vi.fn(async () => ({ items: [], total: 0 })),
    } as any;
    mockGetStore.mockResolvedValue(store);
    mockRequireAuth.mockResolvedValue(makeAuth(store));

    const { POST } = await import("@/app/api/erp/journal-entries/route");
    const res = await POST(jsonReq({ id: "victim-entry", lines: LINES }));
    expect(res.status).toBe(404);
    expect(upsertErpJournalEntry).not.toHaveBeenCalled();
  });

  it("409s when body.id references a POSTED entry (draft-only rewrite guard)", async () => {
    const upsertErpJournalEntry = vi.fn(async (m: any) => ({ id: m.id, ...m }));
    const store = {
      getErpJournalEntry: vi.fn(async (id: string) => ({ id, tenant_id: "tenant-A", status: "posted" })),
      upsertErpJournalEntry,
      listErpJournalEntries: vi.fn(async () => ({ items: [], total: 0 })),
    } as any;
    mockGetStore.mockResolvedValue(store);
    mockRequireAuth.mockResolvedValue(makeAuth(store));

    const { POST } = await import("@/app/api/erp/journal-entries/route");
    const res = await POST(jsonReq({ id: "posted-entry", lines: LINES }));
    expect(res.status).toBe(409);
    expect(upsertErpJournalEntry).not.toHaveBeenCalled();
  });

  it("strips status/posted_by/posted_at from the upsert payload (only /post may set them)", async () => {
    const upsertErpJournalEntry = vi.fn(async (m: any) => ({ id: m.id, entry_number: "JE-1", ...m }));
    const store = {
      getErpJournalEntry: vi.fn(async (id: string) => ({ id, tenant_id: "tenant-A", status: "draft" })),
      upsertErpJournalEntry,
      listErpJournalEntries: vi.fn(async () => ({ items: [], total: 0 })),
    } as any;
    mockGetStore.mockResolvedValue(store);
    mockRequireAuth.mockResolvedValue(makeAuth(store));

    const { POST } = await import("@/app/api/erp/journal-entries/route");
    const res = await POST(jsonReq({
      id: "own-draft",
      lines: LINES,
      status: "posted",          // SoD bypass attempt
      posted_by: "u1",
      posted_at: "2026-01-01T00:00:00Z",
    }));
    expect(res.status).toBeLessThan(400);
    const saved = upsertErpJournalEntry.mock.calls[0][0] as any;
    expect(saved.status).toBeUndefined();
    expect(saved.posted_by).toBeUndefined();
    expect(saved.posted_at).toBeUndefined();
    expect(saved.tenant_id).toBe("tenant-A");
  });

  it("still creates a fresh draft when no body.id is given (no regression)", async () => {
    const upsertErpJournalEntry = vi.fn(async (m: any) => ({ id: "new-1", entry_number: "JE-2", ...m }));
    const store = {
      getErpJournalEntry: vi.fn(async () => null),
      upsertErpJournalEntry,
      listErpJournalEntries: vi.fn(async () => ({ items: [], total: 0 })),
    } as any;
    mockGetStore.mockResolvedValue(store);
    mockRequireAuth.mockResolvedValue(makeAuth(store));

    const { POST } = await import("@/app/api/erp/journal-entries/route");
    const res = await POST(jsonReq({ lines: LINES }));
    expect(res.status).toBeLessThan(400);
    expect(upsertErpJournalEntry).toHaveBeenCalledTimes(1);
  });
});
