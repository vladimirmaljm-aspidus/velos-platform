import { describe, it, expect, vi, beforeEach } from "vitest";

// 092 — RFQ attachments (portal_uploads.rfq_id link).
//
// Covers the security-critical part of the flow in
// src/lib/portal/rfq-attachments.ts:
//   1. linkRfqAttachments VALIDATES ownership: upload rows that belong to
//      another partner / tenant, or that are soft-deleted, are NEVER
//      linked (the update only touches validated rows).
//   2. Non-array / garbage attachment_ids inputs are a no-op (0 links).
//   3. attachToRfqs enriches list rows with attachments (empty array when
//      an RFQ has none — the UI must be able to rely on the field).
//   4. attachmentsForRfqs maps rfq_id → metadata rows and degrades to an
//      empty Map on error (pre-migration state — listing never 500s).
//
// Mocking: @/lib/supabase/client getSupabase() → fake builder chain whose
// select-results / update-results are programmed per-test via `state`.

const state = {
  selectData: null as unknown,
  selectError: null as unknown,
  updateError: null as unknown,
  updatedIds: [] as unknown[],
};

// Select-side chain: every builder method (in/eq/is/order) returns the
// proxy itself, and awaiting it resolves the programmed select result.
const proxy: any = () => proxy;
proxy.in = proxy;
proxy.eq = proxy;
proxy.is = proxy;
proxy.order = proxy;
proxy.limit = proxy;
proxy.maybeSingle = proxy;
proxy.then = (onFulfilled: any, onRejected: any) =>
  Promise.resolve({ data: state.selectData, error: state.selectError }).then(onFulfilled, onRejected);

// Update-side chain: .in("id", ids) records the ids for assertions and
// resolves the programmed update result.
const updateProxy: any = () => updateProxy;
const inSpy = vi.fn((col: string, ids: unknown) => {
  state.updatedIds = ids;
  const res: any = () => res;
  res.then = (onFulfilled: any, onRejected: any) =>
    Promise.resolve({ data: null, error: state.updateError }).then(onFulfilled, onRejected);
  return res;
});
updateProxy.in = inSpy;

vi.mock("@/lib/supabase/client", () => ({
  getSupabase: () => ({
    from: vi.fn((table: string) => {
      if (table !== "portal_uploads") throw new Error("unexpected table: " + table);
      return {
        // select(...) → thenable chainable proxy (eq/in/is/order all no-ops)
        select: vi.fn(() => proxy),
        // update({...}) → chainable with .in recording
        update: vi.fn(() => updateProxy),
      };
    }),
  }),
}));

import {
  linkRfqAttachments,
  attachmentsForRfqs,
  attachToRfqs,
  MAX_RFQ_ATTACHMENTS,
} from "@/lib/portal/rfq-attachments";

const TENANT = "tenant-a";
const PARTNER = "partner-1";

