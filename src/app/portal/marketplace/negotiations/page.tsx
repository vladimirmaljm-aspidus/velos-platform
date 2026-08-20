import { PortalShell } from "@/components/portal/portal-shell";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Marketplace negotiations — VELOS Portal",
};

/**
 * /portal/marketplace/negotiations — list the caller's negotiation rooms.
 *
 * The page itself is a thin server-component wrapper around PortalShell
 * (which provides the sidebar / topbar chrome). The actual list UI +
 * SPA-side drill-down into a single room lives in
 * `src/components/portal/marketplace/negotiation-room.tsx` —
 * PortalShell dynamically imports the NegotiationsBrowser from that file
 * and renders it for the `portal-marketplace-negotiations` view.
 *
 * When the user clicks a negotiation row, the list calls
 * `setSelectedNegotiationId(id)` on the app-store; the browser then
 * swaps to the NegotiationRoom view (no URL change, same SPA drill-down
 * pattern the marketplace post list uses).
 */
export default function PortalMarketplaceNegotiationsPage() {
  return <PortalShell initialView="portal-marketplace-negotiations" />;
}
