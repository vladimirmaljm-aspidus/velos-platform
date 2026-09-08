import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { encryptField, hmacField } from "@/lib/crypto/field-encryption";

// 097 — Portal referral commissions contract tests.
//
// Covers the full HTTP contract of the new routes:
//   • GET  /api/portal/referrals            (401, payload shape, draft
//     agreement HIDDEN from the partner, IBAN decrypted for the owner)
//   • POST /api/portal/referrals/agreement  (validation, guards, happy sign)
//   • PUT  /api/portal/referrals/bank-account (IBAN/SWIFT validation,
//     encryption-at-rest + masked + hmac + verification reset)
//   • POST /api/referral-commissions        (validation, auto-calc, notify)
//   • POST /api/referral-commissions/[id]/transition (state-machine guards:
//     approve needs confirmed + signed agreement + complete documents)
//   • POST /api/referral-commissions/[id]/mark-paid (approved-only,
//     reference required)
//
// Everything (auth, store, supabase, notify, permissions) is mocked; the
// REAL field-encryption module is used so the encryption contract is
// actually asserted.

const mockState = vi.hoisted(() => ({
  portalAccess: null as any,
  adminAuth: null as any,
  store: null as any,
}));

vi.mock("@/lib/data/store", () => ({
  getStore: vi.fn(async () => mockState.store),
}));

vi.mock("@/lib/auth/portal-session", () => ({
  getPortalSessionAccess: vi.fn(async () => mockState.portalAccess),
}));

vi.mock("@/lib/api/helpers", () => ({
  requireAuth: vi.fn(async () => mockState.adminAuth),
  resolveTenantId: vi.fn((_auth: any, _req: any) => mockState.adminAuth?.tenantId ?? null),
  audit: vi.fn(async () => {}),
  sanitizeError: vi.fn((e: unknown) => String((e as Error)?.message || e)),
  getIp: vi.fn(() => "203.0.113.10"),
}));

vi.mock("@/lib/notif/helper", () => ({
  notify: vi.fn(async () => {}),
}));

vi.mock("@/lib/permissions/can", () => ({
  requirePermission: vi.fn(() => null),
}));

// Chainable supabase mock for the referral-attachments helper + the
// agreement re-activation reset + payout account ownership lookup.
vi.mock("@/lib/supabase/client", () => {
  const chain: any = {
    eq: vi.fn(() => chain),
    in: vi.fn(() => chain),
    is: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    order: vi.fn(() => chain),
    select: vi.fn(() => chain),
    update: vi.fn(() => chain),
    updateCalls: [] as any[],
  };
  return {
    getSupabase: vi.fn(() => ({
      from: vi.fn(() => chain),
    })),
    isSupabaseConfigured: vi.fn(() => true),
  };
});

// ── Fixtures ───────────────────────────────────────────────────────────────

const TENANT = "tenant-97";
const PARTNER = "partner-97";
const ACCESS_ID = "access-97";

function portalAccess(over: Record<string, unknown> = {}) {
  return {
    id: ACCESS_ID,
    tenant_id: TENANT,
    partner_id: PARTNER,
    portal_email: "ref.test@velos-test.dev",
    status: "active",
    ...over,
  };
}

function commission(over: Record<string, unknown> = {}) {
  return {
    id: "rc-1",
    tenant_id: TENANT,
    partner_id: PARTNER,
    referral_company: "Test Referral GmbH",
    referral_contact: null, referral_email: null, referral_phone: null,
    ref_type: "manual", ref_id: null, ref_number: null,
    product: "Sugar", deal_value: 100000, currency: "USD",
    commission_type: "revenue_percent", commission_rate: 2.5,
    commission_amount: 2500, conditions: null,
    status: "pending",
    deal_done: false, deal_done_at: null,
    documents_complete: false, documents_checked_at: null, documents_checked_by: null,
    approved_by: null, approved_at: null,
    paid_at: null, payout_reference: null, paid_amount: null,
    admin_notes: null, agreement_version: null,
    created_by: null, created_at: "2026-09-07T00:00:00Z", updated_at: "2026-09-07T00:00:00Z",
    ...over,
  };
}

