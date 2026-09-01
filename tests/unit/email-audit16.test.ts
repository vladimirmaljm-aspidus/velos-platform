import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { encryptField, hmacField, isEncrypted, decryptField } from "@/lib/crypto/field-encryption";
import type { Store } from "@/lib/data/store";

// AUDIT16 regression tests.
//
// Continuation of the audit15 email audit. New bug classes covered here:
//
//   1. KYC rejected / resubmit emails still sent To: the raw `enc:`
//      ciphertext contact_email (audit15 fixed only the approved path).
//   2. approveKycAndTransfer wrote partner PII in PLAINTEXT (no
//      encryptField, no tax_id/vat_number HMAC tokens).
//   3. mail-queue retry re-sent the stored `enc:` to_email verbatim
//      (retry failed forever), duplicated failed rows, and lost the PDF
//      attachment (see mail-queue-audit16.test.ts).
//   4. sendEmail returned success:true with no provider configured, so
//      invoice/proforma/offer/LOI routes marked documents "sent" even
//      though nothing was emailed (see mail-queue-audit16.test.ts).
//   5. portal-access permissions PUT wrote portal_email RAW (no
//      encrypt + no hmac — stale hmac kept the OLD email loginable) and
//      leaked portal_email_hmac in responses.
//   6. POST /api/email-templates spread `...body` LAST — a tenant admin
//      could override tenant_id/created_by and write another tenant's
//      templates (cross-tenant injection into PDFs/emails).
//   7. LOI send: flipped status to "sent" even when the email FAILED,
//      built the email HTML with unescaped user values, and had no
//      guard against an unreadable (enc:) partner address.
//   8. auth/me + portal/me masked DB outages as 200 {user:null}.

const {
  mockSendEmail,
  mockGetStore,
  mockRequireAuth,
  mockAudit,
  mockGetIp,
  mockSanitizeError,
  mockCheckRateLimit,
  mockRequirePermission,
  mockRequireFeature,
  mockUpsertDocumentTemplate,
  mockUpsertPortalAccess,
  mockUpsertLoi,
  mockListDocumentRegister,
  mockUpsertDocumentRegisterEntry,
  mockGeneratePdf,
  mockNotify,
  mockWithApm,
  mockGetSupabase,
  mockLookupIp,
} = vi.hoisted(() => ({
  mockSendEmail: vi.fn(),
  mockGetStore: vi.fn(),
  mockRequireAuth: vi.fn(),
  mockAudit: vi.fn(async () => {}),
  mockGetIp: vi.fn(() => "203.0.113.7"),
  mockSanitizeError: vi.fn((e: any) => e?.message || "error"),
  mockCheckRateLimit: vi.fn(async () => ({ allowed: true })),
  mockRequirePermission: vi.fn(() => null),
  mockRequireFeature: vi.fn(async () => null),
  mockUpsertDocumentTemplate: vi.fn(async (t: any) => ({ id: "tpl-1", ...t })),
  mockUpsertPortalAccess: vi.fn(async (p: any) => ({
    id: "pa-1",
    tenant_id: "t1",
    partner_id: "p1",
    tier: "business",
    status: "active",
    portal_email: p.portal_email ?? "legacy@example.com",
    portal_email_hmac: p.portal_email_hmac,
    ...p,
  })),
  mockUpsertLoi: vi.fn(async (l: any) => ({ ...l })),
  mockListDocumentRegister: vi.fn(async () => ({ items: [], total: 0 })),
  mockUpsertDocumentRegisterEntry: vi.fn(async () => ({})),
  mockGeneratePdf: vi.fn(async () => ({ buffer: Buffer.from("%PDF-fake"), pages: 1 })),
  mockNotify: vi.fn(async () => {}),
  mockWithApm: vi.fn((_h: any) => _h),
  mockGetSupabase: vi.fn(),
  mockLookupIp: vi.fn(async () => ({ country: null, city: null, region: null, latitude: null, longitude: null })),
}));

vi.mock("@/lib/data/store", () => ({
  getStore: mockGetStore,
}));

// Keep the REAL email templates — only stub the network send.
vi.mock("@/lib/email/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/service")>();
  return { ...actual, sendEmail: mockSendEmail };
});

