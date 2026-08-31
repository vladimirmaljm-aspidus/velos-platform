import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { PortalAccess } from "@/lib/supabase/types";
import type { MarketplaceMessage } from "@/lib/data/marketplace-store";

// 11-B-v2 / 8c-11: route-level tests for
// src/app/api/marketplace/negotiations/[id]/messages/route.ts POST.
//
// Covers the negotiation status-lock pre-check (added by Task 10-A-v2):
// the POST handler fetches the negotiation row's `status` column directly
// AFTER the rate-limit check and BEFORE the body parse; when status is in
// {accepted, rejected, expired, cancelled, signed, closed}, the handler
// short-circuits with 409 "Negotiation is ${status} — no further messages
// can be sent." BEFORE any side effect (notification insert, contact
// reveal, webhook fire) runs.
//
// Covers:
//   1. POST with negotiation.status="pending" → 200 (message inserted).
//   2. POST with negotiation.status="signed" → 409 "Negotiation is signed
//      — no further messages can be sent."
//   3. POST with negotiation.status="cancelled" → 409 same pattern.
//   4. POST with negotiation.status="closed" → 409 same pattern.
//   5. POST with negotiation not found (bad id) → 404.
//
// Mocking strategy:
//   • `@/lib/auth/portal-session` getPortalSessionAccess → returns a fake
//     active PortalAccess so the route's auth gate passes.
//   • `@/lib/security/rate-limiter` checkRateLimit → always allows.
//   • `@/lib/supabase/client` getSupabase → returns a fake supabase client
//     whose `.from().select().eq().maybeSingle()` chain resolves to a
//     `{ data, error }` shaped per the test case. The fake tracks calls so
//     we can assert the route short-circuits before the post-success
//     notification lookup on terminal-status cases.
//   • `@/lib/data/marketplace-store` addNegotiationMessage → returns a
//     fake MarketplaceMessage (the success path's only side effect on the
//     store). Mocked as a spy so we can assert it was NOT called on the
//     409 / 404 failure paths.
//   • `@/lib/notif/helper` notify → no-op (so the post-success notify fan-
//     out doesn't try to hit the Store mock).
//   • `@/lib/data/store` getStore → fake store (only used by
//     triggerWebhooks which we also mock).
//   • `@/lib/webhooks/deliver` triggerWebhooks → no-op.
//   • `@/lib/monitoring/apm` withApm → pass-through.
//   • `@/lib/security/sanitize-input` sanitizeFields → pass-through.
//   • `@/lib/security/sanitize-attachment-url` sanitizeAttachmentUrl →
//     pass-through (returns null when no attachment_url supplied).

const { mockGetPortalSessionAccess, mockCheckRateLimit, mockGetSupabase, mockAddNegotiationMessage, mockNotify, mockGetStore, mockTriggerWebhooks, mockWithApm, mockSanitizeFields, mockSanitizeAttachmentUrl } = vi.hoisted(() => ({
  mockGetPortalSessionAccess: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockGetSupabase: vi.fn(),
  mockAddNegotiationMessage: vi.fn(),
  mockNotify: vi.fn(async () => {}),
  mockGetStore: vi.fn(),
  mockTriggerWebhooks: vi.fn(async () => {}),
  mockWithApm: vi.fn(<T extends (...args: unknown[]) => unknown>(fn: T): T => fn),
  mockSanitizeFields: vi.fn((body: any) => body),
  mockSanitizeAttachmentUrl: vi.fn(() => null),
}));

vi.mock("@/lib/auth/portal-session", () => ({
  getPortalSessionAccess: mockGetPortalSessionAccess,
}));

vi.mock("@/lib/security/rate-limiter", () => ({
  checkRateLimit: mockCheckRateLimit,
  resetRateLimit: vi.fn(async () => {}),
}));

vi.mock("@/lib/supabase/client", () => ({
  getSupabase: mockGetSupabase,
  isSupabaseConfigured: vi.fn(() => true),
}));

vi.mock("@/lib/data/marketplace-store", () => ({
  addNegotiationMessage: mockAddNegotiationMessage,
  listNegotiationMessages: vi.fn(async () => []),
}));

