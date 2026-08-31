import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// AUDIT17 / F1 — VAT sum invariant: the stored line-item totals must sum to
// the stored document total (and subtotal/discount/tax must be consistent
// with the rounded per-line components). Previously the header summed
// UNROUNDED amounts while each line was rounded to 2dp: two lines of 10.254
// printed 10.25 + 10.25 = 20.50 against a header total of 20.51 — a VAT
// document whose lines don't add up is rejected by tax authorities.
//
// Exercised through the REAL /api/invoices POST handler with the standard
// auth/store mock harness used across the audit test suites.

const { mockRequireAuthOrApiKey, mockGetStore, mockGetSupabase, mockTriggerWebhooks, mockWithApm, mockAudit } =
  vi.hoisted(() => ({
    mockRequireAuthOrApiKey: vi.fn(),
    mockGetStore: vi.fn(),
    mockGetSupabase: vi.fn(() => ({ from: () => ({ rpc: vi.fn() }) })),
    mockTriggerWebhooks: vi.fn(async () => {}),
    mockWithApm: vi.fn((fn: any, _n: string) => fn),
    mockAudit: vi.fn(async () => {}),
  }));

vi.mock("@/lib/api/helpers", () => ({
  requireAuthOrApiKey: mockRequireAuthOrApiKey,
  resolveTenantId: vi.fn((auth: any) => auth.tenantId ?? null),
  hasPermission: vi.fn(() => true),
  audit: mockAudit,
  sanitizeError: vi.fn((e: any) => e?.message || "error"),
  getAuthUser: vi.fn((auth: any) => auth.user),
}));

vi.mock("@/lib/supabase/client", () => ({
  getSupabase: mockGetSupabase,
  isSupabaseConfigured: vi.fn(() => true),
}));

vi.mock("@/lib/webhooks/deliver", () => ({
  triggerWebhooks: mockTriggerWebhooks,
}));

vi.mock("@/lib/monitoring/apm", () => ({
  withApm: mockWithApm,
}));

vi.mock("@/lib/permissions/can", () => ({
  requirePermission: vi.fn(() => null),
}));

vi.mock("@/lib/api/feature-guard", () => ({
  requireFeature: vi.fn(async () => null),
}));

vi.mock("@/lib/api/plan-limits", () => ({
  enforceQuota: vi.fn(async () => null),
}));

beforeEach(() => {
  vi.resetModules();
  mockRequireAuthOrApiKey.mockReset();
  mockGetStore.mockReset();
});

function makeAuth(store: any) {
  return {
    user: { id: "u1", username: "admin", role: "admin" },
    tenantId: "t1",
    isSuperAdmin: false,
    store,
  };
}

function jsonReq(body: unknown) {
  return new NextRequest("http://localhost/api/invoices", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("AUDIT17 F1 — invoice totals sum the rounded line components", () => {
  it("line totals sum EXACTLY to the document total (no ±0.01 drift)", async () => {
    const upsertInvoice = vi.fn(async (m: any) => ({ id: "inv-1", ...m }));
    const store = {
      getOffer: vi.fn(async () => null),
      getPartner: vi.fn(async () => ({ id: "p1", tenant_id: "t1", name: "P", email: "p@example.com" })),
      createDocWithNumber: vi.fn(async (_t: string, m: any) => ({ id: "inv-1", number: "INV-2026-0001", ...m })),
      upsertInvoice,
      listInvoices: vi.fn(async () => ({ items: [], total: 0 })),
    } as any;
    mockGetStore.mockResolvedValue(store);
    mockRequireAuthOrApiKey.mockResolvedValue(makeAuth(store));

    const res = await POST(jsonReq({
      tenant_id: "t1",
      partner_id: "p1",
      currency: "EUR",
      items: [
        { description: "A", quantity: 3, unit_price: 3.418, tax_rate: 0, discount: 0 },
        { description: "B", quantity: 3, unit_price: 3.418, tax_rate: 0, discount: 0 },
      ],
    }));
    if (res.status >= 400) { throw new Error("ROUTE ERROR: " + (await res.text())); }
    const saved = ((store.createDocWithNumber as any).mock.calls[0]?.[1] ?? upsertInvoice.mock.calls[0]?.[0]) as any;
    const lineSum = Math.round(saved.items.reduce((s: number, it: any) => s + it.total, 0) * 100) / 100;
    expect(Math.abs(lineSum - saved.total)).toBeLessThanOrEqual(0.0001);
    // The specific historical failure: each line rounds to 10.25 (3×3.418 =
    // 10.254 → 10.25), so lines sum to 20.50 — the header must NOT say 20.51.
    expect(saved.items[0].total).toBe(10.25);
    expect(saved.total).toBe(20.5);
  });

  it("rejects discount > 100 and negative tax_rate (F2 range validation)", async () => {
    const upsertInvoice = vi.fn(async (m: any) => ({ id: "inv-2", ...m }));
    const store = {
      getOffer: vi.fn(async () => null),
      getPartner: vi.fn(async () => ({ id: "p1", tenant_id: "t1", name: "P", email: "p@example.com" })),
      createDocWithNumber: vi.fn(async () => null),
      upsertInvoice,
      listInvoices: vi.fn(async () => ({ items: [], total: 0 })),
    } as any;
    mockGetStore.mockResolvedValue(store);
    mockRequireAuthOrApiKey.mockResolvedValue(makeAuth(store));

    const res1 = await POST(jsonReq({
      tenant_id: "t1", partner_id: "p1", currency: "EUR",
      items: [{ description: "A", quantity: 1, unit_price: 10, tax_rate: 0, discount: 150 }],
    }));
    expect(res1.status).toBe(400);
    expect((await res1.json()).error).toContain("discount");

    const res2 = await POST(jsonReq({
      tenant_id: "t1", partner_id: "p1", currency: "EUR",
      items: [{ description: "A", quantity: 1, unit_price: 10, tax_rate: -5, discount: 0 }],
    }));
    expect(res2.status).toBe(400);
    expect((await res2.json()).error).toContain("tax_rate");
  });
});

import { POST } from "@/app/api/invoices/route";
