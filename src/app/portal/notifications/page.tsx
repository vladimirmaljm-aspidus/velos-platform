import { PortalShell } from "@/components/portal/portal-shell";

export const dynamic = "force-dynamic";

export const metadata = { title: "Portal — Notifications" };

export default function PortalNotificationsPage() {
  return <PortalShell initialView="portal-notifications" />;
}
