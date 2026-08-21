import { PortalShell } from "@/components/portal/portal-shell";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Zajednica — VELOS Marketplace",
};

/**
 * Marketplace Phase 10 — Community hub.
 *
 * Standalone portal route that hands the PortalShell an `initialView` of
 * `portal-marketplace-community`. The view router inside PortalShell
 * loads the CommunityHub (lazy, ssr:false) which itself renders the
 * Groups / Q&A / Events / Blog tabs.
 *
 * Deep-linking is supported: a refresh on this URL rehydrates the
 * PortalShell's view state from sessionStorage (see useHydrateViewState
 * in app-store) so the user stays on the community surface.
 */
export default function PortalMarketplaceCommunityPage() {
  return <PortalShell initialView="portal-marketplace-community" />;
}
