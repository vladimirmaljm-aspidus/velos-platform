import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import type { Store } from "@/lib/data/store";
import type { Webhook, WebhookDelivery } from "@/lib/supabase/types";

import {
  signPayload,
  verifySignature,
  triggerWebhooks,
  sanitizeWebhookPayload,
  MAX_WEBHOOK_ATTEMPTS,
} from "@/lib/webhooks/deliver";

// 2f-F1 + 2f-F2 fix added a real DNS-lookup SSRF re-validation in
// attemptDelivery() before every fetch. The webhook tests use
// `https://receiver.example.com/hook` (IANA-reserved example domain) which
// fails DNS resolution in the test sandbox → fetch is never called →
// 9 tests fail. Mock assertSafeWebhookUrl to short-circuit the SSRF gate so
// the delivery tests can assert on fetch / store.createWebhookDelivery /
// store.updateWebhookDelivery behaviour (which is what they're actually
// testing — the SSRF gate has its own dedicated test in url-validation).
vi.mock("@/lib/webhooks/url-validation", () => ({
  assertSafeWebhookUrl: vi.fn(async () => ({ ok: true } as never)),
}));

// ── Helpers ───────────────────────────────────────────────────────────────

const SECRET = "whsec_test_secret_12345";

function webhook(over: Partial<Webhook> = {}): Webhook {
  return {
    id: "wh-1",
    tenant_id: "tenant-A",
    name: "Test webhook",
    url: "https://receiver.example.com/hook",
    events: ["offer.created"],
    secret: SECRET,
    last_triggered_at: null,
    last_status: null,
    active: true,
    created_at: new Date().toISOString(),
    ...over,
  };
}

function mockStore(over: Partial<Store> = {}): Store {
  const deliveries: WebhookDelivery[] = [];
  return {
    listWebhooks: vi.fn(async () => []),
    createWebhookDelivery: vi.fn(async (d) => {
      const row: WebhookDelivery = {
        id: `del-${deliveries.length + 1}`,
        webhook_id: d.webhook_id,
        tenant_id: d.tenant_id,
        event: d.event,
        payload: d.payload,
        status: d.status || "pending",
        attempts: d.attempts || 0,
        response_status: null,
        response_body: null,
        delivered_at: null,
        next_attempt_at: null,
        created_at: new Date().toISOString(),
      };
      deliveries.push(row);
      return row;
    }),
    updateWebhookDelivery: vi.fn(async (_id, patch) => {
      const idx = deliveries.findIndex((r) => r.id === _id);
      if (idx >= 0) Object.assign(deliveries[idx], patch);
    }),
    upsertWebhook: vi.fn(async () => ({} as any)),
    getWebhookById: vi.fn(async () => null),
    listFailedWebhookDeliveries: vi.fn(async () => deliveries.filter((d) => d.status === "failed")),
    ...over,
  } as unknown as Store;
}

// ── signPayload / verifySignature ─────────────────────────────────────────

describe("webhook delivery — signPayload", () => {
  it("produces the canonical HMAC-SHA256 hex digest", () => {
    const body = JSON.stringify({ hello: "world", n: 42 });
    const sig = signPayload(body, SECRET);
    // Compute the expected digest independently with node's crypto to assert
    // the implementation isn't drifting (e.g. switched to base64).
    const expected = createHmac("sha256", SECRET).update(body).digest("hex");
    expect(sig).toBe(expected);
    expect(sig).toHaveLength(64); // SHA-256 → 32 bytes → 64 hex chars
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic — same payload + secret always yields the same signature", () => {
    const body = '{"id":"abc"}';
    expect(signPayload(body, SECRET)).toBe(signPayload(body, SECRET));
  });

  it("changes when the payload changes", () => {
    expect(signPayload('{"a":1}', SECRET)).not.toBe(signPayload('{"a":2}', SECRET));
  });

  it("changes when the secret changes", () => {
    const body = '{"a":1}';
    expect(signPayload(body, SECRET)).not.toBe(signPayload(body, "different-secret"));
  });
});

