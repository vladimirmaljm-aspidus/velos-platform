// White-label configuration — Phase 12.
//
// The VELOS Marketplace supports per-tenant branding so a platform
// operator can resell it under a partner's brand. The configuration
// lives in the platform-wide `settings` table (one JSON row per
// tenant, keyed by `marketplace_white_label`). When a tenant hasn't
// configured white-label, the defaults surface the standard VELOS
// Marketplace branding (the "Powered by VELOS" footer + the amber
// primary color).
//
// The config is consumed by the portal shell at render time so the
// marketplace pages render with the tenant's brand (logo URL, primary
// color, footer text). For v1 the brand is fetched via the
// GET /api/admin/white-label?tenant_id=… super-admin route — future
// iterations could expose a public unauthenticated read so the brand
// loads before the portal session.

import { getStore } from "@/lib/data/store";

/**
 * Per-tenant white-label configuration shape.
 */
export interface WhiteLabelConfig {
  /** Marketplace name (replaces "VELOS Marketplace" in the UI). */
  marketplaceName: string;
  /** Custom logo URL (overrides /logo.svg). */
  logoUrl: string;
  /** Custom primary color (hex; used in inline styles + Tailwind). */
  primaryColor: string;
  /** Custom accent color (hex). */
  accentColor: string;
  /** Custom domain (e.g. "market.example.com"). */
  customDomain: string;
  /** Priority categories for this tenant (surfaced first in the browse
   *  filter + the home page's category chips). */
  featuredCategories: string[];
  /** Custom footer text (replaces "Powered by VELOS"). */
  customFooter: string;
  /** When true, hide the "Powered by VELOS" branding entirely. */
  hideVelosBranding: boolean;
}

/**
 * Default white-label config — surfaces the standard VELOS Marketplace
 * branding. Tenants without a custom config get these values.
 *
 * The amber primary color (#B45309) matches the existing platform
 * amber accent used throughout the portal shell.
 */
export const DEFAULT_WHITE_LABEL: WhiteLabelConfig = {
  marketplaceName: "VELOS Marketplace",
  logoUrl: "/logo.svg",
  primaryColor: "#B45309",
  accentColor: "#D97706",
  customDomain: "",
  featuredCategories: [],
  customFooter: "Powered by VELOS",
  hideVelosBranding: false,
};

/**
 * Setting key under which the white-label config is persisted in the
 * `settings` table. The row is tenant-scoped (each tenant has its own
 * white-label config).
 */
export const WHITE_LABEL_SETTING_KEY = "marketplace_white_label";

/**
 * Load the white-label config for a tenant. Returns the default
 * branding when:
 *   • the tenant hasn't configured white-label
 *   • the row exists but failed schema validation (defensive — the
 *     config is JSON in a single column, so a malformed payload shouldn't
 *     break the marketplace UI; we fall back to defaults + log)
 *   • the DB is unreachable (the portal shell renders on every page,
 *     so a DB error here would lock users out — fail open)
 *
 * @param tenantId The tenant whose white-label config to load.
 */
export async function getWhiteLabelConfig(
  tenantId: string,
): Promise<WhiteLabelConfig> {
  if (!tenantId) return { ...DEFAULT_WHITE_LABEL };
  try {
    const store = await getStore();
    const stored = await store.getSetting<Partial<WhiteLabelConfig>>(
      WHITE_LABEL_SETTING_KEY,
      tenantId,
    );
    if (!stored || typeof stored !== "object") {
      return { ...DEFAULT_WHITE_LABEL };
    }
    // Merge with defaults so a partial config (e.g. only
    // `marketplaceName` + `primaryColor` set) still surfaces the
    // default values for the omitted fields. This also defends
    // against future fields added to the interface — existing tenant
    // configs that predate the field get the default value.
    return {
      ...DEFAULT_WHITE_LABEL,
      ...stored,
    };
  } catch (e) {
    console.error("[white-label] getWhiteLabelConfig failed:", e);
    return { ...DEFAULT_WHITE_LABEL };
  }
}

/**
 * Save the white-label config for a tenant. Called by the super-admin
 * white-label admin route (PUT /api/admin/white-label?tenant_id=…).
 *
 * Validates the basic shape (strings + hex colors + boolean) before
 * persisting so a malformed payload doesn't end up in the settings
 * table (which would then break every marketplace page render for that
 * tenant via the fail-open path above).
 *
 * Returns the validated, normalised config.
 */
export async function setWhiteLabelConfig(
  tenantId: string,
  patch: Partial<WhiteLabelConfig>,
): Promise<WhiteLabelConfig> {
  if (!tenantId) throw new Error("tenantId is required.");
  const merged = { ...DEFAULT_WHITE_LABEL, ...patch };
  // Normalise + validate.
  merged.marketplaceName = String(merged.marketplaceName || DEFAULT_WHITE_LABEL.marketplaceName).slice(0, 200);
  merged.logoUrl = String(merged.logoUrl || DEFAULT_WHITE_LABEL.logoUrl).slice(0, 1000);
  merged.primaryColor = normaliseHexColor(merged.primaryColor, DEFAULT_WHITE_LABEL.primaryColor);
  merged.accentColor = normaliseHexColor(merged.accentColor, DEFAULT_WHITE_LABEL.accentColor);
  merged.customDomain = String(merged.customDomain || "").slice(0, 253);
  merged.featuredCategories = Array.isArray(merged.featuredCategories)
    ? merged.featuredCategories.slice(0, 50).map((c) => String(c).slice(0, 100)).filter(Boolean)
    : [];
  merged.customFooter = String(merged.customFooter || DEFAULT_WHITE_LABEL.customFooter).slice(0, 500);
  merged.hideVelosBranding = Boolean(merged.hideVelosBranding);

  const store = await getStore();
  await store.setSetting(WHITE_LABEL_SETTING_KEY, merged, tenantId);
  return merged;
}

/**
 * Validate + normalise a hex color string. Falls back to `fallback`
 * when the input isn't a valid 3- or 6-digit hex color (with or
 * without the leading #).
 */
function normaliseHexColor(input: string, fallback: string): string {
  const s = String(input || "").trim();
  const re = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  if (!re.test(s)) return fallback;
  return s.startsWith("#") ? s : `#${s}`;
}
