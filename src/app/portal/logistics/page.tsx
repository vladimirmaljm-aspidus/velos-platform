import { PortalShell } from "@/components/portal/portal-shell";

export const dynamic = "force-dynamic";

export const metadata = { title: "Portal — Logistics" };

export default function PortalLogisticsPage() {
  return <PortalShell initialView="portal-logistics" />;
}
