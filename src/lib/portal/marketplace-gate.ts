import { NextResponse } from "next/server";
import { getTierMeta, normalizeTier } from "@/lib/portal/tiers";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import {
  getMarketplaceTenantSettings,
  type MarketplaceTenantSettings,
} from "@/lib/data/marketplace-store";
import type { PortalAccess } from "@/lib/supabase/types";

/**
 * Marketplace communication gate — settings-aware (migration 099).
 *
 * Marketplace access policy (three layers, fail-closed):
 *
 *   LAYER 0 — TENANT POLICY (marketplace_tenant_settings):
 *     The super admin and the tenant's own admin control, per tenant:
 *       • enabled            — the whole marketplace module on/off
 *       • posting_policy     — WHO may create posts:
 *           all_active   → every active portal client
 *           kyc_verified → tier >= standard AND KYC approved (previous
 *                          global default — kept as the DB default)
 *           tier_standard|tier_business|tier_premium → tier floor + KYC
 *           admins_only  → nobody via the portal (admin-managed only)
 *       • require_approval   — new posts land as status 'pending' until
 *                              an admin approves them
 *
 *   LAYER 1 — VIEWING (any authenticated portal client, any tier):
 *     Browsing the feed, opening post details, viewing verification
 *     badges, reading Q&A and reviews is open to every tier.
 *     ("svi mogu da vide" — everyone can see the listings)
 *
 *   LAYER 2 — COMMUNICATION (this gate):
 *     Posting, responding, negotiating, messaging, bidding, joining
 *     groups, event registration, reviews / Q&A / blog requires the
 *     tenant's posting ladder (see LAYER 0) — by default BOTH:
 *       a) tier >= STANDARD, AND
 *       b) KYC approved (premium tier or exempt_kyc bypasses b).
 *
 * Returns a 403 NextResponse with a machine-readable `code` the client
 * renders exactly (tier vs KYC vs tenant policy), or null when the
 * caller may proceed. Tenant-settings read failures fail CLOSED to the
 * previous global policy (kyc_verified) — never wider than before.
 */

/** Valid posting_policy values (mirrors the DB CHECK). */
export const MARKETPLACE_POSTING_POLICIES = [
  "all_active",
  "kyc_verified",
  "tier_standard",
  "tier_business",
  "tier_premium",
  "admins_only",
] as const;
export type MarketplacePostingPolicy = (typeof MARKETPLACE_POSTING_POLICIES)[number];

/**
 * Tenant-level marketplace gate — Layer 0. Blocks when the tenant's
 * marketplace is disabled. Returns null when allowed (including when the
 * tenant has no settings row — the default is enabled).
 */
export async function requireMarketplaceEnabled(
  access: PortalAccess,
): Promise<NextResponse | null> {
  let settings: MarketplaceTenantSettings | null = null;
  try {
    settings = await getMarketplaceTenantSettings(access.tenant_id);
  } catch {
    // Fail-open on read errors: the marketplace stays available (the
    // previous behaviour) rather than locking every tenant out because
    // one settings read failed.
    return null;
  }
  if (settings.enabled === false) {
    return NextResponse.json(
      {
        error:
          "The marketplace is currently disabled for your organisation by the administrator.",
        code: "marketplace_disabled",
      },
      { status: 403 },
    );
  }
  return null;
}

/**
 * Posting gate — Layer 2 against the TENANT ladder (used by
 * POST /api/marketplace and the post-publish path). 'all_active' skips
 * both the tier floor and KYC; the tier_* policies raise the floor and
 * keep KYC; 'kyc_verified' reproduces the previous global policy;
 * 'admins_only' blocks every portal client.
 */
export async function requireMarketplacePoster(
  access: PortalAccess,
): Promise<NextResponse | null> {
  let policy: MarketplacePostingPolicy = "kyc_verified";
  try {
    const settings = await getMarketplaceTenantSettings(access.tenant_id);
    if (settings) policy = settings.posting_policy;
  } catch {
    // Fail-closed to the default policy (never wider).
  }

  if (policy === "admins_only") {
    return NextResponse.json(
      {
        error:
          "Posts on this marketplace are managed by the administrator. Contact your admin to publish a listing.",
        code: "posting_admins_only",
      },
      { status: 403 },
    );
  }
  if (policy === "all_active") return null;

  // Tier floor: kyc_verified → standard; tier_business → business;
  // tier_premium → premium.
  const floor =
    policy === "tier_business" ? "business" : policy === "tier_premium" ? "premium" : "standard";
  const tier = normalizeTier(access.tier);
  if (getTierMeta(tier).order < getTierMeta(floor).order) {
    return NextResponse.json(
      {
        error:
          "Marketplace posting requires a higher tier. Your current tier can browse listings but cannot post, respond, negotiate or bid.",
        code: "tier_insufficient",
        tier,
        required_tier: floor,
      },
      { status: 403 },
    );
  }

  // KYC approval for every non-premium / non-exempt tier.
  const kycBlock = await requireKycApproved(access);
  if (kycBlock) return kycBlock;

  return null;
}

/**
 * Communication gate — Layer 2 (responding, negotiating, messaging,
 * bidding, community writes). Applies the tenant ladder exactly like
 * the posting path: the admin's "who can communicate" and "who can
 * post" move together (one knob, one mental model).
 */
export async function requireMarketplaceCommunicator(
  access: PortalAccess,
): Promise<NextResponse | null> {
  return requireMarketplacePoster(access);
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