vi.mock("@/lib/api/helpers", () => ({
  requireAuth: mockRequireAuth,
  audit: mockAudit,
  getIp: mockGetIp,
  sanitizeError: mockSanitizeError,
  resolveTenantId: vi.fn((auth: any) => auth.tenantId ?? null),
}));

vi.mock("@/lib/permissions/can", () => ({
  requirePermission: mockRequirePermission,
}));

vi.mock("@/lib/api/feature-guard", () => ({
  requireFeature: mockRequireFeature,
}));

vi.mock("@/lib/security/rate-limiter", () => ({
  checkRateLimit: mockCheckRateLimit,
  resetRateLimit: vi.fn(async () => {}),
}));

vi.mock("@/lib/permissions/sod-matrix", () => ({
  assertNoSoDViolation: vi.fn(async () => null),
}));

vi.mock("@/lib/api/status-validator", () => ({
  validateStatusTransition: vi.fn(() => ({ valid: true })),
}));

vi.mock("@/lib/notif/helper", () => ({
  notify: mockNotify,
}));

vi.mock("@/lib/pdf/generator", () => ({
  generatePdf: mockGeneratePdf,
}));

vi.mock("@/lib/utils/geo-ip", () => ({
  lookupIp: mockLookupIp,
}));

vi.mock("@/lib/supabase/client", () => ({
  getSupabase: mockGetSupabase,
  isSupabaseConfigured: vi.fn(() => true),
}));

beforeEach(() => {
  vi.resetModules();
  process.env.FIELD_ENCRYPTION_KEY = "audit16-email-test-encryption-key";
  process.env.APP_BASE_URL = "https://velos-platform.vercel.app";
  mockSendEmail.mockReset();
  mockSendEmail.mockResolvedValue({ success: true, messageId: "mid-1", provider: "postmark" });
  mockGetStore.mockReset();
  mockRequireAuth.mockReset();
  mockRequirePermission.mockClear();
  mockRequireFeature.mockClear();
  mockUpsertDocumentTemplate.mockClear();
  mockUpsertPortalAccess.mockReset();
  mockUpsertLoi.mockClear();
  mockListDocumentRegister.mockClear();
  mockUpsertDocumentRegisterEntry.mockClear();
  mockGeneratePdf.mockClear();
  mockNotify.mockClear();
  mockGetSupabase.mockReset();
});

// ---------------------------------------------------------------------------
// 1. KYC rejected / resubmit — encrypted To: addresses (audit15 missed
//    these two; only the approved path was fixed).
// ---------------------------------------------------------------------------
import { onKycRejected, onKycResubmit } from "@/lib/kyc/automation";

const CLIENT_EMAIL = "client@example.com";

function kycStore() {
  return {
    getTenant: vi.fn(async () => ({ id: "t1", name: "Acme Trading" })),
    appendAudit: vi.fn(async () => {}),
  } as unknown as Store;
}

