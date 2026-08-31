import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// 13-C: route-factory uniformity tests (audit12).
//
// The 7 offer/invoice/proforma/LOI PDF routes were refactored into thin
// wrappers around @/lib/pdf/route-factory. These tests verify the factory's
// canonical pipeline behaviours that the pre-factory copies got wrong or
// inconsistent:
//
//   1. Rate limit fires FIRST — 429 + Retry-After before any auth/store call
//      (the LOI route previously had NO rate limit at all).
//   2. Cookie-session permission gate: requirePermission("invoices.read")
//      denial → 403 with required_permission echo.
//   3. API-key auth path: hasPermission("invoices:read") missing → 403.
//   4. Feature gate: requireFeature("module_finance") denial → 402.
//   5. Success path: doc fetched FIRST → tenant check → generatePdf called
//      with the DOC's tenant_id (super-admin cross-tenant fix) → audit uses
//      the uniform "<docType>.pdf" action → filename is
//      `${tenant}_${LABEL}_${number}_${partner}.pdf` → Content-Type is
//      application/pdf → X-Verification-Code passed through.
//   6. Cross-tenant access by a non-super-admin → 404 (no existence leak).
//   7. ?mode=attachment switches the Content-Disposition.
//   8. Portal factory: no session → 401; can_download_pdf=false → 403
//      BEFORE the doc fetch; createVerification is false (portal never
//      issues verifications); markDocumentViewed fired fire-and-forget.
//
// Mocking:
//   • requireAuthOrApiKey / requirePermission / requireFeature / helpers
//   • generatePdf (the real PDF renderer — we assert on the call args)
//   • store: getInvoice/getOffer/getProforma/getLoi + getPartner + getTenant
//   • audit + rate-limiter (in-memory fake)

const { mockAuth, mockRequirePermission, mockRequireFeature, mockGeneratePdf, mockAudit, mockStore, mockMarkViewed, mockPortalAccess } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequirePermission: vi.fn(() => null),
  mockRequireFeature: vi.fn(async () => null),
  mockGeneratePdf: vi.fn(),
  mockAudit: vi.fn(),
  mockStore: {
    getInvoice: vi.fn(),
    getOffer: vi.fn(),
    getProforma: vi.fn(),
    getLoi: vi.fn(),
    getPartner: vi.fn(),
    getTenant: vi.fn(),
  },
  mockMarkViewed: vi.fn(),
  mockPortalAccess: vi.fn(),
}));

vi.mock("@/lib/api/helpers", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/api/helpers")>();
  return {
    ...orig,
    requireAuthOrApiKey: mockAuth,
    audit: mockAudit,
    getIp: vi.fn(() => "1.2.3.4"),
  };
});

vi.mock("@/lib/permissions/can", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/permissions/can")>();
  return { ...orig, requirePermission: mockRequirePermission };
});

vi.mock("@/lib/api/feature-guard", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/api/feature-guard")>();
  return { ...orig, requireFeature: mockRequireFeature };
});

vi.mock("@/lib/pdf/generator", () => ({
  generatePdf: mockGeneratePdf,
}));

vi.mock("@/lib/data/store", () => ({
  getStore: vi.fn(async () => mockStore),
}));

vi.mock("@/lib/portal/mark-viewed", () => ({
  markDocumentViewed: mockMarkViewed,
}));

vi.mock("@/lib/auth/portal-session", () => ({
  getPortalSessionAccess: mockPortalAccess,
}));

vi.mock("@/lib/portal/kyc-gate", () => ({
  requireKycApproved: vi.fn(async () => null),
}));

vi.mock("@/lib/portal/require-gps", () => ({
  requireGpsVerified: vi.fn(async () => null),
}));

