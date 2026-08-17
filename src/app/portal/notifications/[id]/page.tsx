import { PortalShell } from "@/components/portal/portal-shell";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Notification — VELOS Portal",
};

export default function Page() {
  return <PortalShell initialView="portal-notifications" />;
}
