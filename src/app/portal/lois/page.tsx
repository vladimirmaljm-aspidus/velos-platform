import { PortalShell } from "@/components/portal/portal-shell";

export const dynamic = "force-dynamic";

export const metadata = { title: "Portal — Letters of Intent" };

export default function PortalLoisPage() {
  return <PortalShell initialView="portal-lois" />;
}