// In-memory rate limiter fake (mirrors the real in-window increment logic).
const buckets = new Map<string, { count: number; start: number }>();
vi.mock("@/lib/security/rate-limiter", () => ({
  checkRateLimit: vi.fn((key: string, max: number, windowMs: number) => {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.start >= windowMs) b = { count: 0, start: now };
    b.count += 1;
    buckets.set(key, b);
    if (b.count > max) {
      return Promise.resolve({ allowed: false, remaining: 0, retryAfter: windowMs, count: b.count });
    }
    return Promise.resolve({ allowed: true, remaining: max - b.count, count: b.count });
  }),
}));

import { makeAdminPdfRoute, makePortalPdfRoute } from "@/lib/pdf/route-factory";

const adminInvoiceRoute = makeAdminPdfRoute({
  docType: "invoice",
  label: "Invoice",
  permission: "invoices",
  apiKeyPermission: "invoices:read",
  feature: "module_finance",
  logTag: "pdf.invoice",
});

const adminLoiRoute = makeAdminPdfRoute({
  docType: "loi",
  label: "LOI",
  permission: "lois",
  apiKeyPermission: "lois:read",
  logTag: "pdf.loi",
});

const portalOfferRoute = makePortalPdfRoute({
  docType: "offer",
  label: "Offer",
  viewedTable: "offers",
  logTag: "portal.offer.pdf",
});

function makeReq(url: string, ip = "9.9.9.9") {
  const req = new NextRequest(new URL(url, "http://localhost"));
  (req as any).headers.set("cf-connecting-ip", ip);
  return req;
}

const cookieAuth = {
  user: { id: "u1", username: "admin", tenant_id: "t1" },
  tenantId: "t1",
  isSuperAdmin: false,
  store: mockStore,
};

const invoiceRow = {
  id: "inv-1",
  number: "INV-2026-0042",
  tenant_id: "t1",
  partner_id: "part-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  buckets.clear();
  mockRequirePermission.mockReturnValue(null);
  mockRequireFeature.mockResolvedValue(null);
  mockAuth.mockResolvedValue(cookieAuth);
  mockGeneratePdf.mockResolvedValue({
    buffer: Buffer.from("%PDF-1.4 fake"),
    verificationCode: "ASP-IV26-0042-ABCDEF",
    pdfHash: "sha256:fake",
    verificationId: "v-1",
  });
  mockStore.getInvoice.mockResolvedValue(invoiceRow);
  mockStore.getLoi.mockResolvedValue({ id: "loi-1", number: "LOI-2026-0001", tenant_id: "t1", partner_id: null });
  mockStore.getOffer.mockResolvedValue({ id: "off-1", number: "OF-2026-0001", tenant_id: "t1", partner_id: "part-1" });
  mockStore.getPartner.mockResolvedValue({ id: "part-1", name: "Buyer Co" });
  mockStore.getTenant.mockResolvedValue({ id: "t1", name: "Aspidus Trading" });
  mockAudit.mockResolvedValue(undefined);
  mockMarkViewed.mockResolvedValue(undefined);
  mockPortalAccess.mockResolvedValue(null);
});

