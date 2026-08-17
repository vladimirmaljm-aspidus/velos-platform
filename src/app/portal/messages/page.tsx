import { PortalShell } from "@/components/portal/portal-shell";

export const dynamic = "force-dynamic";

export const metadata = { title: "Portal — Messages" };

export default function PortalMessagesPage() {
  return <PortalShell initialView="portal-messages" />;
}
