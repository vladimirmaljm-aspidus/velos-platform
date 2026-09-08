/**
 * PORTAL MODULE CATALOG — the single source of truth for module ids,
 * groups and display labels. PURE module: no server-side imports
 * (no NextResponse / getSupabase) so BOTH the server evaluator
 * (module-permissions.ts) and client components (admin editors, portal
 * nav) import it safely.
 */

export interface PortalModuleDef {
  /** Dot-format id used in JSONB overrides / defaults + nav gate. */
  key: string;
  /** True when the module has a legacy portal_access boolean. */
  legacy?: boolean;
  /** Child submodule keys (evaluated independently after the parent). */
  children?: string[];
  /** Group key for the admin editor UI. */
  group: "core" | "documents" | "trading" | "marketplace" | "comms" | "logistics" | "finance";
}

export const PORTAL_MODULES: PortalModuleDef[] = [
  // core
  { key: "dashboard", group: "core" },
  { key: "profile", group: "core" },
  { key: "company", legacy: true, group: "core" },
  // documents
  { key: "documents", legacy: true, group: "documents" },
  { key: "uploads", group: "documents" },
  // trading
  { key: "offers", legacy: true, group: "trading" },
  { key: "invoices", legacy: true, group: "trading" },
  { key: "proformas", group: "trading" },
  { key: "lois", group: "trading" },
  { key: "catalog", legacy: true, group: "trading" },
  { key: "rfq", group: "trading" },
  // marketplace
  {
    key: "marketplace",
    group: "marketplace",
    children: [
      "marketplace.post",
      "marketplace.intelligence",
      "marketplace.community",
      "marketplace.finance",
      "marketplace.esg",
      "marketplace.logistics",
    ],
  },
  // comms
  { key: "messages", group: "comms" },
  { key: "notifications", group: "comms" },
  // logistics
  { key: "logistics", group: "logistics" },
  // finance
  { key: "referrals", group: "finance", children: ["referrals.commissions"] },
];

/** Flat set of every valid module / submodule key. */
export const PORTAL_MODULE_KEYS: Set<string> = new Set(
  PORTAL_MODULES.flatMap((m) => [m.key, ...(m.children ?? [])]),
);

/** Group display keys (i18n) for the admin editors. */
export const PORTAL_MODULE_GROUP_LABEL_KEYS: Record<PortalModuleDef["group"], string> = {
  core: "portal-modules-group-core",
  documents: "portal-modules-group-documents",
  trading: "portal-modules-group-trading",
  marketplace: "portal-modules-group-marketplace",
  comms: "portal-modules-group-comms",
  logistics: "portal-modules-group-logistics",
  finance: "portal-modules-group-finance",
};

/** Module display keys (i18n) — <key with dots → dashes>-label. */
export function portalModuleLabelKey(moduleKey: string): string {
  return `portal-module-${moduleKey.replace(/\./g, "-")}-label`;
}
