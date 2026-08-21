import { PortalShell } from "@/components/portal/portal-shell";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Marketplace post — VELOS Portal",
};

export default async function PortalMarketplacePostPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // The MarketplaceBrowser reads `selectedId` from the app store; the
  // detail view renders in place of the list when selectedId is set.
  // `initialSelectedId` is the deep-link hook for /portal/marketplace/[id].
  return <PortalShell initialView="portal-marketplace" initialSelectedId={id} />;
}
