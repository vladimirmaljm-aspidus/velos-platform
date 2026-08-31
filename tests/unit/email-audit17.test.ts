import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encryptField } from "@/lib/crypto/field-encryption";

// AUDIT17 — email from-trust + provider payload tests.
//
// Root cause fixed (the owner's standing complaint "emails constantly fail
// despite correct per-tenant SMTP settings"): the platform from-domain
// allowlist (default aspidus.onrender.com/resend.dev) REWROTE every
// tenant-configured from address to noreply@aspidus.onrender.com while SMTP
// still authenticated as the tenant's own user — strict relays (Office365
// 550 5.7.60, Zoho, Postfix reject_sender_login_mismatch) then refused
// every send, and Resend/Postmark rejected the unverified platform domain
// (403). Ownership is enforced by the provider itself, so:
//   • TENANT comms blob      → from addresses are trusted (format-checked)
//   • PLATFORM comms blob    → allowlist still enforced
//
// Also covered:
//   • Resend To: comma-strings are split into an array (alert routing fan-out
//     used to 422 on Resend's per-element address validation).
//   • AbortSignal 15s timeout is attached to provider fetches.

const { mockGetStore } = vi.hoisted(() => ({
  mockGetStore: vi.fn(),
}));

vi.mock("@/lib/data/store", () => ({
  getStore: mockGetStore,
}));

beforeEach(() => {
  vi.resetModules();
  process.env.FIELD_ENCRYPTION_KEY = "audit17-email-test-encryption-key";
  delete process.env.NOREPLY_EMAIL;
  delete process.env.ALLOWED_FROM_DOMAINS;
  mockGetStore.mockReset();
});

function storeFixture(tenantComms: Record<string, unknown> | null, platformComms: Record<string, unknown> | null = null) {
  return {
    getSetting: vi.fn(async (key: string, tenantId?: string | null) => {
      if (key !== "comms") return null;
      if (tenantId) return tenantComms;
      return platformComms;
    }),
    upsertMailQueueEntry: vi.fn(async (m: any) => ({ id: m.id ?? "mq-new-1", ...m })),
    createNotification: vi.fn(async () => {}),
  } as any;
}

async function loadService() {
  const mod = await import("@/lib/email/service");
  return mod;
}

describe("AUDIT17 P0 — from-email trust model (getEmailConfig)", () => {
  it("TENANT config keeps its own from_email even when the domain is NOT on the platform allowlist", async () => {
    const { getEmailConfig } = await loadService();
    const store = storeFixture({
      email_provider: "smtp",
      smtp_host: "smtp.office365.com",
      smtp_port: 587,
      smtp_user: "erp@velos-trade.rs",
      smtp_password: encryptField("pass"),
      from_email: "erp@velos-trade.rs",
      from_name: "VELOS RS",
    });
    mockGetStore.mockResolvedValue(store);

    const cfg = await getEmailConfig("tenant-1");
    expect(cfg).not.toBeNull();
    expect(cfg!.fromEmail).toBe("erp@velos-trade.rs"); // NOT rewritten
    expect(cfg!.smtp!.user).toBe("erp@velos-trade.rs");
  });

  it("decrypts the smtp password (audit15 regression guard) and trusts provider-specific froms", async () => {
    const { getEmailConfig } = await loadService();
    const store = storeFixture({
      email_provider: "resend",
      resend_api_key: encryptField("re_key"),
      from_email: "no-reply@velos-trade.rs",
      resend_from_email: "billing@velos-trade.rs",
    });
    mockGetStore.mockResolvedValue(store);

    const cfg = await getEmailConfig("tenant-1");
    expect(cfg!.resend!.apiKey).toBe("re_key");
    expect(cfg!.resend!.fromEmail).toBe("billing@velos-trade.rs");
    // base from also trusted (not the allowlist default)
    expect(cfg!.fromEmail).toBe("no-reply@velos-trade.rs");
  });

  it("PLATFORM fallback config still enforces the allowlist (operator's verified domains)", async () => {
    const { getEmailConfig } = await loadService();
    const store = storeFixture(null, {
      email_provider: "resend",
      resend_api_key: encryptField("re_key"),
      from_email: "ceo@victim.com",
    });
    mockGetStore.mockResolvedValue(store);

    const cfg = await getEmailConfig("tenant-1"); // no tenant comms → platform
    expect(cfg).not.toBeNull();
    expect(cfg!.fromEmail).toBe("noreply@aspidus.onrender.com"); // rewritten
  });

  it("malformed tenant from_email falls back to the safe default", async () => {
    const { getEmailConfig } = await loadService();
    const store = storeFixture({
      email_provider: "smtp",
      smtp_host: "x",
      smtp_user: "a@b.rs",
      from_email: "not-an-email",
    });
    mockGetStore.mockResolvedValue(store);

    const cfg = await getEmailConfig("tenant-1");
    expect(cfg!.fromEmail).toBe("noreply@aspidus.onrender.com");
  });
});

describe("AUDIT17 P2-4 — Resend To: comma-split", () => {
  it("splits a comma-separated recipient string into an array payload", async () => {
    const { sendEmail } = await loadService();
    const store = storeFixture({
      email_provider: "resend",
      resend_api_key: encryptField("re_key"),
      from_email: "no-reply@velos-trade.rs",
    });
    mockGetStore.mockResolvedValue(store);

    const calls: any[] = [];
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: "res-1" }), { status: 200 });
    });
    try {
      const result = await sendEmail({
        to: "a@example.com, b@example.com ,c@example.com",
        subject: "S",
        html: "<p>x</p>",
        tenantId: "t1",
      });
      expect(result.success).toBe(true);
      expect(result.queued).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0].body.to).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("provider fetch carries a 15s AbortSignal timeout (hung-API guard)", async () => {
    const { sendEmail } = await loadService();
    const store = storeFixture({
      email_provider: "resend",
      resend_api_key: encryptField("re_key"),
      from_email: "no-reply@velos-trade.rs",
    });
    mockGetStore.mockResolvedValue(store);

    let sawSignal = false;
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (_url: any, init: any) => {
      sawSignal = !!init.signal;
      return new Response(JSON.stringify({ id: "res-1" }), { status: 200 });
    });
    try {
      await sendEmail({ to: "a@example.com", subject: "S", html: "<p>x</p>", tenantId: "t1" });
      expect(sawSignal).toBe(true);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
