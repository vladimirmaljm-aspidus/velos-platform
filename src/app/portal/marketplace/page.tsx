import { PortalShell } from "@/components/portal/portal-shell";

export const dynamic = "force-dynamic";

// Task 2-c — was hardcoded Serbian ("Berza roba — VELOS Portal"); matches
// the English pattern of the sibling portal pages (e.g. "Marketplace
// negotiations — VELOS Portal").
export const metadata = {
  title: "Marketplace — VELOS Portal",
};

export default function PortalMarketplacePage() {
  return <PortalShell initialView="portal-marketplace" />;
}
