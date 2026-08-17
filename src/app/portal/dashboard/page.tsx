import { PortalShell } from "@/components/portal/portal-shell";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Portal — Dashboard",
};

export default function PortalDashboardPage() {
  return <PortalShell initialView="portal-dashboard" />;
}