function uploadRow(over: Record<string, unknown> = {}) {
  return {
    id: "u-" + Math.random().toString(36).slice(2, 8),
    tenant_id: TENANT,
    partner_id: PARTNER,
    deleted_at: null,
    rfq_id: null,
    filename: "spec.pdf",
    mime_type: "application/pdf",
    size_bytes: 1024,
    category: "rfq",
    uploaded_at: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => {
  state.selectData = null;
  state.selectError = null;
  state.updateError = null;
  state.updatedIds = [];
  inSpy.mockClear();
});

describe("linkRfqAttachments", () => {
  it("links only rows owned by the same tenant+partner and not deleted", async () => {
    const mine = uploadRow({ id: "mine" });
    const otherPartner = uploadRow({ id: "other-partner", partner_id: "partner-2" });
    const otherTenant = uploadRow({ id: "other-tenant", tenant_id: "tenant-b" });
    const deleted = uploadRow({ id: "deleted", deleted_at: new Date().toISOString() });
    state.selectData = [mine, otherPartner, otherTenant, deleted];

    const n = await linkRfqAttachments(TENANT, PARTNER, "rfq-1", [
      "mine", "other-partner", "other-tenant", "deleted",
    ]);
    expect(n).toBe(1);
    // The update only ever receives the VALIDATED ids.
    expect(state.updatedIds).toEqual(["mine"]);
  });

  it("returns 0 for non-array input", async () => {
    const n = await linkRfqAttachments(TENANT, PARTNER, "rfq-1", "not-an-array");
    expect(n).toBe(0);
    expect(inSpy).not.toHaveBeenCalled();
  });

  it("returns 0 for arrays of non-strings", async () => {
    const n = await linkRfqAttachments(TENANT, PARTNER, "rfq-1", [1, null, {}, true]);
    expect(n).toBe(0);
    expect(inSpy).not.toHaveBeenCalled();
  });

  it("caps the number of ids processed at MAX_RFQ_ATTACHMENTS", async () => {
    // The mock select returns every row in state regardless of the .in
    // filter, so program it with exactly the rows a real .in(ids.slice(0,10))
    // would return: the first 10 of the 20 requested.
    state.selectData = Array.from({ length: MAX_RFQ_ATTACHMENTS }, (_, i) =>
      uploadRow({ id: "bulk-" + i }),
    );
    const manyIds = Array.from({ length: 20 }, (_, i) => "bulk-" + i);
    const n = await linkRfqAttachments(TENANT, PARTNER, "rfq-1", manyIds);
    expect(n).toBe(MAX_RFQ_ATTACHMENTS);
    // And only the capped ids ever reach the update.
    expect((state.updatedIds as string[]).every((x) => manyIds.slice(0, 10).includes(x))).toBe(true);
  });

  it("returns 0 when the select fails (pre-migration 42P01)", async () => {
    state.selectError = { message: 'column "rfq_id" of relation "portal_uploads" does not exist' };
    state.selectData = null;
    const n = await linkRfqAttachments(TENANT, PARTNER, "rfq-1", ["u-x"]);
    expect(n).toBe(0);
    expect(inSpy).not.toHaveBeenCalled();
  });

  it("returns 0 when the update fails (permission / RLS)", async () => {
    state.selectData = [uploadRow({ id: "ok" })];
    state.updateError = { message: "row-level security policy violation" };
    const n = await linkRfqAttachments(TENANT, PARTNER, "rfq-1", ["ok"]);
    expect(n).toBe(0);
  });
});

describe("attachToRfqs", () => {
  it("attaches an empty array to RFQs with no uploads", () => {
    const rfqs = [{ id: "rfq-1" }, { id: "rfq-2" }];
    const out = attachToRfqs(rfqs, new Map());
    expect(out[0].attachments).toEqual([]);
    expect(out[1].attachments).toEqual([]);
  });

  it("groups uploads per rfq", () => {
    const byRfq = new Map([
      ["rfq-1", [{ id: "u-1", filename: "a.pdf", mime_type: "application/pdf", size_bytes: 5, category: "rfq", uploaded_at: "2026-01-01" }]],
    ]);
    const out = attachToRfqs([{ id: "rfq-1" }, { id: "rfq-2" }], byRfq);
    expect(out[0].attachments!.length).toBe(1);
    expect(out[0].attachments![0].filename).toBe("a.pdf");
    expect(out[1].attachments).toEqual([]);
  });
});

describe("attachmentsForRfqs", () => {
  it("returns an empty Map for an empty id list", async () => {
    const m = await attachmentsForRfqs(TENANT, []);
    expect(m.size).toBe(0);
  });

  it("maps rfq_id → metadata rows", async () => {
    const row = uploadRow({ id: "u-9", rfq_id: "rfq-9" });
    state.selectData = [row];
    const m = await attachmentsForRfqs(TENANT, ["rfq-9"]);
    expect(m.get("rfq-9")).toBeDefined();
    expect(m.get("rfq-9")![0].id).toBe("u-9");
    expect(m.get("rfq-9")![0].size_bytes).toBe(1024);
    expect(m.get("rfq-9")![0].filename).toBe("spec.pdf");
  });

  it("skips rows without rfq_id", async () => {
    state.selectData = [uploadRow({ id: "orphan" })];
    const m = await attachmentsForRfqs(TENANT, ["rfq-9"]);
    expect(m.size).toBe(0);
  });

  it("degrades to an empty Map on storage error", async () => {
    state.selectError = { message: "relation does not exist" };
    state.selectData = null;
    const m = await attachmentsForRfqs(TENANT, ["rfq-9"]);
    expect(m.size).toBe(0);
  });
});
