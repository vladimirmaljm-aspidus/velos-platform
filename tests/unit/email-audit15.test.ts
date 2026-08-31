import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { encryptField, hmacField } from "@/lib/crypto/field-encryption";
import type { Store } from "@/lib/data/store";

// AUDIT15 / EMAIL regression tests.
//
// User report: "ne smemo imati greske i neposlate mejlove posebno kada
// klijent treba da dobije obavestenje ili menja sifru ili dobije pozivni
// mejl da se uloguje, sve to mora biti posebno odvojeno za svakog tenanta".
//
// Bugs found by this audit and covered here:
//   1. Admin→client portal messages sent the To: address as the raw
//      `enc:`-ciphertext portal_email (P0-3 at-rest encryption) — every
//      provider rejects that, so client notification emails silently
//      failed for portal accounts created through the API.
//   2. KYC automation had the same ciphertext-To bug for the welcome
//      email AND wrote new portal rows with plaintext portal_email +
//      no HMAC search token (bypassing the API-layer encryption).
//   3. The portal invite route never set `welcome_email_sent: true`
//      after a successful send — production had 5/8 rows stuck on
//      "Not sent", inviting admins to re-send (spam).
//   4. No password-change confirmation email anywhere (setup / reset /
//      change) — an attacker could rotate a password silently.
//   5. forgot-password threw a 500 when the portal row's tenant was
//      deleted (tenant.id on null) instead of the generic 200.

const {
  mockSendEmail,
  mockGetStore,
  mockRequireAuth,
  mockAudit,
  mockGetIp,
  mockSanitizeError,
  mockCheckRateLimit,
  mockConsumePasswordReset,
  mockCreatePasswordReset,
  mockRequirePermission,
  mockRequireFeature,
  mockNotifyPortalInviteSent,
  mockInsertMessage,
  mockNotifyNewMessage,
  mockHashPassword,
  mockValidatePassword,
} = vi.hoisted(() => ({
  mockSendEmail: vi.fn(),
  mockGetStore: vi.fn(),
  mockRequireAuth: vi.fn(),
  mockAudit: vi.fn(async () => {}),
  mockGetIp: vi.fn(() => "203.0.113.7"),
  mockSanitizeError: vi.fn(() => null),
  mockCheckRateLimit: vi.fn(async () => ({ allowed: true })),
  mockConsumePasswordReset: vi.fn(),
  mockCreatePasswordReset: vi.fn(),
  mockRequirePermission: vi.fn(() => null),
  mockRequireFeature: vi.fn(async () => null),
  mockNotifyPortalInviteSent: vi.fn(async () => {}),
  mockInsertMessage: vi.fn(async () => ({ id: "m1" })),
  mockNotifyNewMessage: vi.fn(() => Promise.resolve()),
  mockHashPassword: vi.fn(async (p: string) => `hashed:${p}`),
  mockValidatePassword: vi.fn(async () => ({ ok: true, errors: [] })),
}));

vi.mock("@/lib/data/store", () => ({
  getStore: mockGetStore,
}));

// Keep the REAL email templates (passwordChangedEmail etc.) — only stub
// the network send. This lets route tests assert on the real subject/body.
vi.mock("@/lib/email/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/service")>();
  return { ...actual, sendEmail: mockSendEmail };
});

