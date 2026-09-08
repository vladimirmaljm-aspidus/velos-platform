import { describe, it, expect, vi, beforeEach } from "vitest";
import { requireMarketplaceCommunicator } from "@/lib/portal/marketplace-gate";
import type { PortalAccess } from "@/lib/supabase/types";

/**
 * Unit tests for the marketplace communication gate.
 *
 * Policy under test (see src/lib/portal/marketplace-gate.ts):
 *   • tier < standard (basic / legacy limited) → 403 tier_insufficient
 *   • standard/business with unapproved KYC → 403 kyc_required
 *   • standard/business with approved KYC → allowed (null)
 *   • premium → always allowed (no KYC requirement)
 *   • exempt_kyc → allowed for any tier >= standard, regardless of status
 *
 * The KYC half of the gate reads the partner record via the data store,
 * which we mock through the same indirection the gate uses
 * (@/lib/data/store → getStore().getPartner()).
 */

vi.mock("@/lib/data/store", () => ({
  getStore: vi.fn(async () => ({
    getPartner: vi.fn(async () => ({ id: "p1", kyc_status: mockKycStatus })),
  })),
}));

vi.mock("@/lib/supabase/client", () => ({ getSupabase: vi.fn() }));

let mockKycStatus: string | null = "approved";

function makeAccess(overrides: Partial<Record<string, unknown>> = {}): PortalAccess {
  return {
    id: "pa-1",
    tenant_id: "t-1",
    partner_id: "p1",
    tier: "standard",
    exempt_kyc: false,
    ...overrides,
  } as unknown as PortalAccess;
}

beforeEach(() => {
  mockKycStatus = "approved";
});

describe("requireMarketplaceCommunicator", () => {
  it("blocks basic tier with tier_insufficient (read-only observer)", async () => {
    const res = await requireMarketplaceCommunicator(makeAccess({ tier: "basic" }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = await res!.json();
    expect(body.code).toBe("tier_insufficient");
    expect(body.required_tier).toBe("standard");
  });

  it("blocks legacy limited tier identically to basic", async () => {
    const res = await requireMarketplaceCommunicator(makeAccess({ tier: "limited" }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = await res!.json();
    expect(body.code).toBe("tier_insufficient");
  });

  it("allows standard tier with approved KYC", async () => {
    mockKycStatus = "approved";
    const res = await requireMarketplaceCommunicator(makeAccess({ tier: "standard" }));
    expect(res).toBeNull();
  });

  it("allows business tier with approved KYC", async () => {
    mockKycStatus = "approved";
    const res = await requireMarketplaceCommunicator(makeAccess({ tier: "business" }));
    expect(res).toBeNull();
  });

  it("blocks standard tier when KYC is not approved (kyc_required)", async () => {
    mockKycStatus = "pending";
    const res = await requireMarketplaceCommunicator(makeAccess({ tier: "standard" }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = await res!.json();
    expect(body.kyc_required).toBe(true);
    expect(body.kyc_status).toBe("pending");
  });

  it("blocks standard tier when KYC was rejected", async () => {
    mockKycStatus = "rejected";
    const res = await requireMarketplaceCommunicator(makeAccess({ tier: "business" }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("allows premium tier without any KYC approval (premium bypass)", async () => {
    mockKycStatus = "not_submitted";
    const res = await requireMarketplaceCommunicator(makeAccess({ tier: "premium" }));
    expect(res).toBeNull();
  });

  it("allows exempt_kyc standard-tier partner even with unapproved KYC", async () => {
    mockKycStatus = "pending";
    const res = await requireMarketplaceCommunicator(
      makeAccess({ tier: "standard", exempt_kyc: true }),
    );
    expect(res).toBeNull();
  });
});
