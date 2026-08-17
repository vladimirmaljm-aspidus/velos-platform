import { PortalShell } from "@/components/portal/portal-shell";

export const dynamic = "force-dynamic";

export const metadata = { title: "Portal — Invoices" };

export default function PortalInvoicesPage() {
  return <PortalShell initialView="portal-invoices" />;
}
