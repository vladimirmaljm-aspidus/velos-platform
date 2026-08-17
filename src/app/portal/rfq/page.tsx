import { PortalShell } from "@/components/portal/portal-shell";

export const dynamic = "force-dynamic";

export const metadata = { title: "Portal — Request Quote" };

export default function PortalRfqPage() {
  return <PortalShell initialView="portal-rfq" />;
}