function agreement(over: Record<string, unknown> = {}) {
  return {
    id: "ra-1",
    tenant_id: TENANT,
    partner_id: PARTNER,
    commission_type: "revenue_percent",
    commission_rate: 2.5,
    commission_currency: "USD",
    conditions: null,
    agreement_version: "RA-1.0",
    status: "pending_signature",
    activated_at: "2026-09-07T00:00:00Z",
    signed_at: null, signed_by_name: null, signed_version: null,
    signed_ip: null, signed_user_agent: null, signed_portal_access_id: null,
    created_by: null, created_at: "2026-09-07T00:00:00Z", updated_at: "2026-09-07T00:00:00Z",
    ...over,
  };
}

const PLAIN_IBAN = "DE89370400440532013000";

function makeStore(over: Record<string, any> = {}) {
  return {
    listReferralCommissionsByPartner: vi.fn(async () => [commission()]),
    getReferralAgreementByPartner: vi.fn(async () => null),
    getReferralPayoutAccountByPartner: vi.fn(async () => null),
    getReferralCommission: vi.fn(async () => commission()),
    upsertReferralCommission: vi.fn(async (c: any) => ({ ...commission(), ...c, id: c.id || "rc-new" })),
    transitionReferralCommission: vi.fn(async (id: string, _action: string, patch: any) => commission({ id, status: "confirmed", approved_by: patch?.approved_by ?? null })),
    markReferralCommissionPaid: vi.fn(async (id: string) => commission({ id, status: "paid", paid_at: new Date().toISOString() })),
    upsertReferralAgreement: vi.fn(async (a: any) => ({ ...agreement(), ...a })),
    signReferralAgreement: vi.fn(async (id: string, sig: any) => agreement({ id, status: "signed", signed_at: new Date().toISOString(), ...sig })),
    upsertReferralPayoutAccount: vi.fn(async (a: any) => ({
      id: "rpa-1", status: "submitted", verified_by: null, verified_at: null,
      created_at: "2026-09-07T00:00:00Z", updated_at: "2026-09-07T00:00:00Z",
      ...a,
    })),
    verifyReferralPayoutAccount: vi.fn(async (id: string, p: any) => ({ id, status: p.status, verified_by: p.verified_by, verified_at: new Date().toISOString() })),
    getPartner: vi.fn(async (id: string) => ({ id, tenant_id: TENANT, name: "Partner 97", contact_email: null })),
    appendAudit: vi.fn(async () => ({})),
    ...over,
  };
}

function adminAuth(store: any, over: Record<string, unknown> = {}) {
  return {
    user: { id: "admin-1", username: "admin", tenant_id: TENANT, role: "admin" },
    store,
    ip: "127.0.0.1",
    tenantId: TENANT,
    isSuperAdmin: false,
    ...over,
  };
}

function req(url: string, init: RequestInit = {}) {
  return new NextRequest(`http://localhost${url}`, init);
}

beforeEach(() => {
  vi.resetModules();
  process.env.FIELD_ENCRYPTION_KEY = "ref-test-encryption-key-97";
  mockState.portalAccess = null;
  mockState.adminAuth = null;
  mockState.store = makeStore();
});

// ── GET /api/portal/referrals ──────────────────────────────────────────────

describe("097 portal — GET /api/portal/referrals", () => {
  it("401 without a portal session", async () => {
    mockState.portalAccess = null;
    const { GET } = await import("@/app/api/portal/referrals/route");
    const r = await GET();
    expect(r.status).toBe(401);
  });

  it("returns items + stats + decrypted IBAN for the OWNER; hides DRAFT agreements", async () => {
    mockState.portalAccess = portalAccess();
    const account = {
      id: "rpa-1", tenant_id: TENANT, partner_id: PARTNER,
      beneficiary_name: "Nikola", bank_name: "DB",
      iban_enc: encryptField(PLAIN_IBAN), iban_masked: "DE89 •••• 3000",
      iban_hmac: hmacField(PLAIN_IBAN),
      swift_bic: "DEUTDEFF", account_currency: "EUR", country: "DE",
      additional_instructions: null, status: "verified",
      verified_by: "a", verified_at: "2026-09-07T00:00:00Z",
      created_at: "2026-09-07T00:00:00Z", updated_at: "2026-09-07T00:00:00Z",
    };
    mockState.store = makeStore({
      getReferralAgreementByPartner: vi.fn(async () => agreement({ status: "draft" })),
      getReferralPayoutAccountByPartner: vi.fn(async () => account),
    });
    const { GET } = await import("@/app/api/portal/referrals/route");
    const r = await GET();
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].attachments).toEqual([]);
    expect(body.agreement).toBeNull(); // draft hidden from the partner
    expect(body.payout_account.iban).toBe(PLAIN_IBAN); // owner sees full
    expect(body.payout_account.iban_enc).toBeUndefined(); // ciphertext never leaves
    expect(body.stats.total_commission).toBe(2500);
    expect(body.stats.paid_commission).toBe(0);
  });
});

