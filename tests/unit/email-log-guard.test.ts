import { describe, it, expect, vi, beforeEach } from "vitest";
import { encryptField } from "@/lib/crypto/field-encryption";

// TASK 41 — email duplicate-send guard + email_log audit tests.
//
// The production complaint this guards against: "I send an email, it
// errors, and minutes later the SAME email is delivered to the recipient
// multiple times." Root causes (both fixed):
//   1. the mail_queue + retry surface re-sent parked/failed emails;
//   2. a provider TIMEOUT was reported as a plain failure — the message
//      had actually been accepted — so the admin re-sent it and the
//      recipient got copies.
//
// The new contract (src/lib/email/service.ts):
//   • no queue, no auto-retry, ever
//   • ONE attempt per sendEmail call
//   • dedup guard: a recent sent/unknown row (same tenant+to+subject)
//     refuses the send — nothing attempted, nothing logged
//   • timeout-class errors → failureKind "unknown" (may have delivered)
//   • every REAL attempt appends one email_log row with the exact body
//
// These run against the REAL sendEmail (not a stub) with a chainable
// Supabase mock whose email_log insert calls are captured for assertions.

const { mockGetStore, mockGetSupabase } = vi.hoisted(() => ({
  mockGetStore: vi.fn(),
  mockGetSupabase: vi.fn(),
}));

vi.mock("@/lib/data/store", () => ({
  getStore: mockGetStore,
}));

vi.mock("@/lib/supabase/client", () => ({
  getSupabase: mockGetSupabase,
  isSupabaseConfigured: vi.fn(() => true),
}));

import { sendEmail } from "@/lib/email/service";

// ---------------------------------------------------------------------------
// Supabase mock — chainable builder over the email_log table.
// ---------------------------------------------------------------------------

interface SbMockState {
  inserts: Record<string, unknown>[];
  dedupRow: Record<string, unknown> | null;
}

function makeSb(state: SbMockState) {
  const chain: any = {
    eq: vi.fn(() => chain),
    select: vi.fn(() => chain),
    in: vi.fn(() => chain),
    gte: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => ({ data: state.dedupRow, error: null })),
    insert: vi.fn((row: Record<string, unknown>) => {
      state.inserts.push(row);
      return Promise.resolve({ error: null });
    }),
  };
  return { from: vi.fn(() => chain) };
}

function commsStore(settings: Record<string, unknown> | null) {
  return {
    getSetting: vi.fn(async (key: string) => (key === "comms" ? settings : null)),
    createNotification: vi.fn(async () => {}),
    appendAudit: vi.fn(async () => {}),
    upsertMailQueueEntry: vi.fn(async (m: any) => ({ id: m.id ?? "mq-new", ...m })),
  } as any;
}

function postmarkStore() {
  return commsStore({
    email_provider: "postmark",
    postmark_server_token: encryptField("token-xyz"),
    from_email: "noreply@example.com",
    from_name: "Acme Trading",
  });
}

let sbState: SbMockState;

beforeEach(() => {
  vi.resetModules();
  process.env.FIELD_ENCRYPTION_KEY = "task41-email-guard-test-key";
  process.env.APP_BASE_URL = "https://velos-platform.vercel.app";
  sbState = { inserts: [], dedupRow: null };
  mockGetStore.mockReset();
  mockGetSupabase.mockReset();
  mockGetSupabase.mockImplementation(() => makeSb(sbState));
  mockGetStore.mockResolvedValue(postmarkStore());
});