describe("webhook delivery — verifySignature", () => {
  const body = '{"event":"offer.created","id":"abc"}';

  it("validates a correct signature", () => {
    const sig = signPayload(body, SECRET);
    expect(verifySignature(body, sig, SECRET)).toBe(true);
  });

  it("rejects a signature produced with a different secret", () => {
    const sig = signPayload(body, "wrong-secret");
    expect(verifySignature(body, sig, SECRET)).toBe(false);
  });

  it("rejects a tampered payload (signature no longer matches)", () => {
    const sig = signPayload(body, SECRET);
    expect(verifySignature('{"event":"offer.created","id":"CHANGED"}', sig, SECRET)).toBe(false);
  });

  it("rejects a malformed signature of different length (timing-safe guard)", () => {
    // timingSafeEqual requires equal-length buffers; the verifier short-
    // circuits to false when lengths differ rather than throwing.
    expect(verifySignature(body, "deadbeef", SECRET)).toBe(false);
    expect(verifySignature(body, "", SECRET)).toBe(false);
    expect(verifySignature(body, signPayload(body, SECRET) + "extra", SECRET)).toBe(false);
  });

  it("does not throw on a non-hex signature (caught + returns false)", () => {
    expect(verifySignature(body, "not hex at all!", SECRET)).toBe(false);
  });
});

// ── triggerWebhooks — event/active filtering ──────────────────────────────

