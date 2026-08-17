import { PortalShell } from "@/components/portal/portal-shell";

export const dynamic = "force-dynamic";

export const metadata = { title: "Portal — Profile" };

export default function PortalProfilePage() {
  return <PortalShell initialView="portal-profile" />;
}
