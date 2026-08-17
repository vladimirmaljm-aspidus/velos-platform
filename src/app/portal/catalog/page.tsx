import { PortalShell } from "@/components/portal/portal-shell";

export const dynamic = "force-dynamic";

export const metadata = { title: "Portal — Catalog" };

export default function PortalCatalogPage() {
  return <PortalShell initialView="portal-catalog" />;
}