describe("makeAdminPdfRoute (uniform admin PDF pipeline)", () => {
  it("rate-limits 30/min per IP with 429 + Retry-After BEFORE auth", async () => {
    // Unauthenticated: auth returns a 401 NextResponse (like the real helper).
    mockAuth.mockResolvedValue(new (await import("next/server")).NextResponse(
      JSON.stringify({ error: "Not authenticated." }),
      { status: 401 },
    ));
    let res: any;
    for (let i = 0; i < 30; i++) {
      res = await adminInvoiceRoute(makeReq("http://localhost/api/invoices/inv-1/pdf"), { params: Promise.resolve({ id: "inv-1" }) });
      expect(res.status).not.toBe(429);
    }
    res = await adminInvoiceRoute(makeReq("http://localhost/api/invoices/inv-1/pdf"), { params: Promise.resolve({ id: "inv-1" }) });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    // rate limit fired before auth/store
    expect(mockStore.getInvoice).not.toHaveBeenCalled();
  });

  it("LOI route is rate-limited too (regression: was the only un-gated admin PDF route)", async () => {
    mockAuth.mockResolvedValue(new (await import("next/server")).NextResponse(
      JSON.stringify({ error: "Not authenticated." }),
      { status: 401 },
    ));
    for (let i = 0; i < 30; i++) {
      const res = await adminLoiRoute(makeReq("http://localhost/api/lois/loi-1/pdf", "8.8.8.8"), { params: Promise.resolve({ id: "loi-1" }) });
      expect(res.status).not.toBe(429);
    }
    const res = await adminLoiRoute(makeReq("http://localhost/api/lois/loi-1/pdf", "8.8.8.8"), { params: Promise.resolve({ id: "loi-1" }) });
    expect(res.status).toBe(429);
  });

  it("permission denial echoes the required permission (403)", async () => {
    mockRequirePermission.mockReturnValueOnce({ status: 403, body: { error: "Insufficient permissions.", required_permission: "invoices.read" } });
    const res = await adminInvoiceRoute(makeReq("http://localhost/api/invoices/inv-1/pdf"), { params: Promise.resolve({ id: "inv-1" }) });
    expect(res.status).toBe(403);
    expect(mockRequirePermission).toHaveBeenCalledWith(expect.anything(), "invoices.read");
  });

  it("API key without the permission → 403", async () => {
    mockAuth.mockResolvedValue({
      apiKeyId: "key-1",
      apiKeyName: "integration",
      tenantId: "t1",
      permissions: ["offers:read"],
      store: mockStore,
    });
    const res = await adminInvoiceRoute(makeReq("http://localhost/api/invoices/inv-1/pdf"), { params: Promise.resolve({ id: "inv-1" }) });
    expect(res.status).toBe(403);
  });

  it("feature-gate denial short-circuits with the module error", async () => {
    mockRequireFeature.mockResolvedValueOnce({ status: 402, body: { error: "Finance module not enabled." } });
    const res = await adminInvoiceRoute(makeReq("http://localhost/api/invoices/inv-1/pdf"), { params: Promise.resolve({ id: "inv-1" }) });
    expect(res.status).toBe(402);
    expect(mockRequireFeature).toHaveBeenCalledWith("t1", "module_finance", false);
  });

  it("success: generatePdf uses the DOC's tenant, uniform audit action + filename + headers", async () => {
    const res = await adminInvoiceRoute(makeReq("http://localhost/api/invoices/inv-1/pdf"), { params: Promise.resolve({ id: "inv-1" }) });
    expect(res.status).toBe(200);
    expect(mockGeneratePdf).toHaveBeenCalledWith({ docType: "invoice", docId: "inv-1", tenantId: "t1" });
    // uniform audit action "<docType>.pdf" (was "loi.pdf_downloaded" etc.)
    expect(mockAudit).toHaveBeenCalledWith(
      mockStore,
      cookieAuth.user,
      expect.anything(),
      "invoice.pdf",
      "invoice",
      "inv-1",
      expect.objectContaining({ verification_code: "ASP-IV26-0042-ABCDEF" }),
    );
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toContain('filename="Aspidus-Trading_Invoice_INV-2026-0042_Buyer-Co.pdf"');
    expect(res.headers.get("X-Verification-Code")).toBe("ASP-IV26-0042-ABCDEF");
  });

  it("?mode=attachment switches the disposition", async () => {
    const res = await adminInvoiceRoute(makeReq("http://localhost/api/invoices/inv-1/pdf?mode=attachment"), { params: Promise.resolve({ id: "inv-1" }) });
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment;/);
  });

  it("non-super-admin cross-tenant access → 404 (no existence leak)", async () => {
    mockStore.getInvoice.mockResolvedValueOnce({ ...invoiceRow, tenant_id: "t-other" });
    const res = await adminInvoiceRoute(makeReq("http://localhost/api/invoices/inv-1/pdf"), { params: Promise.resolve({ id: "inv-1" }) });
    expect(res.status).toBe(404);
    expect(mockGeneratePdf).not.toHaveBeenCalled();
  });

  it("super-admin CAN download another tenant's doc (doc-derived tenant_id)", async () => {
    mockAuth.mockResolvedValue({ ...cookieAuth, isSuperAdmin: true });
    mockStore.getInvoice.mockResolvedValueOnce({ ...invoiceRow, tenant_id: "t-other" });
    const res = await adminInvoiceRoute(makeReq("http://localhost/api/invoices/inv-1/pdf"), { params: Promise.resolve({ id: "inv-1" }) });
    expect(res.status).toBe(200);
    expect(mockGeneratePdf).toHaveBeenCalledWith({ docType: "invoice", docId: "inv-1", tenantId: "t-other" });
  });

  it("missing doc → 404 before generatePdf", async () => {
    mockStore.getInvoice.mockResolvedValueOnce(null);
    const res = await adminInvoiceRoute(makeReq("http://localhost/api/invoices/inv-1/pdf"), { params: Promise.resolve({ id: "inv-1" }) });
    expect(res.status).toBe(404);
    expect(mockGeneratePdf).not.toHaveBeenCalled();
  });
});

