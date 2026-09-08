"use client";

import { useQuery } from "@tanstack/react-query";
import { useAppStore } from "@/lib/store/app-store";
import { getTierMeta, normalizeTier } from "@/lib/portal/tiers";
import type { PortalTier } from "@/lib/supabase/types";

/**
 * Client-side mirror of the server marketplace-gate policy
 * (src/lib/portal/marketplace-gate.ts) — the settings-aware 099/100
 * version, not the old hardcoded "standard + KYC" rule. Used to render
 * locked-state UI BEFORE the user wastes effort filling a form the API
 * would 403 — the server gate remains the authoritative safety net.
 *
 * Layers, in the exact order the server evaluates them:
 *
 *   1. MODULE — moduleAccess["marketplace"] from the app-store (resolved
 *      server-side by GET /api/portal/me; null/absent = fail-open, same
 *      as the shell nav filter). Mirrors requirePortalModule(access,
 *      "marketplace") on every marketplace route.
 *
 *   2. TENANT SWITCH — settings.enabled === false → the whole marketplace
 *      module is off for the tenant. Mirrors requireMarketplaceEnabled.
 *
 *   3. POSTING LADDER — the tenant's posting_policy (mirrors
 *      requireMarketplacePoster / requireMarketplaceCommunicator, which
 *      the server deliberately keeps as ONE knob):
 *        all_active          → every active portal client
 *        kyc_verified        → tier >= standard AND KYC approved
 *        tier_standard       → tier >= standard AND KYC approved
 *        tier_business       → tier >= business AND KYC approved
 *        tier_premium        → tier >= premium  AND KYC approved
 *        admins_only         → nobody via the portal (admin-managed only;
 *                              the server 403s EVERY portal client
 *                              regardless of tier, so the client does too)
 *
 *   Viewing (browsing the feed / post details) is open to every
 *   authenticated portal client of any tier, except when the module is
 *   closed or the tenant switch is off (canBrowse then reports false).
 *
 * The tenant policy comes from GET /api/marketplace/settings via
 * useQuery (shared cache key with the create-post wizard). On a settings
 * READ ERROR the hook fails OPEN (enabled / all_active) — the UI must
 * not lock a whole tenant out because one settings read failed; the
 * server still enforces the real policy on every mutation.
 */

/** Why communication/posting is blocked — null when allowed. */
export type MarketplaceBlockReason =
  | "tier"
  | "kyc"
  | "admins_only"
  | "marketplace_disabled"
  | "module"
  | null;

/** The valid posting_policy values (mirrors the DB CHECK). */
export type MarketplacePostingPolicy =
  | "all_active"
  | "kyc_verified"
  | "tier_standard"
  | "tier_business"
  | "tier_premium"
  | "admins_only";

const POSTING_POLICIES = new Set<MarketplacePostingPolicy>([
  "all_active",
  "kyc_verified",
  "tier_standard",
  "tier_business",
  "tier_premium",
  "admins_only",
]);

/**
 * The sanitised tenant policy GET /api/marketplace/settings returns
 * ({ settings: … } — public_feed_enabled is intentionally not exposed).
 */
export interface MarketplacePolicy {
  enabled: boolean;
  posting_policy: MarketplacePostingPolicy;
  require_approval: boolean;
  default_visibility: string;
  allow_private_posts: boolean;
}

interface MarketplaceSettingsResponse {
  settings: MarketplacePolicy;
}

/** Defensive normalisation — unknown posting_policy values fall back to
 *  the DB default (kyc_verified) so the ladder below stays total. */
function normalizePolicy(raw: unknown): MarketplacePolicy | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<MarketplacePolicy>;
  const postingPolicy =
    typeof s.posting_policy === "string" &&
    (POSTING_POLICIES as Set<string>).has(s.posting_policy)
      ? (s.posting_policy as MarketplacePostingPolicy)
      : "kyc_verified";
  return {
    enabled: s.enabled !== false,
    posting_policy: postingPolicy,
    require_approval: s.require_approval === true,
    default_visibility: s.default_visibility === "private" ? "private" : "public",
    allow_private_posts: s.allow_private_posts !== false,
  };
}

/** Fail-open policy used when the settings read fails (never wider than
 *  the spec: enabled + all_active; the server still enforces the truth). */
const FAIL_OPEN_POLICY: MarketplacePolicy = {
  enabled: true,
  posting_policy: "all_active",
  require_approval: false,
  default_visibility: "public",
  allow_private_posts: true,
};

