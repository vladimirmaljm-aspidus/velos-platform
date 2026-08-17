import { PortalShell } from "@/components/portal/portal-shell";

export const dynamic = "force-dynamic";

export const metadata = { title: "Portal — Documents" };

export default function PortalDocumentsPage() {
  return <PortalShell initialView="portal-documents" />;
}
