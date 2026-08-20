import { PortalShell } from "@/components/portal/portal-shell";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Berza roba — VELOS Portal",
};

export default function PortalMarketplacePage() {
  return <PortalShell initialView="portal-marketplace" />;
}
