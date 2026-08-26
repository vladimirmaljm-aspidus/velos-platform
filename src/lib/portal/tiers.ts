import type { PortalTier } from "@/lib/supabase/types";

/**
 * Centralized metadata + business rules for the 4 portal tiers.
 *
 * The exemption flags (exempt_kyc / exempt_document_upload / exempt_location_share)
 * are also stored on the PortalAccess row itself, but these helpers provide the
 * platform-wide defaults so the admin UI, the portal shell, and the KYC flow
 * all agree on what each tier requires.
 */

export interface TierMeta {
  value: PortalTier;
  label: string;
  description: string;
  /** Tailwind text color class for badges */
  badgeClass: string;
  /** Lucide icon name (resolved by caller) */
  icon: "crown" | "briefcase" | "user" | "user-minus" | "user-x";
  /** Whether KYC full verification is required for this tier */
  requiresKyc: boolean;
  /** Whether document upload (passport, license, etc.) is required */
  requiresDocuments: boolean;
  /** Whether the client must share geolocation on every login */
  requiresLocation: boolean;
  /** Whether the client can download PDFs (offers, invoices, proformas) */
  canDownloadPdf: boolean;
  /** Whether the client can submit RFQs */
  canSubmitRfq: boolean;
  /** Sort order — higher = more privileged */
  order: number;
}

export const TIER_CATALOG: Record<PortalTier, TierMeta> = {
  premium: {
    value: "premium",
    label: "Premium",
    description:
      "VIP client. Light KYC review only — full document verification and geolocation are optional. Full feature access including PDF downloads and RFQ submission.",
    badgeClass: "bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-900/40 dark:text-amber-200 dark:border-amber-700",
    icon: "crown",
    requiresKyc: false,
    requiresDocuments: false,
    requiresLocation: false,
    canDownloadPdf: true,
    canSubmitRfq: true,
    order: 100,
  },
  business: {
    value: "business",
    label: "Business",
    description:
      "Trusted regular client. Full KYC verification, document upload, and geolocation are required. Full feature access.",
    badgeClass: "bg-emerald-100 text-emerald-900 border-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-200 dark:border-emerald-700",
    icon: "briefcase",
    requiresKyc: true,
    requiresDocuments: true,
    requiresLocation: false, // GPS optional — don't block clients
    canDownloadPdf: true,
    canSubmitRfq: true,
    order: 80,
  },
  standard: {
    value: "standard",
    label: "Standard",
    description:
      "Standard client. Full KYC, document upload, and geolocation required. Can view offers/documents/catalog and submit RFQs but cannot download PDFs.",
    badgeClass: "bg-sky-100 text-sky-900 border-sky-300 dark:bg-sky-900/40 dark:text-sky-200 dark:border-sky-700",
    icon: "user",
    requiresKyc: true,
    requiresDocuments: true,
    requiresLocation: false, // GPS optional — don't block clients
    canDownloadPdf: false,
    canSubmitRfq: true,
    order: 60,
  },
  basic: {
    value: "basic",
    label: "Basic",
    description:
      "Entry-level / trial client. Full KYC, document upload, and geolocation required. Read-only access to catalog and own offers — no RFQ submission, no PDF download.",
    badgeClass: "bg-muted text-muted-foreground border-border",
    icon: "user-minus",
    requiresKyc: true,
    requiresDocuments: true,
    requiresLocation: false, // GPS optional — don't block clients
    canDownloadPdf: false,
    canSubmitRfq: false,
    order: 40,
  },
  limited: {
    // Legacy alias — behaves identically to `basic`. New code should never
    // create `limited` rows; this entry exists so old rows render correctly.
    value: "limited",
    label: "Basic (legacy)",
    description:
      "Legacy limited tier — equivalent to Basic. Upgrade to a higher tier for more features.",
    badgeClass: "bg-muted text-muted-foreground border-border",
    icon: "user-x",
    requiresKyc: true,
    requiresDocuments: true,
    requiresLocation: false, // GPS optional — don't block clients
    canDownloadPdf: false,
    canSubmitRfq: false,
    order: 20,
  },
};

/** Normalize a legacy "limited" tier to "basic" for new business logic. */
export function normalizeTier(tier: PortalTier): PortalTier {
  return tier === "limited" ? "basic" : tier;
}

/** Get tier metadata, normalizing legacy values. */
export function getTierMeta(tier: PortalTier): TierMeta {
  return TIER_CATALOG[normalizeTier(tier)];
}

/** Whether a given tier requires geolocation capture at login. */
export function tierRequiresLocation(tier: PortalTier): boolean {
  return getTierMeta(tier).requiresLocation;
}

/** Whether a given tier requires full KYC verification before portal access. */
export function tierRequiresKyc(tier: PortalTier): boolean {
  return getTierMeta(tier).requiresKyc;
}

/** All tiers ordered from most to least privileged. */
export const ORDERED_TIERS: TierMeta[] = Object.values(TIER_CATALOG)
  .filter((t) => t.value !== "limited")
  .sort((a, b) => b.order - a.order);