export interface MarketplacePermissions {
  /** Browsing the feed / post details — every tier, unless the module is
   *  closed or the tenant switch is off. */
  canBrowse: boolean;
  /** May the client respond, negotiate, message, bid, review…? */
  canCommunicate: boolean;
  /** May the client create/edit marketplace posts? Same ladder as
   *  canCommunicate today (the server's requireMarketplaceCommunicator
   *  delegates to requireMarketplacePoster) — kept as a separate flag so
   *  the two can diverge when the policy splits. */
  canPost: boolean;
  /** Why communication/posting is locked — null when unlocked. */
  blockReason: MarketplaceBlockReason;
  /** Normalized tier value of the current portal access. */
  tier: PortalTier | null;
  /** Raw partner KYC status string (or null when unknown). */
  kycStatus: string | null;
  /** True while portalAccess is not hydrated or the settings query is
   *  still pending. Components should treat this as "unknown yet". */
  loading: boolean;
  /** The tenant's marketplace policy (normalized settings object), or
   *  null while loading / after a failed settings read. */
  policy: MarketplacePolicy | null;
  /** Whether the tenant requires admin approval for new publications. */
  requiresApproval: boolean;
}

export function useMarketplacePermissions(): MarketplacePermissions {
  const portalAccess = useAppStore((s) => s.portalAccess);
  const kycStatus = useAppStore((s) => s.partnerKycStatus);
  const moduleAccess = useAppStore((s) => s.moduleAccess);

  // Tenant policy — shared cache key ("marketplace-settings") with the
  // create-post wizard, so one request serves every observer.
  const settingsQ = useQuery<MarketplaceSettingsResponse>({
    queryKey: ["marketplace-settings"],
    queryFn: async () => {
      const r = await fetch("/api/marketplace/settings");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    staleTime: 60_000,
    retry: 1,
  });

  const policy =
    settingsQ.isSuccess && !settingsQ.isError
      ? normalizePolicy(settingsQ.data?.settings)
      : null;

  const loading = !portalAccess || settingsQ.isPending;
  if (loading) {
    return {
      canBrowse: true,
      canCommunicate: false,
      canPost: false,
      blockReason: null, // unknown yet — components should treat as loading
      tier: portalAccess
        ? normalizeTier(portalAccess.tier as Parameters<typeof normalizeTier>[0])
        : null,
      kycStatus: kycStatus ?? null,
      loading: true,
      policy,
      requiresApproval: policy?.require_approval ?? false,
    };
  }

  // Layer 1 — module permission (null map = fail-open, per the store's
  // contract; the server evaluator fails open the same way).
  const moduleAllowed = !moduleAccess || moduleAccess["marketplace"] !== false;

  // Layers 0 + 2 — tenant switch + posting ladder. Read failure → the
  // fail-open policy above (the server is the real gate).
  const effective = policy ?? FAIL_OPEN_POLICY;

  let blockReason: MarketplaceBlockReason = null;
  if (!moduleAllowed) {
    blockReason = "module";
  } else if (effective.enabled === false) {
    blockReason = "marketplace_disabled";
  } else {
    const postingPolicy = effective.posting_policy;
    if (postingPolicy === "admins_only") {
      // The server 403s every portal client here — no tier rescues it.
      blockReason = "admins_only";
    } else if (postingPolicy !== "all_active") {
      const tier = normalizeTier(portalAccess.tier as Parameters<typeof normalizeTier>[0]);
      // Tier floor: kyc_verified/tier_standard → standard;
      // tier_business → business; tier_premium → premium.
      const floor =
        postingPolicy === "tier_business"
          ? "business"
          : postingPolicy === "tier_premium"
            ? "premium"
            : "standard";
      if (getTierMeta(tier).order < getTierMeta(floor).order) {
        blockReason = "tier";
      } else if (
        // KYC approval for every non-premium / non-exempt tier — mirrors
        // requireKycApproved (premium tier or exempt_kyc bypasses).
        getTierMeta(tier).requiresKyc &&
        !portalAccess.exempt_kyc &&
        kycStatus !== "approved"
      ) {
        blockReason = "kyc";
      }
    }
  }

  const allowed = blockReason === null;
  return {
    canBrowse: moduleAllowed && effective.enabled !== false,
    canCommunicate: allowed,
    canPost: allowed,
    blockReason,
    tier: normalizeTier(portalAccess.tier as Parameters<typeof normalizeTier>[0]),
    kycStatus: kycStatus ?? null,
    loading: false,
    policy,
    requiresApproval: effective.require_approval === true,
  };
}
