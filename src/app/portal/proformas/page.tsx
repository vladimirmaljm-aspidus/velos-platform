import { PortalShell } from "@/components/portal/portal-shell";

export const dynamic = "force-dynamic";

export const metadata = { title: "Portal — Proformas" };

export default function PortalProformasPage() {
  return <PortalShell initialView="portal-proformas" />;
}
