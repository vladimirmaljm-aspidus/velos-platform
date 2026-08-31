import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { encryptField, hmacField } from "@/lib/crypto/field-encryption";

// AUDIT16 — mail-queue mechanics tests (real sendEmail, retry route,
// MockStore.approveKycAndTransfer encryption).
//
// These run against the REAL src/lib/email/service.ts sendEmail (NOT a
// stub) so the queue-fallback semantics are exercised end-to-end:
//   • no provider configured → queued:true + single mail_queue row
//   • provider failure with queueEntryId → UPDATES the row (no duplicate)
//   • provider failure without queueEntryId → INSERTS a failed row
//   • entity_type/entity_id persisted for attachment regeneration
// Plus the retry route:
//   • refuses an undecryptable enc: to_email (422)
//   • re-sends to the DECRYPTED address + passes queueEntryId
//   • refuses when already sent (409)
//   • does not mark sent when the retry re-queues (no provider)

const { mockGetStore, mockRequireAuth, mockAudit, mockGetSupabase } = vi.hoisted(() => ({
  mockGetStore: vi.fn(),
  mockRequireAuth: vi.fn(),
  mockAudit: vi.fn(async () => {}),
  mockGetSupabase: vi.fn(),
}));

vi.mock("@/lib/data/store", () => ({
  getStore: mockGetStore,
}));

vi.mock("@/lib/supabase/client", () => ({
  getSupabase: mockGetSupabase,
  isSupabaseConfigured: vi.fn(() => true),
}));

vi.mock("@/lib/api/helpers", () => ({
  requireAuth: mockRequireAuth,
  audit: mockAudit,
  getIp: vi.fn(() => "203.0.113.7"),
  sanitizeError: vi.fn((e: any) => e?.message || "error"),
  resolveTenantId: vi.fn((auth: any) => auth.tenantId ?? null),
}));

vi.mock("@/lib/permissions/can", () => ({
  requirePermission: vi.fn(() => null),
}));

vi.mock("@/lib/api/feature-guard", () => ({
  requireFeature: vi.fn(async () => null),
}));

beforeEach(() => {
  vi.resetModules();
  process.env.FIELD_ENCRYPTION_KEY = "audit16-mailqueue-test-encryption-key";
  process.env.APP_BASE_URL = "https://velos-platform.vercel.app";
  mockGetStore.mockReset();
  mockRequireAuth.mockReset();
  mockGetSupabase.mockReset();
});

// ---------------------------------------------------------------------------
// 1. Real sendEmail — queue semantics.
// ---------------------------------------------------------------------------
import { sendEmail } from "@/lib/email/service";

function queueStoreFixture(settings: Record<string, unknown> | null) {
  const upsertMailQueueEntry = vi.fn(async (m: any) => ({ id: m.id ?? "mq-new-1", ...m }));
  const store = {
    getSetting: vi.fn(async (key: string) => (key === "comms" ? settings : null)),
    upsertMailQueueEntry,
    createNotification: vi.fn(async () => {}),
    appendAudit: vi.fn(async () => {}),
  } as any;
  return { store, upsertMailQueueEntry };
}

describe("sendEmail — no provider configured (audit16 QUEUED)", () => {
  it("returns success:true + queued:true and parks the mail in the queue", async () => {
    const { store, upsertMailQueueEntry } = queueStoreFixture(null);
    mockGetStore.mockResolvedValue(store);

    const result = await sendEmail({
      to: "client@example.com",
      subject: "Invoice INV-1",
      html: "<p>Attached…</p>",
      tenantId: "t1",
      entityType: "invoice",
      entityId: "inv-1",
    });

    expect(result.success).toBe(true);
    // THE regression: callers could not distinguish "delivered" from
    // "parked in the queue" — documents got marked "sent".
    expect(result.queued).toBe(true);
    expect(result.provider).toBe("none");

    expect(upsertMailQueueEntry).toHaveBeenCalledTimes(1);
    const row = upsertMailQueueEntry.mock.calls[0][0];
    expect(row.to_email).toBe("client@example.com");
    expect(row.status).toBe("queued");
    expect(row.tenant_id).toBe("t1");
    // Entity reference persisted for the retry-time PDF regeneration.
    expect(row.entity_type).toBe("invoice");
    expect(row.entity_id).toBe("inv-1");
    // No id → INSERT path (a fresh queued row).
    expect(row.id).toBeUndefined();
  });

  it("falls back to the SYSTEM tenant sentinel for platform-level sends", async () => {
    const { store, upsertMailQueueEntry } = queueStoreFixture(null);
    mockGetStore.mockResolvedValue(store);
    await sendEmail({ to: "ops@platform.example", subject: "S", html: "<p>x</p>" });
    expect(upsertMailQueueEntry.mock.calls[0][0].tenant_id).toBe("SYSTEM");
  });
});