// ── POST /api/portal/referrals/agreement ───────────────────────────────────

describe("097 portal — POST /api/portal/referrals/agreement (sign)", () => {
  it("401 without a session; 400 short name; 400 without consent", async () => {
    const { POST } = await import("@/app/api/portal/referrals/agreement/route");
    mockState.portalAccess = null;
    expect((await POST(req("/x"))).status).toBe(401);
    mockState.portalAccess = portalAccess();
    const short = await POST(req("/x", { method: "POST", body: JSON.stringify({ typed_name: "ab", consent: true }) }));
    expect(short.status).toBe(400);
    const noConsent = await POST(req("/x", { method: "POST", body: JSON.stringify({ typed_name: "Nikola Petrovic", consent: false }) }));
    expect(noConsent.status).toBe(400);
  });

  it("404 without an agreement; 409 when already signed or not pending", async () => {
    mockState.portalAccess = portalAccess();
    mockState.store = makeStore({ getReferralAgreementByPartner: vi.fn(async () => null) });
    const { POST } = await import("@/app/api/portal/referrals/agreement/route");
    expect((await POST(req("/x", { method: "POST", body: JSON.stringify({ typed_name: "Nikola Petrovic", consent: true }) }))).status).toBe(404);
    mockState.store = makeStore({ getReferralAgreementByPartner: vi.fn(async () => agreement({ status: "signed", signed_at: "2026-09-07T00:00:00Z" })) });
    expect((await POST(req("/x", { method: "POST", body: JSON.stringify({ typed_name: "Nikola Petrovic", consent: true }) }))).status).toBe(409);
    mockState.store = makeStore({ getReferralAgreementByPartner: vi.fn(async () => agreement({ status: "suspended" })) });
    expect((await POST(req("/x", { method: "POST", body: JSON.stringify({ typed_name: "Nikola Petrovic", consent: true }) }))).status).toBe(409);
  });

  it("signs the agreement (atomic store call pinned to the version)", async () => {
    mockState.portalAccess = portalAccess();
    const store = makeStore({ getReferralAgreementByPartner: vi.fn(async () => agreement({ status: "pending_signature" })) });
    mockState.store = store;
    const { POST } = await import("@/app/api/portal/referrals/agreement/route");
    const r = await POST(req("/x", {
      method: "POST",
      headers: { "user-agent": "vitest-agent" },
      body: JSON.stringify({ typed_name: "Nikola Petrovic", consent: true }),
    }));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.agreement.status).toBe("signed");
    expect(store.signReferralAgreement).toHaveBeenCalledWith("ra-1", expect.objectContaining({
      signed_by_name: "Nikola Petrovic",
      signed_version: "RA-1.0",
      signed_ip: "203.0.113.10",
      signed_user_agent: "vitest-agent",
      signed_portal_access_id: ACCESS_ID,
    }));
  });
});

// ── PUT /api/portal/referrals/bank-account ─────────────────────────────────

