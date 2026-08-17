import { PortalShell } from "@/components/portal/portal-shell";

export const dynamic = "force-dynamic";

export const metadata = { title: "Portal — Offers" };

export default function PortalOffersPage() {
  return <PortalShell initialView="portal-offers" />;
}
