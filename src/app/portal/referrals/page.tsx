import { PortalShell } from "@/components/portal/portal-shell";

export const dynamic = "force-dynamic";

export const metadata = { title: "Portal — My Commissions" };

export default function PortalReferralsPage() {
  return <PortalShell initialView="portal-referrals" />;
}