// ---------------------------------------------------------------------------
// 1. Duplicate guard — the heart of the fix.
// ---------------------------------------------------------------------------
describe("sendEmail — duplicate guard (TASK 41)", () => {
  it("REFUSES the send when a recent 'sent' row exists (same to+subject): nothing attempted, nothing logged", async () => {
    sbState.dedupRow = {
      id: "el-1",
      status: "sent",
      to_email: "client@example.com",
      subject: "Invoice INV-1",
    };
    const fetchMock = vi.fn();
    const origFetch = global.fetch;
    global.fetch = fetchMock as any;

    try {
      const result = await sendEmail({
        to: "client@example.com",
        subject: "Invoice INV-1",
        html: "<p>Attached…</p>",
        tenantId: "t1",
      });

      expect(result.success).toBe(false);
      expect(result.duplicate).toBe(true);
      expect(result.error).toContain("identical email");
      // NOTHING was sent and NOTHING was logged — the guard is a refusal,
      // not an attempt.
      expect(fetchMock).not.toHaveBeenCalled();
      expect(sbState.inserts).toHaveLength(0);
    } finally {
      global.fetch = origFetch;
    }
  });

  it("also refuses on a recent 'unknown' row — an unconfirmed send may have delivered (the exact duplicate scenario the owner hit)", async () => {
    sbState.dedupRow = { id: "el-2", status: "unknown", to_email: "client@example.com", subject: "Invoice INV-1" };
    const fetchMock = vi.fn();
    const origFetch = global.fetch;
    global.fetch = fetchMock as any;

    try {
      const result = await sendEmail({
        to: "client@example.com",
        subject: "Invoice INV-1",
        html: "<p>x</p>",
        tenantId: "t1",
      });
      expect(result.duplicate).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      global.fetch = origFetch;
    }
  });

  it("a 'failed' row does NOT block re-sending — a definitively rejected email is safe to retry manually", async () => {
    sbState.dedupRow = null; // dedup query only matches sent/unknown
    const origFetch = global.fetch;
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ MessageID: "pm-2" }),
      text: async () => "{}",
    })) as any;

    try {
      const result = await sendEmail({
        to: "client@example.com",
        subject: "Invoice INV-1",
        html: "<p>x</p>",
        tenantId: "t1",
      });
      expect(result.success).toBe(true);
      expect(sbState.inserts).toHaveLength(1);
    } finally {
      global.fetch = origFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// 2. One attempt, honest statuses, exact-text audit.
// ---------------------------------------------------------------------------
describe("sendEmail — single attempt + email_log audit (TASK 41)", () => {
  it("success: logs ONE row with status sent, the exact body and the provider message id", async () => {
    const origFetch = global.fetch;
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ MessageID: "pm-1" }),
      text: async () => "{}",
    })) as any;

    try {
      const result = await sendEmail({
        to: "client@example.com",
        subject: "Invoice INV-1",
        html: "<p>Exact body</p>",
        text: "Exact body",
        tenantId: "t1",
        entityType: "invoice",
        entityId: "inv-1",
        userId: "u-9",
        ip: "203.0.113.7",
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe("pm-1");
      expect(result.logId).toBeTruthy();

      expect(sbState.inserts).toHaveLength(1);
      const row = sbState.inserts[0] as Record<string, any>;
      expect(row.status).toBe("sent");
      expect(row.provider).toBe("postmark");
      expect(row.message_id).toBe("pm-1");
      expect(row.to_email).toBe("client@example.com");
      expect(row.body_html).toBe("<p>Exact body</p>"); // EXACT text sent
      expect(row.body_text).toBe("Exact body");
      expect(row.entity_type).toBe("invoice");
      expect(row.entity_id).toBe("inv-1");
      expect(row.created_by).toBe("u-9");
      expect(row.ip).toBe("203.0.113.7");
      expect(row.tenant_id).toBe("t1");
      expect(row.sent_at).toBeTruthy();
      // NO queue row is ever written — the mail_queue is gone.
      const store = await mockGetStore.mock.results[0].value;
      expect((store as any).upsertMailQueueEntry).not.toHaveBeenCalled();
    } finally {
      global.fetch = origFetch;
    }
  });

  it("hard provider failure: failureKind failed, one log row with the error, NO queue insert", async () => {
    const origFetch = global.fetch;
    global.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as any;

    try {
      const result = await sendEmail({
        to: "client@example.com",
        subject: "S",
        html: "<p>x</p>",
        tenantId: "t1",
      });

      expect(result.success).toBe(false);
      expect(result.failureKind).toBe("failed");
      expect(result.error).toContain("network down");

      expect(sbState.inserts).toHaveLength(1);
      expect((sbState.inserts[0] as Record<string, any>).status).toBe("failed");
      expect((sbState.inserts[0] as Record<string, any>).error).toContain("network down");
    } finally {
      global.fetch = origFetch;
    }
  });

  it("TIMEOUT: failureKind unknown — the email may have been delivered, the error says so, the log row is 'unknown'", async () => {
    const origFetch = global.fetch;
    // AbortSignal.timeout rejects with a DOMException named TimeoutError.
    global.fetch = vi.fn(async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    }) as any;

    try {
      const result = await sendEmail({
        to: "client@example.com",
        subject: "S",
        html: "<p>x</p>",
        tenantId: "t1",
      });

      expect(result.success).toBe(false);
      expect(result.failureKind).toBe("unknown");
      expect(result.error).toContain("unconfirmed");
      expect((sbState.inserts[0] as Record<string, any>).status).toBe("unknown");
    } finally {
      global.fetch = origFetch;
    }
  });

  it("no provider configured: failureKind no_provider, honest error, one failed log row", async () => {
    mockGetStore.mockResolvedValue(commsStore(null));
    const fetchMock = vi.fn();
    const origFetch = global.fetch;
    global.fetch = fetchMock as any;

    try {
      const result = await sendEmail({
        to: "ops@platform.example",
        subject: "S",
        html: "<p>x</p>",
      });

      expect(result.success).toBe(false);
      expect(result.failureKind).toBe("no_provider");
      expect(result.provider).toBe("none");
      expect(result.error).toContain("No email provider is configured");
      // No provider call, one audit row documenting the misconfiguration.
      expect(fetchMock).not.toHaveBeenCalled();
      expect(sbState.inserts).toHaveLength(1);
      expect((sbState.inserts[0] as Record<string, any>).status).toBe("failed");
      expect((sbState.inserts[0] as Record<string, any>).provider).toBe("none");
    } finally {
      global.fetch = origFetch;
    }
  });

  it("failure notification goes to the Email Log, with NO mail-queue / retry language", async () => {
    const store = postmarkStore();
    mockGetStore.mockResolvedValue(store);
    const origFetch = global.fetch;
    global.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as any;

    try {
      await sendEmail({ to: "client@example.com", subject: "S", html: "<p>x</p>", tenantId: "t1" });
      expect(store.createNotification).toHaveBeenCalledTimes(1);
      const notif = store.createNotification.mock.calls[0][0] as Record<string, any>;
      expect(notif.type).toBe("email_failed");
      expect(notif.action_url).toBe("/app?view=email-log");
      expect(String(notif.message)).not.toMatch(/mail ?queue/i);
      expect(String(notif.message)).not.toMatch(/retry/i);
    } finally {
      global.fetch = origFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Optional-table degradation — a missing email_log must never break
//    email sending (pre-migration safety, mirrors portal-events).
// ---------------------------------------------------------------------------
describe("sendEmail — email_log optional-table contract (TASK 41)", () => {
  it("still sends when the audit insert errors (table missing) — the row is skipped silently", async () => {
    const chain: any = {
      eq: vi.fn(() => chain),
      select: vi.fn(() => chain),
      in: vi.fn(() => chain),
      gte: vi.fn(() => chain),
      order: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      maybeSingle: vi.fn(async () => ({ data: null, error: { message: "relation \"email_log\" does not exist" } })),
      insert: vi.fn(async () => ({ error: { message: "relation \"email_log\" does not exist" } })),
    };
    mockGetSupabase.mockImplementation(() => ({ from: vi.fn(() => chain) }));

    const origFetch = global.fetch;
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ MessageID: "pm-3" }),
      text: async () => "{}",
    })) as any;

    try {
      const result = await sendEmail({
        to: "client@example.com",
        subject: "S",
        html: "<p>x</p>",
        tenantId: "t1",
      });
      expect(result.success).toBe(true);
      expect(result.logId).toBeNull();
    } finally {
      global.fetch = origFetch;
    }
  });
});