describe("KYC onKycRejected — encrypted contact_email (audit16 EMAIL-ADDR)", () => {
  it("sends the rejection email to the DECRYPTED address, routed to the tenant", async () => {
    const store = kycStore();
    await onKycRejected({
      store,
      submission: { tenant_id: "t1", contact_email: "" } as any,
      partner: {
        id: "p1",
        name: "Partner Co",
        email: null,
        contact_email: encryptField("rejected@partner.example"),
      } as any,
      tenant: { id: "t1", name: "Acme Trading" } as any,
      reason: "Documents unreadable",
    });

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const call = mockSendEmail.mock.calls[0][0];
    // THE regression: before audit16 this was the raw `enc:…` ciphertext
    // (partner.email empty → contact_email raw).
    expect(call.to).toBe("rejected@partner.example");
    expect(call.to).not.toMatch(/^enc:/);
    expect(call.tenantId).toBe("t1");
    expect(call.subject).toMatch(/rejected/i);
  });

  it("falls back to the submission's contact_email when the partner has none", async () => {
    const store = kycStore();
    await onKycRejected({
      store,
      submission: { tenant_id: "t1", contact_email: "submitter@example.com" } as any,
      partner: { id: "p1", name: "Partner Co", email: null, contact_email: null } as any,
      tenant: { id: "t1", name: "Acme Trading" } as any,
      reason: null,
    });
    expect(mockSendEmail.mock.calls[0][0].to).toBe("submitter@example.com");
  });

  it("does NOT send when every candidate address is unreadable ciphertext", async () => {
    const store = kycStore();
    await onKycRejected({
      store,
      submission: { tenant_id: "t1", contact_email: null } as any,
      partner: { id: "p1", name: "Partner Co", email: null, contact_email: "enc:AAAA:BBBB:CCCC" } as any,
      tenant: { id: "t1", name: "Acme Trading" } as any,
      reason: null,
    });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

describe("KYC onKycResubmit — encrypted contact_email (audit16 EMAIL-ADDR)", () => {
  it("sends the resubmit request to the DECRYPTED address, routed to the tenant", async () => {
    const store = kycStore();
    await onKycResubmit({
      store,
      submission: { tenant_id: "t1", contact_email: "" } as any,
      partner: {
        id: "p1",
        name: "Partner Co",
        email: null,
        contact_email: encryptField("resubmit@partner.example"),
      } as any,
      tenant: { id: "t1", name: "Acme Trading" } as any,
      note: "Please re-upload the passport page",
    });

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const call = mockSendEmail.mock.calls[0][0];
    expect(call.to).toBe("resubmit@partner.example");
    expect(call.to).not.toMatch(/^enc:/);
    expect(call.tenantId).toBe("t1");
    expect(call.subject).toMatch(/update required|resubmit/i);
  });
});

// ---------------------------------------------------------------------------
// 2. resolveQueueToAddress — the mail-queue retry To: guard.
// ---------------------------------------------------------------------------
import { resolveQueueToAddress } from "@/lib/email/service";

describe("resolveQueueToAddress (audit16 MAIL-RETRY)", () => {
  it("passes plaintext addresses through unchanged and usable", () => {
    const { to, usable } = resolveQueueToAddress("plain@example.com");
    expect(to).toBe("plain@example.com");
    expect(usable).toBe(true);
  });

  it("decrypts an encrypted at-rest address", () => {
    const { to, usable } = resolveQueueToAddress(encryptField("queued@example.com"));
    expect(to).toBe("queued@example.com");
    expect(usable).toBe(true);
  });

  it("marks undecryptable ciphertext as unusable (rotated key)", () => {
    const { usable } = resolveQueueToAddress("enc:AAAA:BBBB:CCCC:DDDD");
    expect(usable).toBe(false);
  });

  it("rejects non-email garbage", () => {
    expect(resolveQueueToAddress("not-an-email").usable).toBe(false);
    expect(resolveQueueToAddress("").usable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. portal-access permissions PUT — encrypted portal_email + no HMAC leak.
// ---------------------------------------------------------------------------
import { PUT as permissionsPut } from "@/app/api/portal-access/[id]/permissions/route";

function makeAuth(store: Store) {
  return {
    tenantId: "t1",
    isSuperAdmin: false,
    ip: "203.0.113.7",
    user: { id: "u1", username: "admin", role: "admin", email: "admin@example.com" },
    store,
  };
}

function makeReq(body: unknown) {
  return new NextRequest("http://localhost/api/portal-access/pa-1/permissions", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("portal-access permissions PUT — portal_email encryption (audit16 SEC)", () => {
  beforeEach(() => {
    const store = {
      getPortalAccessById: vi.fn(async () => ({
        id: "pa-1", tenant_id: "t1", partner_id: "p1", tier: "business", status: "active",
      })),
      upsertPortalAccess: mockUpsertPortalAccess,
      appendAudit: vi.fn(async () => {}),
    } as unknown as Store;
    mockRequireAuth.mockResolvedValue(makeAuth(store));
    mockGetStore.mockResolvedValue(store);
  });

  it("encrypts portal_email and recomputes the HMAC search token", async () => {
    const res = await permissionsPut(makeReq({ portal_email: "newclient@example.com" }) as any, {
      params: Promise.resolve({ id: "pa-1" }),
    });
    expect(res.status).toBe(200);

    const upsertCall = mockUpsertPortalAccess.mock.calls[0][0];
    expect(upsertCall.portal_email).toMatch(/^enc:/);
    expect(upsertCall.portal_email).not.toBe("newclient@example.com");
    expect(upsertCall.portal_email_hmac).toBe(hmacField("newclient@example.com"));

    const body = await res.json();
    // The response decrypts the email back for the admin UI…
    expect(body.portal_email).toBe("newclient@example.com");
    // …and never leaks the internal HMAC token.
    expect(body.portal_email_hmac).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("portal_email_hmac");
  });

  it("is idempotent for an already-encrypted value (no double-encryption)", async () => {
    const already = encryptField("stable@example.com");
    const res = await permissionsPut(makeReq({ portal_email: already }) as any, {
      params: Promise.resolve({ id: "pa-1" }),
    });
    expect(res.status).toBe(200);
    // The raw update the route passed contains NO portal_email rewrite
    // (the encrypted blob round-trips through the admin UI unchanged —
    // re-encrypting it would corrupt the row with a nested ciphertext).
    const upsertCall = mockUpsertPortalAccess.mock.calls[0][0];
    expect(upsertCall.portal_email).toBeUndefined();
    expect(upsertCall.portal_email_hmac).toBeUndefined();
  });

  it("still updates plain permission fields untouched by the email logic", async () => {
    const res = await permissionsPut(makeReq({ tier: "premium", can_view_invoices: true }) as any, {
      params: Promise.resolve({ id: "pa-1" }),
    });
    expect(res.status).toBe(200);
    const upsertCall = mockUpsertPortalAccess.mock.calls[0][0];
    expect(upsertCall.tier).toBe("premium");
    expect(upsertCall.can_view_invoices).toBe(true);
    expect(upsertCall.portal_email).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. POST /api/email-templates — cross-tenant write via body-spread (HIGH-1).
// ---------------------------------------------------------------------------
import { POST as templatesPost } from "@/app/api/email-templates/route";

describe("email-templates POST — trusted keys survive the spread (audit16 HIGH-1)", () => {
  beforeEach(() => {
    const store = {
      upsertDocumentTemplate: mockUpsertDocumentTemplate,
      listDocumentTemplates: vi.fn(async () => []),
      appendAudit: vi.fn(async () => {}),
    } as unknown as Store;
    mockRequireAuth.mockResolvedValue(makeAuth(store));
    mockGetStore.mockResolvedValue(store);
  });

  it("ignores client-supplied tenant_id / created_by (cross-tenant write)", async () => {
    const req = new NextRequest("http://localhost/api/email-templates", {
      method: "POST",
      body: JSON.stringify({
        name: "Evil template",
        type: "invoice",
        // The attack: overwrite the trusted keys through the spread.
        tenant_id: "victim-tenant",
        created_by: "attacker-user",
        id: "tpl-victim",
      }),
      headers: { "content-type": "application/json" },
    });
    const res = await templatesPost(req);
    expect(res.status).toBe(200);

    const saved = mockUpsertDocumentTemplate.mock.calls[0][0];
    expect(saved.tenant_id).toBe("t1"); // server-resolved, not "victim-tenant"
    expect(saved.created_by).toBe("u1"); // auth user, not "attacker-user"
  });

  it("maps email fields into the footer_content wrapper (audit20 / 20-b)", async () => {
    const req = new NextRequest("http://localhost/api/email-templates", {
      method: "POST",
      body: JSON.stringify({
        name: "My template",
        subject: "Invoice {{invoiceNumber}}",
        html: "<div>body</div>",
        category: "transactional",
        variables: ["invoiceNumber"],
        description: "desc",
      }),
      headers: { "content-type": "application/json" },
    });
    await templatesPost(req);
    const saved = mockUpsertDocumentTemplate.mock.calls[0][0];
    expect(saved.name).toBe("My template");
    // audit20 / 20-b — email rows are NOT PDF templates, so `type` is
    // route-controlled: body.type is ignored (an email row posing as an
    // "offer"/"invoice" type would pollute the PDF template namespace)
    // and is_default is pinned false (email rows must never become the
    // PDF default for a type).
    expect(saved.type).toBe("generic");
    expect(saved.is_default).toBe(false);
    // The email fields persist inside the REAL footer_content column as an
    // { emailTemplate } JSON wrapper — they must NOT reach the store as
    // top-level columns (document_templates has no subject/html/category/
    // variables/description columns; the supabase smartUpsert strips one
    // unknown column then throws on the next → every save 500'd).
    const wrapper = JSON.parse(saved.footer_content).emailTemplate;
    expect(wrapper.subject).toBe("Invoice {{invoiceNumber}}");
    expect(wrapper.html).toBe("<div>body</div>");
    expect(wrapper.category).toBe("transactional");
    expect(wrapper.variables).toEqual(["invoiceNumber"]);
    expect(wrapper.description).toBe("desc");
    expect(saved.subject).toBeUndefined();
    expect(saved.html).toBeUndefined();
    expect(saved.category).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4b. POST /api/email-templates action:"test-send" (audit20 / 20-b).
//     The old route let the test-send payload fall into the upsert path —
//     every click created a junk "Custom Template" row and STILL sent no
//     email while the UI toasted success. Handled explicitly now: lookup
//     the saved template, unwrap footer_content's emailTemplate, send to
//     the requesting user. NEVER creates rows.
// ---------------------------------------------------------------------------
describe("email-templates POST action:test-send — sends, never writes (audit20 / 20-b)", () => {
  function makeTemplateStore(tpl: Record<string, unknown> | null) {
    return {
      getDocumentTemplate: vi.fn(async () => tpl),
      upsertDocumentTemplate: mockUpsertDocumentTemplate,
      listDocumentTemplates: vi.fn(async () => []),
      appendAudit: vi.fn(async () => {}),
    } as unknown as Store;
  }
  const wrapperRow = {
    id: "tpl-1",
    tenant_id: "t1",
    name: "Invoice Notification",
    footer_content: JSON.stringify({
      emailTemplate: { subject: "Invoice INV-1", html: "<div>hello</div>", category: "transactional", variables: [], description: "" },
    }),
  };

  it("sends the wrapped body to the requesting user with a [TEST] prefix and creates NO rows", async () => {
    const store = makeTemplateStore(wrapperRow);
    mockRequireAuth.mockResolvedValue(makeAuth(store));
    mockGetStore.mockResolvedValue(store);

    const req = new NextRequest("http://localhost/api/email-templates", {
      method: "POST",
      body: JSON.stringify({ action: "test-send", templateId: "tpl-1" }),
      headers: { "content-type": "application/json" },
    });
    const res = await templatesPost(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, sent: true });
    // Send to the requesting user's own address, subject prefixed.
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const opts = mockSendEmail.mock.calls[0][0];
    expect(opts.to).toBe("admin@example.com");
    expect(opts.subject).toBe("[TEST] Invoice INV-1");
    expect(opts.html).toBe("<div>hello</div>");
    // Junk-row regression: the upsert must NEVER fire on test-send.
    expect(mockUpsertDocumentTemplate).not.toHaveBeenCalled();
  });

  it("400s when the template has no saved HTML body (nothing to send)", async () => {
    const store = makeTemplateStore({ ...wrapperRow, footer_content: "" });
    mockRequireAuth.mockResolvedValue(makeAuth(store));
    mockGetStore.mockResolvedValue(store);

    const req = new NextRequest("http://localhost/api/email-templates", {
      method: "POST",
      body: JSON.stringify({ action: "test-send", templateId: "tpl-1" }),
      headers: { "content-type": "application/json" },
    });
    const res = await templatesPost(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Test send requires a saved template with an HTML body.");
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockUpsertDocumentTemplate).not.toHaveBeenCalled();
  });

  it("404s for a missing template (no junk row, no send)", async () => {
    const store = makeTemplateStore(null);
    mockRequireAuth.mockResolvedValue(makeAuth(store));
    mockGetStore.mockResolvedValue(store);

    const req = new NextRequest("http://localhost/api/email-templates", {
      method: "POST",
      body: JSON.stringify({ action: "test-send", templateId: "tpl-missing" }),
      headers: { "content-type": "application/json" },
    });
    const res = await templatesPost(req);
    expect(res.status).toBe(404);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockUpsertDocumentTemplate).not.toHaveBeenCalled();
  });

  it("404s when the template belongs to another tenant (no cross-tenant probe)", async () => {
    const store = makeTemplateStore({ ...wrapperRow, tenant_id: "other-tenant" });
    mockRequireAuth.mockResolvedValue(makeAuth(store));
    mockGetStore.mockResolvedValue(store);

    const req = new NextRequest("http://localhost/api/email-templates", {
      method: "POST",
      body: JSON.stringify({ action: "test-send", templateId: "tpl-1" }),
      headers: { "content-type": "application/json" },
    });
    const res = await templatesPost(req);
    expect(res.status).toBe(404);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("reports queued sends as 409 instead of faking success (audit16 parity)", async () => {
    const store = makeTemplateStore(wrapperRow);
    mockRequireAuth.mockResolvedValue(makeAuth(store));
    mockGetStore.mockResolvedValue(store);
    mockSendEmail.mockResolvedValueOnce({ success: true, queued: true });

    const req = new NextRequest("http://localhost/api/email-templates", {
      method: "POST",
      body: JSON.stringify({ action: "test-send", templateId: "tpl-1" }),
      headers: { "content-type": "application/json" },
    });
    const res = await templatesPost(req);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("No email provider is configured");
    expect(mockUpsertDocumentTemplate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. LOI send — delivered flag, XSS escape, unreadable-address guard.
// ---------------------------------------------------------------------------
import { POST as loiSendPost } from "@/app/api/lois/[id]/send/route";

function loiFixture(partner: Record<string, unknown>) {
  const store = {
    getLoi: vi.fn(async () => ({
      id: "loi-1",
      tenant_id: "t1",
      partner_id: "p1",
      number: "LOI-2026-000001",
      subject: "Coffee beans shipment",
      product_name: "Arabica Coffee",
      quantity: 1000,
      unit: "MT",
      unit_price: 3.5,
      total_value: 3500,
      currency: "USD",
      delivery_terms: "CIF Hamburg",
      delivery_date: "2026-09-01",
      payment_terms: "LC at sight",
      validity_until: "2026-09-15",
      terms_text: "Standard terms apply",
      notes: null,
      buyer_name: "John Buyer",
      status: "draft",
      sent_at: null,
    })),
    getPartner: vi.fn(async () => partner),
    getTenant: vi.fn(async () => ({ id: "t1", name: "Acme Trading" })),
    upsertLoi: mockUpsertLoi,
    listDocumentRegister: mockListDocumentRegister,
    upsertDocumentRegisterEntry: mockUpsertDocumentRegisterEntry,
    appendAudit: vi.fn(async () => {}),
  } as unknown as Store;
  return store;
}

function loiReq() {
  return new NextRequest("http://localhost/api/lois/loi-1/send", { method: "POST" });
}

describe("LOI send — delivery-gated status flip (audit16 EMAIL-STATE)", () => {
  beforeEach(() => {
    const store = loiFixture({ id: "p1", name: "Partner Co", email: "buyer@partner.example" });
    mockRequireAuth.mockResolvedValue(makeAuth(store));
    mockGetStore.mockResolvedValue(store);
  });

  it("marks the LOI sent ONLY when the email was actually delivered", async () => {
    mockSendEmail.mockResolvedValueOnce({ success: true, messageId: "m1", provider: "postmark" });
    const res = await loiSendPost(loiReq(), { params: Promise.resolve({ id: "loi-1" }) });
    expect(res.status).toBe(200);
    expect(mockUpsertLoi).toHaveBeenCalledWith(
      expect.objectContaining({ id: "loi-1", status: "sent", sent_at: expect.any(String) }),
    );
  });

  it("does NOT mark the LOI sent when the send fails (previously flipped status + stamped sent_at)", async () => {
    mockSendEmail.mockResolvedValueOnce({ success: false, error: "postmark 500" });
    const res = await loiSendPost(loiReq(), { params: Promise.resolve({ id: "loi-1" }) });
    expect(res.status).toBe(500);
    expect(mockUpsertLoi).not.toHaveBeenCalled();
  });

  it("does NOT mark the LOI sent when the email was merely queued (no provider)", async () => {
    mockSendEmail.mockResolvedValueOnce({ success: true, queued: true, provider: "none" });
    const res = await loiSendPost(loiReq(), { params: Promise.resolve({ id: "loi-1" }) });
    expect(res.status).toBe(409);
    expect(mockUpsertLoi).not.toHaveBeenCalled();
  });

  it("refuses to send when the partner's address is unreadable ciphertext (422, not a garbage To:)", async () => {
    const store = loiFixture({ id: "p1", name: "Partner Co", email: null, contact_email: "enc:AAAA:BBBB" });
    mockRequireAuth.mockResolvedValue(makeAuth(store));
    mockGetStore.mockResolvedValue(store);
    const res = await loiSendPost(loiReq(), { params: Promise.resolve({ id: "loi-1" }) });
    expect(res.status).toBe(422);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("escapes user-controlled values in the email HTML (XSS)", async () => {
    const store = loiFixture({ id: "p1", name: '<img src=x onerror="alert(1)">', email: "buyer@partner.example" });
    mockRequireAuth.mockResolvedValue(makeAuth(store));
    mockGetStore.mockResolvedValue(store);
    await loiSendPost(loiReq(), { params: Promise.resolve({ id: "loi-1" }) });
    const html = mockSendEmail.mock.calls[0][0].html as string;
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).toContain("&lt;img src=x onerror=");
  });

  it("passes the entity reference so the mail-queue retry can regenerate the PDF", async () => {
    await loiSendPost(loiReq(), { params: Promise.resolve({ id: "loi-1" }) });
    expect(mockSendEmail.mock.calls[0][0].entityType).toBe("loi");
    expect(mockSendEmail.mock.calls[0][0].entityId).toBe("loi-1");
  });

  it("decrypts the partner's encrypted contact_email for the To: address", async () => {
    const store = loiFixture({ id: "p1", name: "Partner Co", email: null, contact_email: encryptField("encbuyer@partner.example") });
    mockRequireAuth.mockResolvedValue(makeAuth(store));
    mockGetStore.mockResolvedValue(store);
    await loiSendPost(loiReq(), { params: Promise.resolve({ id: "loi-1" }) });
    expect(mockSendEmail.mock.calls[0][0].to).toBe("encbuyer@partner.example");
  });
});

// ---------------------------------------------------------------------------
// 6. markDocumentViewed — decrypts the viewer email centrally.
// ---------------------------------------------------------------------------
describe("markDocumentViewed — viewer email decryption (audit16 DATA)", () => {
  it("stores the DECRYPTED email in viewed_by_email (was ciphertext before)", async () => {
    const chain: any = {
      eq: vi.fn(() => chain),
      select: vi.fn(() => chain),
      // supabase-js builders resolve { data, error } — mirror that shape.
      maybeSingle: async () => ({ data: { view_count: 0, status: "sent", viewed_at: null }, error: null }),
      update: vi.fn(() => chain),
    };
    const sb = { from: vi.fn(() => chain) };
    mockGetSupabase.mockReturnValue(sb);
    const { markDocumentViewed } = await import("@/lib/portal/mark-viewed");
    await markDocumentViewed("offers", "of-1", "t1", encryptField("viewer@example.com"));
    // The update payload must contain the PLAINTEXT email.
    const updateCall = chain.update.mock.calls[0][0];
    expect(updateCall.viewed_by_email).toBe("viewer@example.com");
    expect(updateCall.viewed_by_email).not.toMatch(/^enc:/);
  });

  it("passes plaintext viewer emails through unchanged", async () => {
    const chain: any = {
      eq: vi.fn(() => chain),
      select: vi.fn(() => chain),
      maybeSingle: async () => ({ data: { view_count: 2, status: "viewed", viewed_at: "2026-01-01" }, error: null }),
      update: vi.fn(() => chain),
    };
    mockGetSupabase.mockReturnValue({ from: vi.fn(() => chain) });
    const { markDocumentViewed } = await import("@/lib/portal/mark-viewed");
    await markDocumentViewed("invoices", "in-1", "t1", "plain@viewer.example");
    const updateCall = chain.update.mock.calls[0][0];
    expect(updateCall.viewed_by_email).toBe("plain@viewer.example");
    // First-view flag not re-stamped on an already-viewed doc.
    expect(updateCall.viewed_at).toBeUndefined();
    expect(updateCall.status).toBeUndefined();
  });
});
