import { PortalShell } from "@/components/portal/portal-shell";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Negotiation room — VELOS Portal",
};

/**
 * /portal/marketplace/negotiations/[id] — single negotiation room.
 *
 * The page is a thin server-component wrapper that:
 *   1. Awaits the dynamic `id` route param.
 *   2. Renders `<PortalShell>` with the marketplace-negotiations view
 *      AND `initialSelectedNegotiationId={id}`.
 *
 * PortalShell writes `initialSelectedNegotiationId` into the app-store
 * on mount (same pattern as the marketplace post deep-link prop). The
 * NegotiationsBrowser exported from
 * `src/components/portal/marketplace/negotiation-room.tsx` reads
 * `selectedNegotiationId` from the store and renders the NegotiationRoom
 * for that id in place of the list view.
 */
export default async function PortalMarketplaceNegotiationRoomPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <PortalShell
      initialView="portal-marketplace-negotiations"
      initialSelectedNegotiationId={id}
    />
  );
}
