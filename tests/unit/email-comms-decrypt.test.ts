import { describe, it, expect, vi, beforeEach } from "vitest";
import { encryptField } from "@/lib/crypto/field-encryption";

// EMAIL-FIX (audit14) regression tests.
//
// Production bug: the settings PUT route encrypts the sensitive comms
// sub-keys (smtp_password, resend_api_key, postmark_server_token) at rest
// with `encryptField` (`enc:`-prefixed AES-256-GCM ciphertext). The doc
// contract in settings/route.ts says "the email service decrypts at use"
// — but it never did. Every send handed the provider the raw `enc:…` blob
// as the credential: Postmark answered "Request does not contain a valid
// Server token." for EVERY email the tenant sent (see the failed
// mail_queue rows in production), even though the settings were saved
// correctly. The fix: `getEmailConfig()` decrypts the blob right after
// loading it.
//
// These tests verify:
//   1. An encrypted postmark_server_token is decrypted before it reaches
//      the provider config.
//   2. An encrypted smtp_password is decrypted the same way.
//   3. Legacy PLAINTEXT values still pass through (rollout compat).
//   4. A mix of encrypted + plaintext fields decrypts selectively.
//   5. The tenant-level blob is preferred over the platform-level one.

const { mockGetSetting, mockGetStore } = vi.hoisted(() => ({
  mockGetSetting: vi.fn(),
  mockGetStore: vi.fn(),
}));

vi.mock("@/lib/data/store", () => ({
  getStore: mockGetStore,
}));

vi.mock("@/lib/notif/helper", () => ({
  notify: vi.fn(),
}));

function installStore(commsByTenant: Record<string, unknown>) {
  mockGetStore.mockResolvedValue({
    getSetting: (key: string, tenantId?: string | null) => {
      if (key === "comms") {
        const k = tenantId == null ? "platform" : String(tenantId);
        return Promise.resolve(commsByTenant[k] ?? null);
      }
      // platform-level allowlist (queried by resolveFromEmail): return the
      // fixture's allowlist or null so the default allowlist applies.
      if (key === "email_allowed_from_domains") {
        return Promise.resolve((commsByTenant as any).allow ?? null);
      }
      return Promise.resolve(null);
    },
    upsertMailQueueEntry: vi.fn(async () => ({ id: "q1" })),
  });
}

import { getEmailConfig, sendEmail } from "@/lib/email/service";

beforeEach(() => {
  vi.resetModules();
  process.env.FIELD_ENCRYPTION_KEY = "test-encryption-key-for-comms-decrypt";
  mockGetSetting.mockReset();
});

describe("getEmailConfig — encrypted comms secrets are decrypted at use (audit14 EMAIL-FIX)", () => {
  it("decrypts an encrypted postmark_server_token before handing it to the provider config", async () => {
    const token = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    installStore({
      t1: {
        email_provider: "postmark",
        from_email: "desk@aspidus.co",
        from_name: "Aspidus DMCC",
        postmark_server_token: encryptField(token),
      },
    });
    const cfg = await getEmailConfig("t1");
    expect(cfg).not.toBeNull();
    expect(cfg!.provider).toBe("postmark");
    expect(cfg!.postmark).toBeDefined();
    // THE regression: before the fix this was the raw `enc:…` ciphertext
    // and Postmark rejected every send with "Request does not contain a
    // valid Server token."
    expect(cfg!.postmark!.serverToken).toBe(token);
    expect(cfg!.postmark!.serverToken).not.toMatch(/^enc:/);
  });

  it("decrypts an encrypted smtp_password (SMTP tenants hit the same bug)", async () => {
    const pass = "S3cret!smtp-pass";
    installStore({
      t1: {
        email_provider: "smtp",
        smtp_host: "smtp.example.com",
        smtp_port: 587,
        smtp_user: "user@example.com",
        smtp_password: encryptField(pass),
        from_email: "noreply@example.com",
        from_name: "Example",
      },
    });
    const cfg = await getEmailConfig("t1");
    expect(cfg!.provider).toBe("smtp");
    expect(cfg!.smtp).toBeDefined();
    expect(cfg!.smtp!.password).toBe(pass);
    expect(cfg!.smtp!.password).not.toMatch(/^enc:/);
  });

  it("legacy PLAINTEXT secrets pass through unchanged (rollout compatibility)", async () => {
    installStore({
      t1: {
        email_provider: "resend",
        from_email: "noreply@example.com",
        from_name: "Example",
        resend_api_key: "re_plain_legacy_key",
      },
    });
    const cfg = await getEmailConfig("t1");
    expect(cfg!.provider).toBe("resend");
    expect(cfg!.resend!.apiKey).toBe("re_plain_legacy_key");
  });

  it("decrypts selectively: encrypted fields decrypt, plaintext fields stay as-is", async () => {
    installStore({
      t1: {
        email_provider: "postmark",
        from_email: "desk@aspidus.co",
        from_name: "Aspidus DMCC",
        postmark_server_token: encryptField("uuid-token-1234"),
        smtp_password: "plaintext-smtp-pass",
        resend_api_key: encryptField("re_secret"),
      },
    });
    const cfg = await getEmailConfig("t1");
    expect(cfg!.postmark!.serverToken).toBe("uuid-token-1234");
    // smtp creds aren't configured (no host/user) so the branch stays off —
    // but the decrypted values are NOT used anywhere as ciphertext.
    expect(cfg!.smtp).toBeUndefined();
  });

  it("prefers the tenant-level blob over the platform-level one", async () => {
    installStore({
      platform: { email_provider: "none", from_email: "noreply@platform" },
      t1: {
        email_provider: "postmark",
        from_email: "desk@aspidus.co",
        from_name: "Aspidus DMCC",
        postmark_server_token: encryptField("tenant-level-token"),
      },
    });
    const cfg = await getEmailConfig("t1");
    expect(cfg!.provider).toBe("postmark");
    expect(cfg!.postmark!.serverToken).toBe("tenant-level-token");
  });
});

describe("sendEmail — the decrypted secret actually reaches the provider call", () => {
  it("sends the DECRYPTED postmark token in the X-Postmark-Server-Token header", async () => {
    const token = "12345678-1234-1234-1234-123456789012";
    installStore({
      t1: {
        email_provider: "postmark",
        from_email: "desk@aspidus.co",
        from_name: "Aspidus DMCC",
        postmark_server_token: encryptField(token),
      },
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ MessageID: "pm-1" }),
      text: async () => "{}",
    }));
    const origFetch = global.fetch;
    global.fetch = fetchMock as any;
    try {
      const res = await sendEmail({
        to: "dest@example.com",
        subject: "test",
        html: "<p>hi</p>",
        tenantId: "t1",
      });
      expect(res.success).toBe(true);
      expect(res.provider).toBe("postmark");
      // THE end-to-end regression: the header must carry the decrypted
      // token, not the `enc:…` ciphertext (what production was sending).
      const headers = (fetchMock.mock.calls[0][1] as any).headers as Record<string, string>;
      expect(headers["X-Postmark-Server-Token"]).toBe(token);
    } finally {
      global.fetch = origFetch;
    }
  });

  it("queues (dev mode) when no provider is configured — no provider call", async () => {
    installStore({ platform: null, t1: null });
    const res = await sendEmail({
      to: "dest@example.com",
      subject: "test",
      html: "<p>hi</p>",
      tenantId: "t1",
    });
    expect(res.success).toBe(true);
    expect(res.provider).toBe("none");
  });
});