describe("097 portal — PUT /api/portal/referrals/bank-account", () => {
  it("rejects malformed IBAN and SWIFT", async () => {
    mockState.portalAccess = portalAccess();
    const { PUT } = await import("@/app/api/portal/referrals/bank-account/route");
    const badIban = await PUT(req("/x", { method: "PUT", body: JSON.stringify({ beneficiary_name: "Nikola", iban: "NOTANIBAN" }) }));
    expect(badIban.status).toBe(400);
    const badSwift = await PUT(req("/x", { method: "PUT", body: JSON.stringify({ beneficiary_name: "Nikola", iban: PLAIN_IBAN, swift_bic: "TOOLONGFORBIC12" }) }));
    expect(badSwift.status).toBe(400);
  });

  it("stores the IBAN ENCRYPTED with masked + hmac and re-submits for verification", async () => {
    mockState.portalAccess = portalAccess();
    const store = makeStore();
    mockState.store = store;
    const { PUT } = await import("@/app/api/portal/referrals/bank-account/route");
    const r = await PUT(req("/x", {
      method: "PUT",
      body: JSON.stringify({
        beneficiary_name: "Nikola Petrovic",
        iban: "DE89 3704 0044 0532 0130 00",
        swift_bic: "DEUTDEFF",
        account_currency: "eur",
        country: "Germany",
      }),
    }));
    expect(r.status).toBe(200);
    const arg = store.upsertReferralPayoutAccount.mock.calls[0][0];
    expect(arg.iban_enc).toMatch(/^enc:/); // encrypted at rest
    expect(arg.iban_enc).not.toContain(PLAIN_IBAN);
    expect(arg.iban_masked).toContain("••••");
    expect(arg.iban_hmac).toBeTruthy();
    expect(arg.status).toBe("submitted"); // verification reset
    expect(arg.account_currency).toBe("EUR"); // normalised
    const body = await r.json();
    expect(body.payout_account.iban).toBe(PLAIN_IBAN); // owner sees full
  });
});

// ── POST /api/referral-commissions (admin create) ─────────────────────────

describe("097 admin — POST /api/referral-commissions", () => {
  it("validates partner + company; auto-calculates the amount", async () => {
    const store = makeStore();
    mockState.adminAuth = adminAuth(store);
    const { POST } = await import("@/app/api/referral-commissions/route");

    const noPartner = await POST(req("/x", { method: "POST", body: JSON.stringify({ referral_company: "X Company" }) }));
    expect(noPartner.status).toBe(400);
    const noCompany = await POST(req("/x", { method: "POST", body: JSON.stringify({ partner_id: PARTNER }) }));
    expect(noCompany.status).toBe(400);

    const r = await POST(req("/x", {
      method: "POST",
      body: JSON.stringify({
        partner_id: PARTNER,
        referral_company: "Test Referral GmbH",
        referral_contact: "Herr Test",
        product: "Refined Sugar ICUMSA 45",
        deal_value: 100000,
        currency: "USD",
        commission_type: "revenue_percent",
        commission_rate: 2.5,
      }),
    }));
    expect(r.status).toBe(201);
    const arg = store.upsertReferralCommission.mock.calls[0][0];
    expect(arg.commission_amount).toBe(2500); // auto-calc 100000 × 2.5%
    expect(arg.status).toBeUndefined(); // the store owns lifecycle fields
    // REGRESSION (product-column drop): sanitizePayload's JOIN_KEYS strips
    // any key named "product" — referral_commissions has a REAL product
    // text column. The store must pass it through.
    expect(arg.product).toBe("Refined Sugar ICUMSA 45");
  });
});

// ── POST /api/referral-commissions/[id]/transition (guards) ────────────────

