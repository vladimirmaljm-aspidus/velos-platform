import { PortalShell } from "@/components/portal/portal-shell";

export const dynamic = "force-dynamic";

export const metadata = { title: "Portal — KYC" };

export default function PortalKycPage() {
  return <PortalShell initialView="portal-kyc" />;
}
