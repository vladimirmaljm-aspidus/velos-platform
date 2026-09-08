import { NextResponse } from "next/server";
import { getTierMeta, normalizeTier } from "@/lib/portal/tiers";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import type { PortalAccess } from "@/lib/supabase/types";

/**
 * Marketplace communication gate.
 *
 * Marketplace access policy (two-layer, fail-closed):
 *
 *   LAYER 1 — VIEWING (any authenticated portal client, any tier):
 *     Browsing the feed, opening post details, viewing verification
 *     badges, reading Q&A and reviews is open to every tier.
 *     ("svi mogu da vide" — everyone can see the listings)
 *
 *   LAYER 2 — COMMUNICATION (this gate):
 *     Posting, responding to posts, opening/continuing negotiations,
 *     sending messages, placing bids, joining groups, registering for
 *     events, writing reviews / Q&A / blog posts requires BOTH:
 *       a) tier >= STANDARD (basic/limited are read-only), AND
 *       b) KYC fully approved (partner.kyc_status === "approved"),
 *          except premium tier or explicit exempt_kyc flag.
 *
 *   ("ne mogu svi da komuniciraju ako nisu odredjenog nivoa")
 *
 * Returns a 403 NextResponse with a machine-readable `code` the client
 * uses to render the exact lock reason (tier vs KYC), or null when the
 * caller may proceed. Delegates the KYC half to requireKycApproved so
 * both gates always stay in sync (incl. its fail-closed 503 behaviour).
 */
export async function requireMarketplaceCommunicator(
  access: PortalAccess,
): Promise<NextResponse | null> {
  const tier = normalizeTier(access.tier);
  const meta = getTierMeta(tier);

  // LAYER 2a — tier floor. basic / limited are read-only observers of the
  // marketplace; they must upgrade to standard or above to communicate.
  if (meta.order < getTierMeta("standard").order) {
    return NextResponse.json(
      {
        error:
          "Marketplace communication requires the Standard tier or higher. Your current tier can browse listings but cannot post, respond, negotiate or bid.",
        code: "tier_insufficient",
        tier,
        required_tier: "standard",
      },
      { status: 403 },
    );
  }

  // LAYER 2b — KYC approval for every non-premium / non-exempt tier.
  const kycBlock = await requireKycApproved(access);
  if (kycBlock) return kycBlock;

  return null;
}

/**
 * Client-facing description of the marketplace communication policy —
 * used by API error payloads and portal UI lock screens so the wording
 * never drifts between server and client.
 */
export const MARKETPLACE_COMMUNICATION_POLICY = {
  minTier: "standard",
  requiresKycApproval: true,
  premiumExempt: true,
} as const;
