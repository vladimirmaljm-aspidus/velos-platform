import { NextResponse } from "next/server";
import { getStore } from "@/lib/data/store";
import { getTierMeta } from "@/lib/portal/tiers";
import type { PortalAccess } from "@/lib/supabase/types";

/**
 * Server-side KYC gate for portal endpoints.
 *
 * Rules:
 *   - Premium tier or `exempt_kyc = true` → always allowed (bypass).
 *   - All other tiers → the partner's `kyc_status` MUST be "approved" before
 *     the endpoint returns any customer/document data.
 *
 * Returns a 403 NextResponse when the caller should be blocked, or null when
 * the caller may proceed.
 *
 * CRITICAL FIX (audit P1-2): fail-CLOSED on internal errors. Previously the
 * gate returned null (allow) when the DB threw — a transient Supabase blip
 * would let unapproved partners access all portal data. Now a DB error
 * returns 503 (Service Unavailable) so the client can retry, but data is
 * never exposed without verification.
 */
export async function requireKycApproved(access: PortalAccess): Promise<NextResponse | null> {
  const tier = getTierMeta(access.tier);
  if (!tier.requiresKyc || access.exempt_kyc) return null;

  try {
    const store = await getStore();
    const partner = await store.getPartner(access.partner_id);
    if (!partner) {
      return NextResponse.json({ error: "Partner record not found.", kyc_required: true }, { status: 403 });
    }
    if (partner.kyc_status !== "approved") {
      return NextResponse.json(
        {
          error: "KYC verification is required before you can access this data.",
          kyc_required: true,
          kyc_status: partner.kyc_status,
        },
        { status: 403 },
      );
    }
    return null;
  } catch (e) {
    // CRITICAL FIX (audit P1-2): fail-CLOSED. A DB error must NOT allow
    // access to unverified partners. Return 503 so the client can retry.
    console.error("[requireKycApproved] DB error — failing closed:", e);
    return NextResponse.json(
      { error: "Unable to verify KYC status. Please try again.", retry: true },
      { status: 503 },
    );
  }
}