describe("webhook delivery — triggerWebhooks event filtering", () => {
  let store: Store;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () =>
      new Response("ok", { status: 200 }),
    ) as any;
    vi.stubGlobal("fetch", fetchMock);
    store = mockStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does NOT send to webhooks whose `events` array does not include the event", async () => {
    const wh1 = webhook({ id: "wh-1", events: ["offer.created"] });
    const wh2 = webhook({ id: "wh-2", events: ["offer.updated"] });
    const wh3 = webhook({ id: "wh-3", events: ["invoice.paid"] });
    (store.listWebhooks as any).mockResolvedValue([wh1, wh2, wh3]);

    await triggerWebhooks(store, "tenant-A", "offer.created", "offer", "off-1", { id: "off-1" });

    // Only wh-1 should have received a delivery.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0];
    expect(calledUrl).toBe("https://receiver.example.com/hook");
    expect(store.createWebhookDelivery).toHaveBeenCalledTimes(1);
    const created = (store.createWebhookDelivery as any).mock.calls[0][0];
    expect(created.webhook_id).toBe("wh-1");
  });

  it("sends to webhooks with the wildcard '*' event subscription", async () => {
    const wh1 = webhook({ id: "wh-1", events: ["*"] });
    (store.listWebhooks as any).mockResolvedValue([wh1]);

    await triggerWebhooks(store, "tenant-A", "offer.created", "offer", "off-1", { id: "off-1" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.createWebhookDelivery).toHaveBeenCalledTimes(1);
  });

  it("does NOT send to inactive webhooks even when the event matches", async () => {
    const wh1 = webhook({ id: "wh-1", events: ["offer.created"], active: true });
    const wh2 = webhook({ id: "wh-2", events: ["offer.created"], active: false });
    (store.listWebhooks as any).mockResolvedValue([wh1, wh2]);

    await triggerWebhooks(store, "tenant-A", "offer.created", "offer", "off-1", { id: "off-1" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const created = (store.createWebhookDelivery as any).mock.calls[0][0];
    expect(created.webhook_id).toBe("wh-1");
  });

  it("does nothing when no webhooks are registered for the tenant", async () => {
    (store.listWebhooks as any).mockResolvedValue([]);
    await triggerWebhooks(store, "tenant-A", "offer.created", "offer", "off-1", { id: "off-1" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.createWebhookDelivery).not.toHaveBeenCalled();
  });

  it("refuses to broadcast when tenantId is empty (defense-in-depth)", async () => {
    await triggerWebhooks(store, "", "offer.created", "offer", "off-1", { id: "off-1" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.listWebhooks).not.toHaveBeenCalled();
  });

  it("does NOT cross tenants — only fetches webhooks for the given tenantId", async () => {
    (store.listWebhooks as any).mockResolvedValue([]);
    await triggerWebhooks(store, "tenant-A", "offer.created", "offer", "off-1", { id: "off-1" });
    expect(store.listWebhooks).toHaveBeenCalledWith("tenant-A");
  });
});

// ── triggerWebhooks — failed delivery creates retry record ─────────────────

describe("webhook delivery — failed delivery creates retry record", () => {
  let store: Store;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = mockStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("marks the delivery as 'failed' with next_attempt_at set when fetch rejects", async () => {
    fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as any;
    vi.stubGlobal("fetch", fetchMock);

    const wh = webhook({ id: "wh-1", events: ["offer.created"] });
    (store.listWebhooks as any).mockResolvedValue([wh]);

    await triggerWebhooks(store, "tenant-A", "offer.created", "offer", "off-1", { id: "off-1" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.createWebhookDelivery).toHaveBeenCalledTimes(1);
    expect(store.updateWebhookDelivery).toHaveBeenCalledTimes(1);

    const patch = (store.updateWebhookDelivery as any).mock.calls[0][1];
    expect(patch.status).toBe("failed");
    expect(patch.attempts).toBe(1);
    expect(patch.next_attempt_at).not.toBeNull();
    // The retry is scheduled 60s out (BACKOFF_MS[0]) — within a sane backoff
    // envelope (1min..30min).
    const retryMs = new Date(patch.next_attempt_at).getTime() - Date.now();
    expect(retryMs).toBeGreaterThan(30_000);
    expect(retryMs).toBeLessThan(120_000);
    expect(patch.response_body).toContain("ECONNREFUSED");
    expect(patch.delivered_at).toBeNull();
  });

  it("marks the delivery as 'delivered' and clears next_attempt_at when fetch returns 2xx", async () => {
    fetchMock = vi.fn(async () => new Response("ok", { status: 200 })) as any;
    vi.stubGlobal("fetch", fetchMock);

    const wh = webhook({ id: "wh-1", events: ["offer.created"] });
    (store.listWebhooks as any).mockResolvedValue([wh]);

    await triggerWebhooks(store, "tenant-A", "offer.created", "offer", "off-1", { id: "off-1" });

    const patch = (store.updateWebhookDelivery as any).mock.calls[0][1];
    expect(patch.status).toBe("delivered");
    expect(patch.attempts).toBe(1);
    expect(patch.next_attempt_at).toBeNull();
    expect(patch.delivered_at).not.toBeNull();
    expect(patch.response_status).toBe(200);
  });

  it("marks delivery as 'failed' when the receiver returns a non-2xx status (e.g. 500)", async () => {
    fetchMock = vi.fn(async () => new Response("err", { status: 500 })) as any;
    vi.stubGlobal("fetch", fetchMock);

    const wh = webhook({ id: "wh-1", events: ["offer.created"] });
    (store.listWebhooks as any).mockResolvedValue([wh]);

    await triggerWebhooks(store, "tenant-A", "offer.created", "offer", "off-1", { id: "off-1" });

    const patch = (store.updateWebhookDelivery as any).mock.calls[0][1];
    expect(patch.status).toBe("failed");
    expect(patch.response_status).toBe(500);
    expect(patch.next_attempt_at).not.toBeNull();
  });

  it("sends the X-Webhook-Signature header matching the body it actually POSTed", async () => {
    fetchMock = vi.fn(async () => new Response("ok", { status: 200 })) as any;
    vi.stubGlobal("fetch", fetchMock);

    const wh = webhook({ id: "wh-1", events: ["offer.created"] });
    (store.listWebhooks as any).mockResolvedValue([wh]);

    await triggerWebhooks(store, "tenant-A", "offer.created", "offer", "off-1", {
      id: "off-1",
      total: 100,
      // PII field — must be stripped BEFORE signing so receivers can't recover it.
      password: "hunter2",
    });

    const call = fetchMock.mock.calls[0];
    const body: string = call[1].body;
    const headers: Record<string, string> = call[1].headers;
    const sig = headers["X-Webhook-Signature"];

    // 1. The signature matches the body that was actually sent.
    expect(verifySignature(body, sig, SECRET)).toBe(true);
    // 2. The body does NOT contain the stripped PII field.
    expect(body).not.toContain("hunter2");
    expect(body).not.toContain("password");
    // 3. The sanitized payload IS what was signed + sent.
    const parsed = JSON.parse(body);
    expect(parsed.data.id).toBe("off-1");
    expect(parsed.data.total).toBe(100);
    expect("password" in parsed.data).toBe(false);
  });

  it("never throws — a failing webhook must not break the calling route handler", async () => {
    // Force listWebhooks to throw; triggerWebhooks must swallow it.
    (store.listWebhooks as any).mockRejectedValue(new Error("DB down"));
    await expect(
      triggerWebhooks(store, "tenant-A", "offer.created", "offer", "off-1", { id: "off-1" }),
    ).resolves.toBeUndefined();
  });

  it("continues delivering to other webhooks when one fails mid-fanout", async () => {
    const wh1 = webhook({ id: "wh-1", url: "https://a.example.com/hook", events: ["offer.created"] });
    const wh2 = webhook({ id: "wh-2", url: "https://b.example.com/hook", events: ["offer.created"] });
    (store.listWebhooks as any).mockResolvedValue([wh1, wh2]);

    // First call throws, second succeeds.
    let calls = 0;
    fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("timeout");
      return new Response("ok", { status: 200 });
    }) as any;
    vi.stubGlobal("fetch", fetchMock);

    await triggerWebhooks(store, "tenant-A", "offer.created", "offer", "off-1", { id: "off-1" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.createWebhookDelivery).toHaveBeenCalledTimes(2);
    expect(store.updateWebhookDelivery).toHaveBeenCalledTimes(2);
  });
});

// ── triggerWebhooks — sanitization integration ────────────────────────────

describe("webhook delivery — PII sanitization runs before signing + delivery", () => {
  let store: Store;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = mockStore();
    fetchMock = vi.fn(async () => new Response("ok", { status: 200 })) as any;
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAll_globals?.();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("strips PII from a nested payload before signing", async () => {
    const wh = webhook({ id: "wh-1", events: ["offer.created"] });
    (store.listWebhooks as any).mockResolvedValue([wh]);

    const entity = {
      id: "off-1",
      partner: { name: "Acme", email: "ops@acme.test", secret: "tok" },
      items: [
        { sku: "A1", unit_price: 10, api_key: "sk_live" },
        { sku: "B2", unit_price: 20 },
      ],
    };

    await triggerWebhooks(store, "tenant-A", "offer.created", "offer", "off-1", entity as any);

    const body = fetchMock.mock.calls[0][1].body as string;
    const parsed = JSON.parse(body);
    expect(parsed.data.partner.name).toBe("Acme");
    expect(parsed.data.partner.email).toBe("ops@acme.test");
    expect("secret" in parsed.data.partner).toBe(false);
    expect("api_key" in parsed.data.items[0]).toBe(false);
    expect(parsed.data.items[0].sku).toBe("A1");
  });

  it("does NOT mutate the caller's entity (the route handler may still need it for audit)", async () => {
    const wh = webhook({ id: "wh-1", events: ["offer.created"] });
    (store.listWebhooks as any).mockResolvedValue([wh]);

    const entity = { id: "off-1", password: "hunter2", total: 100 };
    await triggerWebhooks(store, "tenant-A", "offer.created", "offer", "off-1", entity as any);

    expect((entity as any).password).toBe("hunter2");
  });
});

// ── Module constants ──────────────────────────────────────────────────────

describe("webhook delivery — module constants", () => {
  it("MAX_WEBHOOK_ATTEMPTS is 5 (matches the BACKOFF_MS schedule length)", () => {
    expect(MAX_WEBHOOK_ATTEMPTS).toBe(5);
  });
});

// ── sanitizeWebhookPayload direct sanity (already covered by webhook-pii.test.ts
// but assert once here so the webhook-delivery test file is self-contained) ──

describe("webhook delivery — sanitizeWebhookPayload re-exported", () => {
  it("is the same function the deliver module uses internally", () => {
    expect(typeof sanitizeWebhookPayload).toBe("function");
    const out = sanitizeWebhookPayload({ id: 1, password: "x" }) as Record<string, unknown>;
    expect(out.id).toBe(1);
    expect("password" in out).toBe(false);
  });
});