describe("097 admin — transition state-machine guards", () => {
  async function callTransition(store: any, action: string) {
    mockState.adminAuth = adminAuth(store);
    const { POST } = await import("@/app/api/referral-commissions/[id]/transition/route");
    return POST(req("/x", { method: "POST", body: JSON.stringify({ action }) }), { params: Promise.resolve({ id: "rc-1" }) });
  }

  it("approve is refused before confirm", async () => {
    mockState.store = makeStore({ getReferralCommission: vi.fn(async () => commission({ status: "pending" })) });
    const r = await callTransition(mockState.store, "approve");
    expect(r.status).toBe(409);
  });

  it("approve is refused without a SIGNED agreement", async () => {
    mockState.store = makeStore({
      getReferralCommission: vi.fn(async () => commission({ status: "confirmed", documents_complete: true })),
      getReferralAgreementByPartner: vi.fn(async () => agreement({ status: "pending_signature" })),
    });
    const r = await callTransition(mockState.store, "approve");
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.error.toLowerCase()).toContain("sign");
  });

  it("approve is refused with incomplete documents", async () => {
    mockState.store = makeStore({
      getReferralCommission: vi.fn(async () => commission({ status: "confirmed", documents_complete: false })),
      getReferralAgreementByPartner: vi.fn(async () => agreement({ status: "signed", signed_at: "2026-09-07T00:00:00Z" })),
    });
    const r = await callTransition(mockState.store, "approve");
    expect(r.status).toBe(409);
    expect((await r.json()).error.toLowerCase()).toContain("document");
  });

  it("approve succeeds with all gates met", async () => {
    const store = makeStore({
      getReferralCommission: vi.fn(async () => commission({ status: "confirmed", documents_complete: true })),
      getReferralAgreementByPartner: vi.fn(async () => agreement({ status: "signed", signed_at: "2026-09-07T00:00:00Z" })),
    });
    const r = await callTransition(store, "approve");
    expect(r.status).toBe(200);
    expect(store.transitionReferralCommission).toHaveBeenCalledWith("rc-1", "approve", expect.any(Object));
  });

  it("confirm works from pending; invalid action is 400", async () => {
    const store = makeStore();
    const ok = await callTransition(store, "confirm");
    expect(ok.status).toBe(200);
    mockState.store = makeStore();
    const bad = await callTransition(makeStore(), "explode");
    expect(bad.status).toBe(400);
  });
});

// ── POST /api/referral-commissions/[id]/mark-paid ──────────────────────────

