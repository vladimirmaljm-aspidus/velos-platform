import { describe, it, expect } from "vitest";
import { sanitizeWebhookPayload, isPiiField } from "@/lib/webhooks/deliver";

describe("isPiiField", () => {
  it("flags common secret field names", () => {
    expect(isPiiField("password")).toBe(true);
    expect(isPiiField("password_hash")).toBe(true);
    expect(isPiiField("token")).toBe(true);
    expect(isPiiField("secret")).toBe(true);
    expect(isPiiField("api_key")).toBe(true);
    expect(isPiiField("private_key")).toBe(true);
    expect(isPiiField("portal_token")).toBe(true);
    expect(isPiiField("smtp_password")).toBe(true);
    expect(isPiiField("credit_card")).toBe(true);
    expect(isPiiField("cvv")).toBe(true);
  });

  it("flags compound names containing the marker (substring match)", () => {
    expect(isPiiField("user_password")).toBe(true);
    expect(isPiiField("refresh_token_v2")).toBe(true);
    expect(isPiiField("user_api_key")).toBe(true); // case-insensitive
    expect(isPiiField("billing_private_key_pem")).toBe(true);
    expect(isPiiField("UserApiKey")).toBe(true); // case-insensitive camelCase
  });

  it("does NOT flag business-domain field names", () => {
    // These are intentionally NOT in the marker list — they ARE the
    // payload's purpose (the receiver signed up to know about them).
    expect(isPiiField("name")).toBe(false);
    expect(isPiiField("email")).toBe(false);
    expect(isPiiField("price")).toBe(false);
    expect(isPiiField("total")).toBe(false);
    expect(isPiiField("invoice_number")).toBe(false);
    expect(isPiiField("partner_id")).toBe(false);
    expect(isPiiField("tenant_id")).toBe(false);
    expect(isPiiField("status")).toBe(false);
    expect(isPiiField("id")).toBe(false);
  });
});

describe("sanitizeWebhookPayload", () => {
  it("strips top-level PII fields", () => {
    const input = {
      id: "inv_123",
      number: "INV-2024-001",
      partner_id: "p_456",
      password: "hunter2",
      api_key: "sk_live_abc",
      total: 1500,
    };
    const out = sanitizeWebhookPayload(input) as Record<string, unknown>;
    expect(out.id).toBe("inv_123");
    expect(out.number).toBe("INV-2024-001");
    expect(out.partner_id).toBe("p_456");
    expect(out.total).toBe(1500);
    // PII stripped — key absent from output entirely (not even null).
    expect("password" in out).toBe(false);
    expect("api_key" in out).toBe(false);
  });

  it("recurses into nested objects", () => {
    const input = {
      partner: {
        name: "Acme Corp",
        email: "ops@acme.test",
        contact: {
          name: "Jane",
          smtp_password: "mail-secret",
        },
      },
      metadata: {
        created_by: "user_1",
        portal_token: "tok_abc",
      },
    };
    const out = sanitizeWebhookPayload(input) as any;
    expect(out.partner.name).toBe("Acme Corp");
    expect(out.partner.email).toBe("ops@acme.test");
    expect(out.partner.contact.name).toBe("Jane");
    expect("smtp_password" in out.partner.contact).toBe(false);
    expect(out.metadata.created_by).toBe("user_1");
    expect("portal_token" in out.metadata).toBe(false);
  });

  it("recurses into arrays of objects", () => {
    const input = {
      line_items: [
        { sku: "A1", unit_price: 10, secret: "s1" },
        { sku: "B2", unit_price: 20, secret: "s2" },
      ],
    };
    const out = sanitizeWebhookPayload(input) as any;
    expect(out.line_items).toHaveLength(2);
    expect(out.line_items[0].sku).toBe("A1");
    expect(out.line_items[0].unit_price).toBe(10);
    expect("secret" in out.line_items[0]).toBe(false);
    expect("secret" in out.line_items[1]).toBe(false);
  });

  it("passes primitives through unchanged", () => {
    expect(sanitizeWebhookPayload("hello")).toBe("hello");
    expect(sanitizeWebhookPayload(42)).toBe(42);
    expect(sanitizeWebhookPayload(true)).toBe(true);
    expect(sanitizeWebhookPayload(null)).toBe(null);
    expect(sanitizeWebhookPayload(undefined)).toBe(undefined);
  });

  it("does NOT mutate the input (caller's data is untouched)", () => {
    const input = {
      name: "Acme",
      password: "hunter2",
      nested: { token: "tok", value: 1 },
    };
    sanitizeWebhookPayload(input);
    // Caller's object still has the original fields.
    expect((input as any).password).toBe("hunter2");
    expect((input as any).nested.token).toBe("tok");
  });

  it("handles empty objects and arrays", () => {
    expect(sanitizeWebhookPayload({})).toEqual({});
    expect(sanitizeWebhookPayload([])).toEqual([]);
  });

  it("case-insensitive: strips PASSWORD and Token regardless of case", () => {
    const input = {
      Password: "x",
      TOKEN: "y",
      ApiKey: "z",
      Name: "Acme",
    };
    const out = sanitizeWebhookPayload(input) as Record<string, unknown>;
    expect("Password" in out).toBe(false);
    expect("TOKEN" in out).toBe(false);
    expect("ApiKey" in out).toBe(false);
    expect(out.Name).toBe("Acme");
  });
});