vi.mock("@/lib/notif/helper", () => ({
  notify: mockNotify,
}));

vi.mock("@/lib/data/store", () => ({
  getStore: mockGetStore,
}));

vi.mock("@/lib/webhooks/deliver", () => ({
  triggerWebhooks: mockTriggerWebhooks,
}));

vi.mock("@/lib/monitoring/apm", () => ({
  withApm: mockWithApm,
}));

vi.mock("@/lib/security/sanitize-input", () => ({
  sanitizeFields: mockSanitizeFields,
}));

vi.mock("@/lib/security/sanitize-attachment-url", () => ({
  sanitizeAttachmentUrl: mockSanitizeAttachmentUrl,
}));

import { POST } from "@/app/api/marketplace/negotiations/[id]/messages/route";

// ── Test fixtures ────────────────────────────────────────────────────────

const TENANT_A = "tenant-A";
const TENANT_B = "tenant-B";
const PARTNER_A = "partner-A";
const PARTNER_B = "partner-B";
const ACCESS_PARTNER_ID = PARTNER_A; // caller is partner-A

function makeAccess(): PortalAccess {
  return {
    id: "pa-1",
    partner_id: ACCESS_PARTNER_ID,
    tenant_id: TENANT_A,
    tier: "standard" as any,
    can_view_offers: true,
    can_view_documents: true,
    can_view_catalog: true,
    can_view_invoices: true,
    can_view_profile: true,
    can_view_company_info: true,
    can_submit_rfq: true,
    can_download_pdf: true,
    exempt_kyc: false,
    exempt_document_upload: false,
    exempt_location_share: false,
    status: "active",
    approved_by: null,
    approved_at: null,
    invited_at: null,
    welcome_email_sent: false,
    portal_email: "alice@example.com",
    password_hash: null,
    must_set_password: false,
    last_login_at: null,
    last_login_ip: null,
    last_login_country: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    failed_attempts: 0,
    locked_until: null,
    token_version: 0,
  } as PortalAccess;
}

/** Build a fake supabase client whose `.from("marketplace_negotiations")
 * chain resolves to a row with the given `status`. The first query (the
 * status pre-check) returns the row; the second query (post-success party
 * lookup) also returns the row with the partner/contact_revealed fields.
 *
 * Returns the underlying mock `eq` fn so individual tests can override
 * the returned row for a single call (e.g. to simulate not-found).
 */
function makeFakeSupabase(negRow: Record<string, any> | null) {
  // The supabase chain: sb.from(table).select(cols).eq(col, val).maybeSingle()
  // → Promise<{ data, error }>
  const maybeSingle = vi.fn(async () => ({
    data: negRow,
    error: null,
  }));

  // The post-success lookup uses a SECOND `.from(...).select(...).eq(...)
  // .maybeSingle()` chain — same mock shape, same data. The route handler
  // destructures `{ data: negRow }` from it (no error key read) so it's
  // safe to return the same shape.
  const select = vi.fn(() => ({ eq, maybeSingle }));
  const eq = vi.fn(() => ({ maybeSingle }));
  const from = vi.fn(() => ({ select }));
  const sb = { from };
  return sb;
}