describe("097 admin — mark-paid guards", () => {
  async function callPaid(store: any, body: Record<string, unknown>) {
    mockState.adminAuth = adminAuth(store);
    const { POST } = await import("@/app/api/referral-commissions/[id]/mark-paid/route");
    return POST(req("/x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "rc-1" }) });
  }

  it("refused before approval; reference required", async () => {
    const approved = makeStore({ getReferralCommission: vi.fn(async () => commission({ status: "approved" })) });
    const noRef = await callPaid(approved, {});
    expect(noRef.status).toBe(400);
    const notApproved = await callPaid(makeStore(), { payout_reference: "TRX-1" });
    expect(notApproved.status).toBe(409);
  });

  it("happy path records amount + reference", async () => {
    const store = makeStore({ getReferralCommission: vi.fn(async () => commission({ status: "approved" })) });
    const r = await callPaid(store, { payout_reference: "TRX-2026-1", paid_amount: 2500 });
    expect(r.status).toBe(200);
    expect(store.markReferralCommissionPaid).toHaveBeenCalledWith("rc-1", { payout_reference: "TRX-2026-1", paid_amount: 2500 });
  });
});

// ── PUT /api/referral-commissions/agreements (activate / re-sign) ─────────

describe("097 admin — agreement activate + re-sign version bump", () => {
  it("activate creates pending_signature with version RA-1.0 and notifies", async () => {
    const store = makeStore({ getReferralAgreementByPartner: vi.fn(async () => null) });
    mockState.adminAuth = adminAuth(store);
    const { PUT } = await import("@/app/api/referral-commissions/agreements/route");
    const r = await PUT(req("/x", {
      method: "PUT",
      body: JSON.stringify({ partner_id: PARTNER, commission_type: "revenue_percent", commission_rate: 3, activate: true }),
    }));
    expect(r.status).toBe(200);
    const arg = store.upsertReferralAgreement.mock.calls[0][0];
    expect(arg.status).toBe("pending_signature");
    expect(arg.agreement_version).toBe("RA-1.0");
    expect(arg.activated_at).toBeTruthy();
  });

  it("re-activation after a signature bumps the version (RA-1.0 → RA-1.1)", async () => {
    const store = makeStore({
      getReferralAgreementByPartner: vi.fn(async () => agreement({ status: "signed", signed_at: "2026-09-07T00:00:00Z", agreement_version: "RA-1.0" })),
    });
    mockState.adminAuth = adminAuth(store);
    const { PUT } = await import("@/app/api/referral-commissions/agreements/route");
    const r = await PUT(req("/x", {
      method: "PUT",
      body: JSON.stringify({ partner_id: PARTNER, commission_type: "revenue_percent", commission_rate: 4, activate: true }),
    }));
    expect(r.status).toBe(200);
    const arg = store.upsertReferralAgreement.mock.calls[0][0];
    expect(arg.agreement_version).toBe("RA-1.1");
    expect(arg.status).toBe("pending_signature");
  });
});

// ── 46-b: GET /api/referral-commissions/[id] — linked-entity enrichment ────

describe("46-b admin — GET /api/referral-commissions/[id] linked_entity", () => {
  const DEAL_ID = "deal-46";

  function dealFixture(over: Record<string, unknown> = {}) {
    return {
      id: DEAL_ID, tenant_id: TENANT, title: "Sugar shipment to Hamburg",
      partner_id: PARTNER, owner_id: null, stage: "won", value: 100000,
      currency: "USD", expected_close: "2026-12-01", probability: 90,
      description: null, lost_reason: null, commission_agent_id: null,
      buy_cost: 0, quantity: 0, unit: "MT",
      created_at: "2026-09-07T00:00:00Z", updated_at: "2026-09-07T00:00:00Z",
      ...over,
    };
  }

  async function callGet(store: any) {
    mockState.adminAuth = adminAuth(store);
    const { GET } = await import("@/app/api/referral-commissions/[id]/route");
    return GET(req("/x"), { params: Promise.resolve({ id: "rc-1" }) });
  }

  it("resolves the linked deal into a live linked_entity card", async () => {
    const store = makeStore({
      getReferralCommission: vi.fn(async () => commission({ ref_type: "deal", ref_id: DEAL_ID })),
      getDeal: vi.fn(async () => dealFixture()),
      getPartner: vi.fn(async (id: string) => ({ id, tenant_id: TENANT, name: "Mediterra Handels GmbH", contact_email: null })),
    });
    const r = await callGet(store);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.linked_entity).toMatchObject({
      kind: "deal",
      label: "Sugar shipment to Hamburg",
      status: "won",
      partner_name: "Mediterra Handels GmbH",
      value: 100000,
      currency: "USD",
    });
    // falls back to the live resolver's date fields
    expect(body.linked_entity.date).toBe("2026-12-01");
  });

  it("linked_entity is null for a manual entry without ref_id", async () => {
    const r = await callGet(makeStore()); // fixture: ref_type manual, ref_id null
    expect(r.status).toBe(200);
    expect((await r.json()).linked_entity).toBeNull();
  });

  it("a throwing store getter degrades to linked_entity null (no 500)", async () => {
    const store = makeStore({
      getReferralCommission: vi.fn(async () => commission({ ref_type: "deal", ref_id: DEAL_ID })),
      getDeal: vi.fn(async () => { throw new Error("store unavailable"); }),
    });
    const r = await callGet(store);
    expect(r.status).toBe(200);
    expect((await r.json()).linked_entity).toBeNull();
  });

  it("a cross-tenant linked record is NOT resolved", async () => {
    const store = makeStore({
      getReferralCommission: vi.fn(async () => commission({ ref_type: "deal", ref_id: DEAL_ID })),
      getDeal: vi.fn(async () => dealFixture({ tenant_id: "tenant-other" })),
    });
    const r = await callGet(store);
    expect(r.status).toBe(200);
    expect((await r.json()).linked_entity).toBeNull();
  });
});

// ── 46-b: PUT /api/referral-commissions/[id] — ref link + field diff ───────

describe("46-b admin — PUT /api/referral-commissions/[id] ref changes + diff", () => {
  async function callPut(store: any, body: Record<string, unknown>) {
    mockState.adminAuth = adminAuth(store);
    const { PUT } = await import("@/app/api/referral-commissions/[id]/route");
    return PUT(req("/x", { method: "PUT", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "rc-1" }) });
  }

  /** details of the LAST audit() call recorded by the mocked helpers module. */
  async function lastAuditDetails(): Promise<any> {
    const { audit } = await import("@/lib/api/helpers");
    const calls = (audit as any).mock.calls;
    const last = calls[calls.length - 1];
    return last ? last[6] : undefined; // (store, user, req, action, entityType, entityId, details)
  }

  it("ref changes are asserted against the linked entity (404 missing / cross-tenant)", async () => {
    const missing = makeStore({
      getReferralCommission: vi.fn(async () => commission({ ref_type: "offer" })),
      getOffer: vi.fn(async () => null),
    });
    const r = await callPut(missing, { ref_type: "offer", ref_id: "offer-x" });
    expect(r.status).toBe(404);
    expect(missing.getOffer).toHaveBeenCalledWith("offer-x"); // assertRefEntity ran
    expect(missing.upsertReferralCommission).not.toHaveBeenCalled();

    const cross = makeStore({
      getReferralCommission: vi.fn(async () => commission({ ref_type: "offer" })),
      getOffer: vi.fn(async () => ({ id: "offer-x", tenant_id: "tenant-other" })),
    });
    expect((await callPut(cross, { ref_type: "offer", ref_id: "offer-x" })).status).toBe(404);
    expect(cross.upsertReferralCommission).not.toHaveBeenCalled();
  });

  it("persists a valid ref link and logs the field-level old→new diff", async () => {
    const store = makeStore({
      getReferralCommission: vi.fn(async () => commission({ ref_type: "manual", ref_id: null, ref_number: null })),
      getOffer: vi.fn(async () => ({ id: "offer-46", tenant_id: TENANT, number: "OFF-2026-0014", partner_id: PARTNER, status: "sent" })),
    });
    const r = await callPut(store, { ref_type: "offer", ref_id: "offer-46", ref_number: "OFF-2026-0014" });
    expect(r.status).toBe(200);
    const arg = store.upsertReferralCommission.mock.calls[0][0];
    expect(arg.ref_type).toBe("offer");
    expect(arg.ref_id).toBe("offer-46"); // persisted — a REAL record link now
    expect(arg.ref_number).toBe("OFF-2026-0014");
    const details = await lastAuditDetails();
    expect(details.fields).toContain("ref_id");
    expect(details.changes).toEqual(expect.arrayContaining([
      { field: "ref_type", from: "manual", to: "offer" },
      { field: "ref_id", from: "—", to: "offer-46" },
      { field: "ref_number", from: "—", to: "OFF-2026-0014" },
    ]));
  });

  it("diffs amount 100 → 250; unchanged values produce no changes entry", async () => {
    const same = makeStore({
      getReferralCommission: vi.fn(async () => commission({ commission_amount: 250 })),
    });
    expect((await callPut(same, { commission_amount: 250 })).status).toBe(200);
    expect((await lastAuditDetails()).changes).toBeUndefined();

    const changed = makeStore({
      getReferralCommission: vi.fn(async () => commission({ commission_amount: 100 })),
    });
    expect((await callPut(changed, { commission_amount: 250 })).status).toBe(200);
    expect((await lastAuditDetails()).changes).toEqual([
      { field: "commission_amount", from: "100", to: "250" },
    ]);
  });

  it("renders null → string as — → value in the diff", async () => {
    const store = makeStore({
      getReferralCommission: vi.fn(async () => commission({ admin_notes: null })),
    });
    expect((await callPut(store, { admin_notes: "Checked by phone" })).status).toBe(200);
    expect((await lastAuditDetails()).changes).toEqual([
      { field: "admin_notes", from: "—", to: "Checked by phone" },
    ]);
  });

  it("switching ref_type to manual forces ref_id null in the patch", async () => {
    const store = makeStore({
      getReferralCommission: vi.fn(async () => commission({ ref_type: "deal", ref_id: "deal-46" })),
    });
    const r = await callPut(store, { ref_type: "manual" });
    expect(r.status).toBe(200);
    const arg = store.upsertReferralCommission.mock.calls[0][0];
    expect(arg.ref_type).toBe("manual");
    expect(arg.ref_id).toBeNull(); // the dangling link was severed
    const details = await lastAuditDetails();
    expect(details.changes).toEqual(expect.arrayContaining([
      { field: "ref_type", from: "deal", to: "manual" },
      { field: "ref_id", from: "deal-46", to: "—" },
    ]));
  });
});
