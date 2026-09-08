"use client";

import { useAppStore } from "@/lib/store/app-store";
import { getTierMeta, normalizeTier } from "@/lib/portal/tiers";

/**
 * Client-side mirror of the server marketplace-gate policy
 * (src/lib/portal/marketplace-gate.ts). Used to render locked-state UI
 * BEFORE the user wastes effort filling a form the API would 403 — the
 * server gate remains the authoritative safety net.
 *
 * Marketplace access policy:
 *   • VIEWING — every authenticated portal client, any tier.
 *   • COMMUNICATION (post / respond / negotiate / message / bid / review /
 *     Q&A / groups / events) — requires tier >= Standard AND an approved
 *     KYC status, except premium tier or explicit exempt_kyc.
 */
export interface MarketplacePermissions {
  /** Browsing the feed / post details is always allowed for portal users. */
  canBrowse: boolean;
  /** May the client post, respond, negotiate, message, bid, review…? */
  canCommunicate: boolean;
  /** Why communication is locked — null when unlocked. */
  blockReason: "tier" | "kyc" | null;
  /** Normalized tier value of the current portal access. */
  tier: ReturnType<typeof normalizeTier> | null;
  /** Raw partner KYC status string (or null when unknown). */
  kycStatus: string | null;
  /** True while portalAccess is not yet hydrated from the server session. */
  loading: boolean;
}

export function useMarketplacePermissions(): MarketplacePermissions {
  const portalAccess = useAppStore((s) => s.portalAccess);
  const kycStatus = useAppStore((s) => s.partnerKycStatus);

  if (!portalAccess) {
    return {
      canBrowse: true,
      canCommunicate: false,
      blockReason: null, // unknown yet — components should treat as loading
      tier: null,
      kycStatus: kycStatus ?? null,
      loading: true,
    };
  }

  const tier = normalizeTier(portalAccess.tier as Parameters<typeof normalizeTier>[0]);
  const meta = getTierMeta(tier);

  // Tier floor — basic / limited are read-only observers.
  if (meta.order < getTierMeta("standard").order) {
    return {
      canBrowse: true,
      canCommunicate: false,
      blockReason: "tier",
      tier,
      kycStatus: kycStatus ?? null,
      loading: false,
    };
  }

  // KYC approval for every non-premium / non-exempt tier.
  const kycApproved = kycStatus === "approved";
  if (meta.requiresKyc && !portalAccess.exempt_kyc && !kycApproved) {
    return {
      canBrowse: true,
      canCommunicate: false,
      blockReason: "kyc",
      tier,
      kycStatus: kycStatus ?? null,
      loading: false,
    };
  }

  return {
    canBrowse: true,
    canCommunicate: true,
    blockReason: null,
    tier,
    kycStatus: kycStatus ?? null,
    loading: false,
  };
}