describe("sendEmail — provider failure path (audit16 MAIL-RETRY)", () => {
  it("UPDATEs the existing row when queueEntryId is passed (no duplicate rows)", async () => {
    // Postmark configured but the network call fails hard (fetch throws).
    const { store, upsertMailQueueEntry } = queueStoreFixture({
      email_provider: "postmark",
      postmark_server_token: encryptField("token-xyz"),
      from_email: "noreply@example.com",
    });
    mockGetStore.mockResolvedValue(store);
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => {
      throw new Error("network down");
    });

    try {
      const result = await sendEmail({
        to: "client@example.com",
        subject: "S",
        html: "<p>x</p>",
        tenantId: "t1",
        queueEntryId: "mq-existing-7",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("network down");
      expect(result.queued).toBeUndefined();

      // The failed send must UPDATE the existing queue row — previously
      // this always INSERTED a brand-new failed row (duplicate).
      const row = upsertMailQueueEntry.mock.calls[0][0];
      expect(row.id).toBe("mq-existing-7");
      expect(row.status).toBe("failed");
      // AUDIT17 / P2-2 — a RETRY failure (queueEntryId set) no longer stamps
      // attempts (the retry route owns the increment; a hard 1 here reset the
      // counter on every failed retry). The key must be absent.
      expect("attempts" in row).toBe(false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("INSERTs a fresh failed row when no queueEntryId is given", async () => {
    const { store, upsertMailQueueEntry } = queueStoreFixture({
      email_provider: "postmark",
      postmark_server_token: encryptField("token-xyz"),
      from_email: "noreply@example.com",
    });
    mockGetStore.mockResolvedValue(store);
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => {
      throw new Error("boom");
    });
    try {
      const result = await sendEmail({ to: "client@example.com", subject: "S", html: "<p>x</p>", tenantId: "t1" });
      expect(result.success).toBe(false);
      const row = upsertMailQueueEntry.mock.calls[0][0];
      expect(row.id).toBeUndefined();
      expect(row.status).toBe("failed");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("persists entity_type/entity_id on the failed row too", async () => {
    const { store, upsertMailQueueEntry } = queueStoreFixture({
      email_provider: "postmark",
      postmark_server_token: encryptField("token-xyz"),
      from_email: "noreply@example.com",
    });
    mockGetStore.mockResolvedValue(store);
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => {
      throw new Error("boom");
    });
    try {
      await sendEmail({
        to: "client@example.com", subject: "S", html: "<p>x</p>", tenantId: "t1",
        queueEntryId: "mq-9", entityType: "offer", entityId: "of-1",
      });
      const row = upsertMailQueueEntry.mock.calls[0][0];
      expect(row.entity_type).toBe("offer");
      expect(row.entity_id).toBe("of-1");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Mail-queue retry route.
// ---------------------------------------------------------------------------
import { POST as retryPost } from "@/app/api/mail-queue/[id]/retry/route";

/** Build a chainable fake Supabase query builder (resolves { data, error }). */
function sbChain(row: unknown) {
  const chain: any = {
    eq: vi.fn(() => chain),
    select: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => ({ data: row, error: null })),
    update: vi.fn(() => chain),
    range: vi.fn(() => chain),
    order: vi.fn(() => chain),
    in: vi.fn(() => chain),
    single: vi.fn(async () => ({ data: row, error: null })),
  };
  return chain;
}

function retryReq() {
  return new NextRequest("http://localhost/api/mail-queue/mq-1/retry", { method: "POST" });
}

function makeAuth() {
  return {
    tenantId: "t1",
    isSuperAdmin: false,
    ip: "203.0.113.7",
    user: { id: "u1", username: "admin", role: "admin", email: "admin@example.com" },
    store: {
      upsertMailQueueEntry: vi.fn(async (m: any) => ({ id: m.id ?? "mq-new", ...m })),
      appendAudit: vi.fn(async () => {}),
    } as any,
  };
}

function mockSb(entry: any) {
  const selectChain = sbChain(entry);
  const updateChain = sbChain({ ...entry, status: "updated" });
  // The route calls sb.from("mail_queue").update(patch)… — capture the
  // patch on a dedicated factory fn (the chain's own .update mock is a
  // different object).
  const updateFactory = vi.fn((patch: any) => updateChain);
  const sb = {
    from: vi.fn((table: string) => (table === "mail_queue" ? {
      select: () => selectChain,
      update: updateFactory,
    } : sbChain(null))),
  };
  mockGetSupabase.mockReturnValue(sb);
  return { selectChain, updateChain, updateFactory };
}

// The retry route calls the REAL sendEmail — point getStore at a store
// with no comms settings so retries take the no-provider path, OR stub
// the service module. We let sendEmail hit the real queue-store fixture.
function authStoreNoProvider() {
  return {
    getSetting: vi.fn(async () => null),
    upsertMailQueueEntry: vi.fn(async (m: any) => ({ id: m.id ?? "mq-new", ...m })),
    createNotification: vi.fn(async () => {}),
    appendAudit: vi.fn(async () => {}),
  } as any;
}

describe("mail-queue retry route (audit16 MAIL-RETRY)", () => {
  let currentAuth: any;

  beforeEach(() => {
    currentAuth = makeAuth();
    currentAuth.store = authStoreNoProvider();
    mockRequireAuth.mockResolvedValue(currentAuth);
    mockGetStore.mockResolvedValue(currentAuth.store);
  });

  it("refuses an undecryptable enc: to_email with 422 + marks the row failed", async () => {
    const { updateFactory } = mockSb({
      id: "mq-1",
      tenant_id: "t1",
      to_email: "enc:AAAA:BBBB:CCCC:DDDD",
      subject: "S",
      body: "<p>x</p>",
      status: "failed",
      attempts: 3,
    });
    const res = await retryPost(retryReq(), { params: Promise.resolve({ id: "mq-1" }) });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/unreadable/i);
    // Row updated to failed with the actionable error message.
    expect(updateFactory).toHaveBeenCalled();
    expect(updateFactory.mock.calls[0][0].status).toBe("failed");
  });

  it("re-sends to the DECRYPTED address and passes queueEntryId through", async () => {
    mockSb({
      id: "mq-1",
      tenant_id: "t1",
      to_email: encryptField("queued-client@example.com"),
      subject: "Invoice INV-1",
      body: "<p>Attached…</p>",
      status: "queued",
      attempts: 0,
      entity_type: "invoice",
      entity_id: "inv-1",
    });
    // No provider configured → sendEmail parks it again with queued:true.
    const res = await retryPost(retryReq(), { params: Promise.resolve({ id: "mq-1" }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.queued).toBe(true);
    expect(body.error).toMatch(/provider/i);

    // sendEmail (real, via the auth store's queue fixture) UPDATED the
    // same row — id carried through, decrypted address, entity reference.
    const row = currentAuth.store.upsertMailQueueEntry.mock.calls.at(-1)[0];
    expect(row.id).toBe("mq-1");
    expect(row.to_email).toBe("queued-client@example.com");
    expect(row.status).toBe("queued");
    expect(row.entity_type).toBe("invoice");
  });

  it("refuses to retry an already-sent entry (409)", async () => {
    mockSb({
      id: "mq-1",
      tenant_id: "t1",
      to_email: "sent@example.com",
      subject: "S",
      body: "<p>x</p>",
      status: "sent",
      attempts: 1,
    });
    const res = await retryPost(retryReq(), { params: Promise.resolve({ id: "mq-1" }) });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already sent/i);
  });

  it("returns 404 for another tenant's entry", async () => {
    mockSb(null); // maybeSingle resolves null
    const res = await retryPost(retryReq(), { params: Promise.resolve({ id: "mq-1" }) });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 3. MockStore.approveKycAndTransfer — PII encryption on transfer.
// ---------------------------------------------------------------------------
describe("MockStore.approveKycAndTransfer — PII encryption (audit16 P0-3)", () => {
  it("transfers contact/tax PII ENCRYPTED with HMAC tokens", async () => {
    const { MockStore } = await import("@/lib/data/mock-store");
    const store = new MockStore();
    const sub = await store.upsertKycSubmission({
      id: "kyc-1",
      tenant_id: "t1",
      partner_id: "p1",
      status: "pending",
      legal_name: "Partner Co LLC",
      contact_name: "Contact Person",
      contact_email: "plain@example.com",
      contact_phone: "+971500000000",
      tax_id: "TAX123",
      vat_number: "VAT456",
      registration_number: "REG789",
      country: "AE",
    } as any);
    expect(sub.id).toBe("kyc-1");
    const partner = await store.upsertPartner({
      id: "p1",
      tenant_id: "t1",
      name: "Partner Co",
      status: "active",
    } as any);
    expect(partner.id).toBe("p1");

    const { partner: updated } = await store.approveKycAndTransfer("kyc-1", "rev-1");

    expect(updated!.kyc_status).toBe("approved");
    // PII is stored encrypted (enc: prefix)…
    expect(updated!.contact_email).toMatch(/^enc:/);
    expect(updated!.contact_email).not.toBe("plain@example.com");
    expect(updated!.contact_phone).toMatch(/^enc:/);
    expect(updated!.tax_id).toMatch(/^enc:/);
    expect(updated!.vat_number).toMatch(/^enc:/);
    // …with the deterministic HMAC tokens the duplicate-check relies on.
    expect((updated as any).tax_id_hmac).toBe(hmacField("TAX123"));
    expect((updated as any).vat_number_hmac).toBe(hmacField("VAT456"));
    // Round-trip: decrypt gives the original values back.
    expect((updated as any).contact_email.startsWith("enc:")).toBe(true);
    // Non-PII fields transfer in plaintext as before.
    expect(updated!.registration_number).toBe("REG789");
    expect(updated!.name).toBe("Partner Co LLC");
  });

  it("is idempotent on re-approve (no double-encryption)", async () => {
    const { MockStore } = await import("@/lib/data/mock-store");
    const store = new MockStore();
    await store.upsertKycSubmission({
      id: "kyc-2", tenant_id: "t1", partner_id: "p2", status: "pending",
      contact_email: "again@example.com", tax_id: "T2",
    } as any);
    await store.upsertPartner({ id: "p2", tenant_id: "t1", name: "P2" } as any);
    const first = (await store.approveKycAndTransfer("kyc-2", "rev")).partner!;
    const once = first.contact_email;
    const second = (await store.approveKycAndTransfer("kyc-2", "rev")).partner!;
    expect(second.contact_email).toBe(once);
    expect(second.contact_email).toMatch(/^enc:/);
    expect(second.contact_email!.split(":").length).toBe(once!.split(":").length);
  });
});

// ---------------------------------------------------------------------------
// 4. MockStore — HMAC-equality portal lookups for encrypted rows.
// ---------------------------------------------------------------------------
describe("MockStore — portal_email HMAC lookups (audit16 DEV-FLOW)", () => {
  it("finds a portal row by email when portal_email is stored encrypted", async () => {
    const { MockStore } = await import("@/lib/data/mock-store");
    const store = new MockStore();
    await store.upsertPortalAccess({
      tenant_id: "t1",
      partner_id: "p1",
      portal_email: encryptField("enclookup@example.com"),
      portal_email_hmac: hmacField("enclookup@example.com"),
      status: "active",
    } as any);

    const byEmail = await store.getPortalAccessByEmail("t1", "enclookup@example.com");
    expect(byEmail).not.toBeNull();
    expect(byEmail!.id).toBeTruthy();

    const anyTenant = await store.getPortalAccessByEmailAnyTenant("enclookup@example.com");
    expect(anyTenant).not.toBeNull();

    const listed = await store.listPortalAccessByEmail("enclookup@example.com");
    expect(listed.length).toBe(1);
  });

  it("still finds legacy plaintext rows (backwards compatibility)", async () => {
    const { MockStore } = await import("@/lib/data/mock-store");
    const store = new MockStore();
    await store.upsertPortalAccess({
      tenant_id: "t1",
      partner_id: "p2",
      portal_email: "legacy@example.com",
      status: "active",
    } as any);
    const byEmail = await store.getPortalAccessByEmail("t1", "legacy@example.com");
    expect(byEmail).not.toBeNull();
  });
});