function makeReq(negotiationId: string, body: unknown): NextRequest {
  return new NextRequest(
    new Request(
      `http://localhost/api/marketplace/negotiations/${negotiationId}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  );
}

function makeCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeMessage(): MarketplaceMessage {
  return {
    id: "msg-1",
    negotiation_id: "neg-1",
    sender_partner_id: ACCESS_PARTNER_ID,
    message: "hello",
    message_type: "text",
    offer_data: null,
    attachment_url: null,
    created_at: new Date().toISOString(),
  } as any;
}

describe("POST /api/marketplace/negotiations/[id]/messages (8c-11 status lock)", () => {
  beforeEach(() => {
    mockGetPortalSessionAccess.mockReset();
    mockCheckRateLimit.mockReset();
    mockGetSupabase.mockReset();
    mockAddNegotiationMessage.mockReset();
    mockNotify.mockReset();
    mockGetStore.mockReset();
    mockTriggerWebhooks.mockReset();
    mockSanitizeFields.mockReset();
    mockSanitizeAttachmentUrl.mockReset();

    // Sensible defaults: authed, rate-limit always allows.
    mockGetPortalSessionAccess.mockResolvedValue(makeAccess());
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 20, count: 1 });
    // Pass-through sanitizers.
    mockSanitizeFields.mockImplementation((b: any) => b);
    mockSanitizeAttachmentUrl.mockReturnValue(null);
    // Success-path stubs.
    mockAddNegotiationMessage.mockResolvedValue(makeMessage());
    mockGetStore.mockResolvedValue({} as any);
  });

  // ── 1. status="pending" → 200 (message inserted) ─────────────────────
  it("returns 200 and inserts the message when negotiation.status='pending'", async () => {
    const negRow = {
      id: "neg-1",
      status: "pending",
      tenant_id_a: TENANT_A,
      tenant_id_b: TENANT_B,
      partner_id_a: PARTNER_A,
      partner_id_b: PARTNER_B,
    };
    mockGetSupabase.mockReturnValue(makeFakeSupabase(negRow));

    const res = await POST(makeReq("neg-1", { message: "hello" }), makeCtx("neg-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("msg-1");
    expect(mockAddNegotiationMessage).toHaveBeenCalledTimes(1);
  });

  // ── 2. status="signed" → 409 ─────────────────────────────────────────
  it("returns 409 'Negotiation is signed — no further messages can be sent.' when status='signed'", async () => {
    const negRow = {
      id: "neg-1",
      status: "signed",
      tenant_id_a: TENANT_A,
      tenant_id_b: TENANT_B,
      partner_id_a: PARTNER_A,
      partner_id_b: PARTNER_B,
    };
    mockGetSupabase.mockReturnValue(makeFakeSupabase(negRow));

    const res = await POST(makeReq("neg-1", { message: "hello" }), makeCtx("neg-1"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("Negotiation is signed — no further messages can be sent.");
    // 8c-11: short-circuit BEFORE body parse / store write — assert no
    // side effect fired.
    expect(mockAddNegotiationMessage).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockTriggerWebhooks).not.toHaveBeenCalled();
  });

  // ── 3. status="cancelled" → 409 same pattern ──────────────────────────
  it("returns 409 with the status-specific message when status='cancelled'", async () => {
    const negRow = {
      id: "neg-1",
      status: "cancelled",
      tenant_id_a: TENANT_A,
      tenant_id_b: TENANT_B,
      partner_id_a: PARTNER_A,
      partner_id_b: PARTNER_B,
    };
    mockGetSupabase.mockReturnValue(makeFakeSupabase(negRow));

    const res = await POST(makeReq("neg-1", { message: "hello" }), makeCtx("neg-1"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("Negotiation is cancelled — no further messages can be sent.");
    expect(mockAddNegotiationMessage).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  // ── 4. status="closed" → 409 same pattern ────────────────────────────
  it("returns 409 with the status-specific message when status='closed'", async () => {
    const negRow = {
      id: "neg-1",
      status: "closed",
      tenant_id_a: TENANT_A,
      tenant_id_b: TENANT_B,
      partner_id_a: PARTNER_A,
      partner_id_b: PARTNER_B,
    };
    mockGetSupabase.mockReturnValue(makeFakeSupabase(negRow));

    const res = await POST(makeReq("neg-1", { message: "hello" }), makeCtx("neg-1"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("Negotiation is closed — no further messages can be sent.");
    expect(mockAddNegotiationMessage).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  // ── 5. negotiation not found (bad id) → 404 ──────────────────────────
  it("returns 404 when the negotiation id does not resolve to a row (bad id)", async () => {
    // null negRow → the route's `if (!negRow)` gate fires → 404 "Negotiation
    // not found." (no information leak — same 404 fires for missing / cross-
    // tenant / non-party negotiations).
    mockGetSupabase.mockReturnValue(makeFakeSupabase(null));

    const res = await POST(makeReq("nonexistent-uuid", { message: "hello" }), makeCtx("nonexistent-uuid"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Negotiation not found.");
    expect(mockAddNegotiationMessage).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });
});