vi.mock("@/lib/api/helpers", () => ({
  requireAuth: mockRequireAuth,
  audit: mockAudit,
  getIp: mockGetIp,
  sanitizeError: mockSanitizeError,
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

vi.mock("@/lib/security/rate-limit-config", () => ({
  getRateLimitConfig: vi.fn(async () => ({
    forgotPasswordMaxAttempts: 5,
    forgotPasswordWindowMs: 15 * 60 * 1000,
    setupPasswordMaxAttempts: 10,
    setupPasswordWindowMs: 15 * 60 * 1000,
  })),
  DEFAULT_RATE_LIMIT_CONFIG: {},
}));

vi.mock("@/lib/auth/password-reset", () => ({
  consumePasswordReset: mockConsumePasswordReset,
  createPasswordReset: mockCreatePasswordReset,
}));

vi.mock("@/lib/auth/password", () => ({
  hashPassword: mockHashPassword,
  // Smart fake: a password "verifies" only when it is the fixture's known
  // current password — so the new-password-must-differ check passes.
  verifyPassword: vi.fn(async (candidate: string, _hash: string) => candidate === "OldP@ssw0rd"),
}));

vi.mock("@/lib/auth/password-policy", () => ({
  validatePasswordWithPlatformPolicy: mockValidatePassword,
}));

vi.mock("@/lib/notif/helper", () => ({
  notify: vi.fn(async () => {}),
  notifyPortalInviteSent: mockNotifyPortalInviteSent,
}));

vi.mock("@/lib/portal/messages", () => ({
  insertMessage: mockInsertMessage,
  sanitizeMessageBody: vi.fn((b: string) => b),
  markThreadRead: vi.fn(async () => {}),
  listThread: vi.fn(async () => []),
}));

vi.mock("@/lib/realtime/notify", () => ({
  notifyNewMessage: mockNotifyNewMessage,
}));

beforeEach(() => {
  vi.resetModules();
  process.env.FIELD_ENCRYPTION_KEY = "audit15-email-test-encryption-key";
  process.env.APP_BASE_URL = "https://velos-platform.vercel.app";
  mockSendEmail.mockReset();
  mockSendEmail.mockResolvedValue({ success: true, messageId: "mid-1", provider: "postmark" });
  mockGetStore.mockReset();
  mockRequireAuth.mockReset();
  mockConsumePasswordReset.mockReset();
  mockCreatePasswordReset.mockReset();
  mockCreatePasswordReset.mockResolvedValue({ token: "setup-token-123", expiresAt: new Date().toISOString() });
  mockNotifyPortalInviteSent.mockClear();
  mockInsertMessage.mockClear();
});

// ---------------------------------------------------------------------------
// 1. The passwordChangedEmail template (pure unit — no mocks involved
//    beyond the module-level sendEmail stub).
// ---------------------------------------------------------------------------
import { passwordChangedEmail } from "@/lib/email/service";

describe("passwordChangedEmail template (audit15 EMAIL-NOTIF)", () => {
  it("renders all three kinds with distinct subjects", () => {
    for (const kind of ["setup", "reset", "change"] as const) {
      const { subject, html } = passwordChangedEmail({
        accountName: "client@example.com",
        tenantName: "Acme Trading",
        kind,
      });
      expect(subject).toBeTruthy();
      expect(html).toContain("client@example.com");
      expect(html).toContain("Acme Trading");
    }
    const setup = passwordChangedEmail({ accountName: "a@b.co", tenantName: "T", kind: "setup" });
    expect(setup.subject).toContain("account is active");
    const reset = passwordChangedEmail({ accountName: "a@b.co", tenantName: "T", kind: "reset" });
    expect(reset.subject).toContain("Password reset");
    const change = passwordChangedEmail({ accountName: "a@b.co", tenantName: "T", kind: "change" });
    expect(change.subject).toContain("Password changed");
  });

  it("includes the 'if this wasn't you' warning ONLY for kind=change", () => {
    const change = passwordChangedEmail({ accountName: "a@b.co", tenantName: "T", kind: "change" });
    expect(change.html).toContain("did <strong>not</strong> change your password");
    const reset = passwordChangedEmail({ accountName: "a@b.co", tenantName: "T", kind: "reset" });
    expect(reset.html).not.toContain("did <strong>not</strong> change your password");
    const setup = passwordChangedEmail({ accountName: "a@b.co", tenantName: "T", kind: "setup" });
    expect(setup.html).not.toContain("did <strong>not</strong> change your password");
  });

  it("HTML-escapes admin-controlled tenant names (XSS in email body)", () => {
    const { html } = passwordChangedEmail({
      accountName: "a@b.co",
      tenantName: `<img src=x onerror=alert(1)>`,
      kind: "change",
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("renders actor IP + device rows when provided, omits them when not", () => {
    const withActor = passwordChangedEmail({
      accountName: "a@b.co",
      tenantName: "T",
      kind: "change",
      ip: "198.51.100.9",
      userAgent: "Mozilla/5.0 TestUA",
    });
    expect(withActor.html).toContain("198.51.100.9");
    expect(withActor.html).toContain("TestUA");
    const withoutActor = passwordChangedEmail({
      accountName: "a@b.co",
      tenantName: "T",
      kind: "change",
    });
    expect(withoutActor.html).not.toContain("IP address");
  });

  it("uses the APP_BASE_URL sign-in link when set", () => {
    const { html } = passwordChangedEmail({
      accountName: "a@b.co",
      tenantName: "T",
      kind: "setup",
      supportUrl: "https://velos-platform.vercel.app/portal/login",
    });
    expect(html).toContain("https://velos-platform.vercel.app/portal/login");
  });
});

// ---------------------------------------------------------------------------
// 2. KYC automation — ciphertext To: + plaintext-on-create bugs.
// ---------------------------------------------------------------------------
import { onKycApproved } from "@/lib/kyc/automation";

const CLIENT_EMAIL = "kyc-client@example.com";

function kycStoreFixture(access: Record<string, unknown> | null) {
  const upsertPortalAccess = vi.fn(async (p: any) => ({ ...access, ...p }));
  const store = {
    getPortalAccessById: vi.fn(async () => access),
    getPortalAccessByPartner: vi.fn(async () => access),
    upsertPortalAccess,
    getTenant: vi.fn(async () => ({ id: "t1", name: "Acme Trading" })),
    appendAudit: vi.fn(async () => {}),
  } as unknown as Store;
  return { store, upsertPortalAccess };
}

describe("KYC automation — encrypted portal_email handling (audit15 EMAIL-ADDR)", () => {
  it("sends the welcome email to the DECRYPTED address when the access row stores ciphertext", async () => {
    const { store } = kycStoreFixture({
      id: "pa-1",
      tenant_id: "t1",
      partner_id: "p1",
      tier: "business",
      status: "invited",
      welcome_email_sent: false,
      portal_email: encryptField(CLIENT_EMAIL),
    });
    mockGetStore.mockResolvedValue(store);

    await onKycApproved({
      store,
      submission: { tenant_id: "t1", contact_email: CLIENT_EMAIL } as any,
      partner: { id: "p1", name: "Partner Co", email: CLIENT_EMAIL } as any,
      tenant: { id: "t1", name: "Acme Trading" } as any,
      reviewerName: "Admin",
      baseUrl: "https://velos-platform.vercel.app",
    });

    const welcomeCall = mockSendEmail.mock.calls.find((c: any[]) => c[0].subject.startsWith("Welcome"));
    expect(welcomeCall).toBeDefined();
    // THE regression: before the fix this was the raw `enc:…` ciphertext.
    expect(welcomeCall![0].to).toBe(CLIENT_EMAIL);
    expect(welcomeCall![0].to).not.toMatch(/^enc:/);
    // Per-tenant isolation: the send is routed through the tenant's provider.
    expect(welcomeCall![0].tenantId).toBe("t1");
  });

  it("skips the welcome email entirely when the stored address cannot be decrypted", async () => {
    const { store } = kycStoreFixture({
      id: "pa-1",
      tenant_id: "t1",
      partner_id: "p1",
      tier: "business",
      status: "invited",
      welcome_email_sent: false,
      // enc: value encrypted with a DIFFERENT key → decryptField returns raw.
      portal_email: "enc:AAAA:BBBB:CCCC:DDDD",
    });
    mockGetStore.mockResolvedValue(store);

    await onKycApproved({
      store,
      submission: { tenant_id: "t1", contact_email: CLIENT_EMAIL } as any,
      partner: { id: "p1", name: "Partner Co", email: CLIENT_EMAIL } as any,
      tenant: { id: "t1", name: "Acme Trading" } as any,
      reviewerName: "Admin",
      baseUrl: "https://velos-platform.vercel.app",
    });

    const welcomeCall = mockSendEmail.mock.calls.find((c: any[]) => c[0].subject.startsWith("Welcome"));
    expect(welcomeCall).toBeUndefined();
  });

  it("encrypts portal_email + sets the HMAC search token when CREATING a new portal row", async () => {
    const { store, upsertPortalAccess } = kycStoreFixture(null);
    mockGetStore.mockResolvedValue(store);

    await onKycApproved({
      store,
      submission: { tenant_id: "t1", contact_email: CLIENT_EMAIL } as any,
      partner: { id: "p1", name: "Partner Co", email: null } as any,
      tenant: { id: "t1", name: "Acme Trading" } as any,
      reviewerName: "Admin",
      baseUrl: "https://velos-platform.vercel.app",
    });

    const createCall = upsertPortalAccess.mock.calls.find((c: any[]) => !c[0].id);
    expect(createCall).toBeDefined();
    expect(createCall![0].portal_email).toMatch(/^enc:/);
    expect(createCall![0].portal_email).not.toBe(CLIENT_EMAIL);
    expect(createCall![0].portal_email_hmac).toBe(hmacField(CLIENT_EMAIL));
    // The welcome email still goes to the PLAINTEXT address.
    const welcomeCall = mockSendEmail.mock.calls.find((c: any[]) => c[0].subject.startsWith("Welcome"));
    expect(welcomeCall).toBeDefined();
    expect(welcomeCall![0].to).toBe(CLIENT_EMAIL);
  });

  it("decrypts the partner's encrypted contact_email for the KYC-status email", async () => {
    const { store } = kycStoreFixture({
      id: "pa-1",
      tenant_id: "t1",
      partner_id: "p1",
      tier: "business",
      status: "invited",
      welcome_email_sent: true, // skip welcome block
      portal_email: encryptField(CLIENT_EMAIL),
    });
    mockGetStore.mockResolvedValue(store);

    await onKycApproved({
      store,
      submission: { tenant_id: "t1", contact_email: "" } as any,
      partner: {
        id: "p1",
        name: "Partner Co",
        email: null,
        contact_email: encryptField("contact@partner.example"),
      } as any,
      tenant: { id: "t1", name: "Acme Trading" } as any,
      reviewerName: "Admin",
      baseUrl: "https://velos-platform.vercel.app",
    });

    const statusCall = mockSendEmail.mock.calls.find((c: any[]) => /KYC/i.test(c[0].subject));
    expect(statusCall).toBeDefined();
    expect(statusCall![0].to).toBe("contact@partner.example");
    expect(statusCall![0].to).not.toMatch(/^enc:/);
  });
});

// ---------------------------------------------------------------------------
// 3. Invite route — welcome_email_sent flag flip on success.
// ---------------------------------------------------------------------------
import { POST as invitePost } from "@/app/api/portal-access/[id]/invite/route";

function makeAuth(store: Store) {
  return {
    tenantId: "t1",
    isSuperAdmin: false,
    ip: "203.0.113.7",
    user: { id: "u1", username: "admin", role: "admin", email: "admin@example.com" },
    store,
  };
}

describe("invite route — welcome_email_sent flag (audit15 EMAIL-STATE)", () => {
  it("sets welcome_email_sent: true after a successful send", async () => {
    const upsertPortalAccess = vi.fn(async (p: any) => ({ id: "pa-1", ...p }));
    const store = {
      getPortalAccessById: vi.fn(async () => ({
        id: "pa-1",
        tenant_id: "t1",
        partner_id: "p1",
        tier: "business",
        status: "invited",
        // Long-ago invite: idempotency guard (60s) must NOT block.
        invited_at: new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString(),
        portal_email: encryptField(CLIENT_EMAIL),
        welcome_email_sent: false,
      })),
      upsertPortalAccess,
      getTenant: vi.fn(async () => ({ id: "t1", name: "Acme Trading" })),
      getPartner: vi.fn(async () => ({ id: "p1", name: "Partner Co" })),
      appendAudit: vi.fn(async () => {}),
    } as unknown as Store;
    mockGetStore.mockResolvedValue(store);
    mockRequireAuth.mockResolvedValue(makeAuth(store));

    const req = new NextRequest("http://localhost/api/portal-access/pa-1/invite", { method: "POST" });
    const res = await invitePost(req, { params: Promise.resolve({ id: "pa-1" }) });
    expect(res.status).toBe(200);

    // The send itself went to the decrypted address through the tenant.
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0].to).toBe(CLIENT_EMAIL);
    expect(mockSendEmail.mock.calls[0][0].tenantId).toBe("t1");

    // THE regression: the flag must flip to true now that the send succeeded.
    const flagCall = upsertPortalAccess.mock.calls.find((c: any[]) => c[0].welcome_email_sent === true);
    expect(flagCall).toBeDefined();
  });

  it("does NOT flip the flag when the send fails (admin sees Not sent → can retry)", async () => {
    mockSendEmail.mockResolvedValueOnce({ success: false, error: "Postmark API error 500" });
    const upsertPortalAccess = vi.fn(async (p: any) => ({ id: "pa-1", ...p }));
    const store = {
      getPortalAccessById: vi.fn(async () => ({
        id: "pa-1",
        tenant_id: "t1",
        partner_id: "p1",
        tier: "business",
        status: "invited",
        invited_at: new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString(),
        portal_email: encryptField(CLIENT_EMAIL),
        welcome_email_sent: false,
      })),
      upsertPortalAccess,
      getTenant: vi.fn(async () => ({ id: "t1", name: "Acme Trading" })),
      getPartner: vi.fn(async () => ({ id: "p1", name: "Partner Co" })),
      appendAudit: vi.fn(async () => {}),
    } as unknown as Store;
    mockGetStore.mockResolvedValue(store);
    mockRequireAuth.mockResolvedValue(makeAuth(store));

    const req = new NextRequest("http://localhost/api/portal-access/pa-1/invite", { method: "POST" });
    const res = await invitePost(req, { params: Promise.resolve({ id: "pa-1" }) });
    // Failed send → 500 surfaced to the admin (queued for retry).
    expect(res.status).toBe(500);
    const flagCall = upsertPortalAccess.mock.calls.find((c: any[]) => c[0].welcome_email_sent === true);
    expect(flagCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. reset-password route — confirmation email to the decrypted address,
//    routed through the TENANT's provider.
// ---------------------------------------------------------------------------
import { POST as resetPasswordPost } from "@/app/api/portal/reset-password/route";

describe("portal reset-password — confirmation email (audit15 EMAIL-NOTIF)", () => {
  it("sends a 'reset' confirmation to the decrypted address with tenantId after a successful reset", async () => {
    mockConsumePasswordReset.mockResolvedValue({
      ok: true,
      targetType: "portal_access",
      targetId: "pa-1",
      tenantId: "t1",
    });
    const store = {
      getPortalAccessById: vi.fn(async () => ({
        id: "pa-1",
        tenant_id: "t1",
        portal_email: encryptField(CLIENT_EMAIL),
        token_version: 3,
      })),
      upsertPortalAccess: vi.fn(async (p: any) => p),
      getTenant: vi.fn(async () => ({ id: "t1", name: "Acme Trading" })),
      appendAudit: vi.fn(async () => {}),
    } as unknown as Store;
    mockGetStore.mockResolvedValue(store);

    const req = new NextRequest("http://localhost/api/portal/reset-password", {
      method: "POST",
      body: JSON.stringify({ reset_token: "tok", password: "NewP@ssw0rd123" }),
    });
    const res = await resetPasswordPost(req);
    expect(res.status).toBe(200);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const send = mockSendEmail.mock.calls[0][0];
    // Decrypted address — NOT the enc: ciphertext stored at rest.
    expect(send.to).toBe(CLIENT_EMAIL);
    expect(send.to).not.toMatch(/^enc:/);
    // Per-tenant provider routing.
    expect(send.tenantId).toBe("t1");
    expect(send.subject).toContain("Password reset");
    // The real template is used (body carries the tenant name).
    expect(send.html).toContain("Acme Trading");
    expect(send.html).toContain("reset");
  });

  it("does NOT send a confirmation when the stored address cannot be decrypted", async () => {
    mockConsumePasswordReset.mockResolvedValue({
      ok: true,
      targetType: "portal_access",
      targetId: "pa-1",
      tenantId: "t1",
    });
    const store = {
      getPortalAccessById: vi.fn(async () => ({
        id: "pa-1",
        tenant_id: "t1",
        portal_email: "enc:AAAA:BBBB:CCCC:DDDD",
        token_version: 3,
      })),
      upsertPortalAccess: vi.fn(async (p: any) => p),
      getTenant: vi.fn(async () => ({ id: "t1", name: "Acme Trading" })),
      appendAudit: vi.fn(async () => {}),
    } as unknown as Store;
    mockGetStore.mockResolvedValue(store);

    const req = new NextRequest("http://localhost/api/portal/reset-password", {
      method: "POST",
      body: JSON.stringify({ reset_token: "tok", password: "NewP@ssw0rd123" }),
    });
    const res = await resetPasswordPost(req);
    // The reset itself still succeeds…
    expect(res.status).toBe(200);
    // …only the email is skipped.
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. Admin→client message route — the ciphertext To: bug.
// ---------------------------------------------------------------------------
import { POST as adminMessagePost } from "@/app/api/portal-access/[id]/message/route";

describe("admin message route — encrypted To: address (audit15 EMAIL-ADDR)", () => {
  it("sends the message notification email to the DECRYPTED portal address", async () => {
    const store = {
      getPortalAccessById: vi.fn(async () => ({
        id: "pa-1",
        tenant_id: "t1",
        partner_id: "p1",
        portal_email: encryptField(CLIENT_EMAIL),
      })),
      getTenant: vi.fn(async () => ({ id: "t1", name: "Acme Trading", email: "team@acme.example" })),
      createNotification: vi.fn(async () => {}),
      appendAudit: vi.fn(async () => {}),
    } as unknown as Store;
    mockGetStore.mockResolvedValue(store);
    mockRequireAuth.mockResolvedValue(makeAuth(store));

    const req = new NextRequest("http://localhost/api/portal-access/pa-1/message", {
      method: "POST",
      body: JSON.stringify({ message: "Your invoice is ready.", send_email: true }),
    });
    const res = await adminMessagePost(req, { params: Promise.resolve({ id: "pa-1" }) });
    expect(res.status).toBe(200);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const send = mockSendEmail.mock.calls[0][0];
    // THE regression: this was the enc: ciphertext → provider rejected it.
    expect(send.to).toBe(CLIENT_EMAIL);
    expect(send.to).not.toMatch(/^enc:/);
    // Routed through the tenant's own provider.
    expect(send.tenantId).toBe("t1");
    // The greeting must NOT leak ciphertext either.
    expect(send.html).not.toMatch(/enc:[A-Za-z0-9+/=]{20,}/);
    expect(send.html).toContain(CLIENT_EMAIL);
  });

  it("skips the email (still 200) when the stored address is undecryptable ciphertext", async () => {
    const store = {
      getPortalAccessById: vi.fn(async () => ({
        id: "pa-1",
        tenant_id: "t1",
        partner_id: "p1",
        portal_email: "enc:AAAA:BBBB:CCCC:DDDD",
      })),
      getTenant: vi.fn(async () => ({ id: "t1", name: "Acme Trading", email: "team@acme.example" })),
      createNotification: vi.fn(async () => {}),
      appendAudit: vi.fn(async () => {}),
    } as unknown as Store;
    mockGetStore.mockResolvedValue(store);
    mockRequireAuth.mockResolvedValue(makeAuth(store));

    const req = new NextRequest("http://localhost/api/portal-access/pa-1/message", {
      method: "POST",
      body: JSON.stringify({ message: "Your invoice is ready.", send_email: true }),
    });
    const res = await adminMessagePost(req, { params: Promise.resolve({ id: "pa-1" }) });
    expect(res.status).toBe(200);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. setup-password + portal change-password — confirmation emails.
// ---------------------------------------------------------------------------
const { mockGetPortalSessionAccess, mockCreateSession, mockSetSessionCookie, mockGetSessionFromCookie } = vi.hoisted(() => ({
  mockGetPortalSessionAccess: vi.fn(),
  mockCreateSession: vi.fn(async () => "jwt-token"),
  mockSetSessionCookie: vi.fn(async () => {}),
  mockGetSessionFromCookie: vi.fn(async () => null),
}));

vi.mock("@/lib/auth/portal-session", () => ({
  getPortalSessionAccess: mockGetPortalSessionAccess,
}));

vi.mock("@/lib/auth/session", () => ({
  getSessionFromCookie: mockGetSessionFromCookie,
  createSession: mockCreateSession,
  setSessionCookie: mockSetSessionCookie,
  rotateUserSessions: vi.fn(async () => {}),
}));

import { POST as setupPasswordPost } from "@/app/api/portal/setup-password/route";
import { POST as portalChangePasswordPost } from "@/app/api/portal/change-password/route";

describe("portal setup-password — activation confirmation email (audit15 EMAIL-NOTIF)", () => {
  it("sends a 'setup' confirmation to the decrypted address after first password set", async () => {
    mockConsumePasswordReset.mockResolvedValue({
      ok: true,
      targetType: "portal_access",
      targetId: "pa-1",
      tenantId: "t1",
    });
    const store = {
      getPortalAccessById: vi.fn(async (id: string) => ({
        id,
        tenant_id: "t1",
        partner_id: "p1",
        tier: "business",
        status: "invited",
        must_set_password: true,
        invited_at: new Date().toISOString(),
        token_version: 1,
        portal_email: encryptField(CLIENT_EMAIL),
      })),
      upsertPortalAccess: vi.fn(async (p: any) => ({
        id: "pa-1",
        tenant_id: "t1",
        portal_email: encryptField(CLIENT_EMAIL),
        token_version: 2,
        ...p,
      })),
      getTenant: vi.fn(async () => ({ id: "t1", name: "Acme Trading" })),
      getPartner: vi.fn(async () => ({ id: "p1", name: "Partner Co" })),
      appendAudit: vi.fn(async () => {}),
    } as unknown as Store;
    mockGetStore.mockResolvedValue(store);

    const req = new NextRequest("http://localhost/api/portal/setup-password", {
      method: "POST",
      body: JSON.stringify({ setup_token: "tok", password: "NewP@ssw0rd123" }),
    });
    const res = await setupPasswordPost(req);
    expect(res.status).toBe(200);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const send = mockSendEmail.mock.calls[0][0];
    expect(send.to).toBe(CLIENT_EMAIL);
    expect(send.to).not.toMatch(/^enc:/);
    expect(send.tenantId).toBe("t1");
    expect(send.subject).toContain("account is active");
    expect(send.html).toContain("Acme Trading");
  });
});

describe("portal change-password — change confirmation email (audit15 EMAIL-NOTIF)", () => {
  it("sends a 'change' confirmation with the compromise warning to the decrypted address", async () => {
    mockGetPortalSessionAccess.mockResolvedValue({
      id: "pa-1",
      tenant_id: "t1",
      partner_id: "p1",
      portal_email: encryptField(CLIENT_EMAIL),
      password_hash: "hashed:old",
      token_version: 2,
    });
    const store = {
      upsertPortalAccess: vi.fn(async (p: any) => p),
      getTenant: vi.fn(async () => ({ id: "t1", name: "Acme Trading" })),
      appendAudit: vi.fn(async () => {}),
    } as unknown as Store;
    mockGetStore.mockResolvedValue(store);

    const req = new NextRequest("http://localhost/api/portal/change-password", {
      method: "POST",
      body: JSON.stringify({
        current_password: "OldP@ssw0rd",
        new_password: "NewP@ssw0rd123",
        confirm_password: "NewP@ssw0rd123",
      }),
    });
    const res = await portalChangePasswordPost(req);
    expect(res.status).toBe(200);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const send = mockSendEmail.mock.calls[0][0];
    expect(send.to).toBe(CLIENT_EMAIL);
    expect(send.to).not.toMatch(/^enc:/);
    expect(send.tenantId).toBe("t1");
    expect(send.subject).toContain("Password changed");
    // The security warning is present for kind=change.
    expect(send.html).toContain("did <strong>not</strong> change your password");
  });
});

// ---------------------------------------------------------------------------
// 7. forgot-password — missing-tenant guard (no 500 leak).
// ---------------------------------------------------------------------------
import { POST as forgotPasswordPost } from "@/app/api/portal/forgot-password/route";

describe("portal forgot-password — missing tenant guard (audit15)", () => {
  it("returns the generic 200 when the access row's tenant no longer exists", async () => {
    const store = {
      getPortalAccessByEmailAnyTenant: vi.fn(async () => ({
        id: "pa-1",
        tenant_id: "t-gone",
        portal_email: encryptField(CLIENT_EMAIL),
      })),
      getTenant: vi.fn(async () => null),
    } as unknown as Store;
    mockGetStore.mockResolvedValue(store);

    const req = new NextRequest("http://localhost/api/portal/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email: CLIENT_EMAIL }),
    });
    const res = await forgotPasswordPost(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toContain("If an account exists");
    // No token minted, no email sent.
    expect(mockCreatePasswordReset).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});