describe("makePortalPdfRoute (uniform portal PDF pipeline)", () => {
  const portalAccess = {
    tenant_id: "t1",
    partner_id: "part-1",
    portal_email: "buyer@buyerco.example",
    can_download_pdf: true,
  };

  it("no portal session → 401 before any store call", async () => {
    mockPortalAccess.mockResolvedValue(null);
    const res = await portalOfferRoute(makeReq("http://localhost/api/portal/offers/off-1/pdf"), { params: Promise.resolve({ id: "off-1" }) });
    expect(res.status).toBe(401);
    expect(mockStore.getOffer).not.toHaveBeenCalled();
  });

  it("tier without PDF downloads → 403 BEFORE the doc fetch (uniform gate order)", async () => {
    mockPortalAccess.mockResolvedValue({ ...portalAccess, can_download_pdf: false });
    const res = await portalOfferRoute(makeReq("http://localhost/api/portal/offers/off-1/pdf"), { params: Promise.resolve({ id: "off-1" }) });
    expect(res.status).toBe(403);
    expect(mockStore.getOffer).not.toHaveBeenCalled();
  });

  it("success: createVerification=false, markViewed fired, mode=attachment supported", async () => {
    mockPortalAccess.mockResolvedValue(portalAccess);
    const res = await portalOfferRoute(makeReq("http://localhost/api/portal/offers/off-1/pdf?mode=attachment"), { params: Promise.resolve({ id: "off-1" }) });
    expect(res.status).toBe(200);
    // portal NEVER issues a new verification
    expect(mockGeneratePdf).toHaveBeenCalledWith(
      expect.objectContaining({ docType: "offer", docId: "off-1", tenantId: "t1", createVerification: false }),
    );
    expect(mockMarkViewed).toHaveBeenCalledWith("offers", "off-1", "t1", "buyer@buyerco.example");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("Content-Disposition")).toContain("Offer-OF-2026-0001.pdf");
  });

  it("foreign partner's doc → 404 (tenant) / 403 (partner mismatch)", async () => {
    mockPortalAccess.mockResolvedValue(portalAccess);
    // tenant mismatch
    mockStore.getOffer.mockResolvedValueOnce({ id: "off-1", number: "X", tenant_id: "t-other", partner_id: "part-1" });
    let res = await portalOfferRoute(makeReq("http://localhost/api/portal/offers/off-1/pdf"), { params: Promise.resolve({ id: "off-1" }) });
    expect(res.status).toBe(404);
    // partner mismatch
    mockStore.getOffer.mockResolvedValueOnce({ id: "off-1", number: "X", tenant_id: "t1", partner_id: "part-999" });
    res = await portalOfferRoute(makeReq("http://localhost/api/portal/offers/off-1/pdf"), { params: Promise.resolve({ id: "off-1" }) });
    expect(res.status).toBe(403);
    expect(mockGeneratePdf).not.toHaveBeenCalled();
  });
});
