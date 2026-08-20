import { PortalShell } from "@/components/portal/portal-shell";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Market Intelligence — VELOS Portal",
};

/**
 * /portal/marketplace/intelligence — the Phase 9 market-intelligence
 * dashboard. The route renders the PortalShell with
 * `initialView="portal-marketplace-intelligence"`, which wires up the
 * MarketplaceIntelligenceDashboard as a SPA view (same pattern as the
 * other marketplace sub-routes — the standalone page is just a deep-
 * link target for the SPA view).
 */
export default function PortalMarketplaceIntelligencePage() {
  return <PortalShell initialView="portal-marketplace-intelligence" />;
}
