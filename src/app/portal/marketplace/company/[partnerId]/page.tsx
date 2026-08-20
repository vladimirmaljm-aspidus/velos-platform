import { PortalShell } from "@/components/portal/portal-shell";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Company profile — VELOS Marketplace",
};

/**
 * /portal/marketplace/company/[partnerId] — public company profile page.
 *
 * Renders PortalShell with `initialView="portal-marketplace-company"` and
 * `initialSelectedId={partnerId}`. The portal-shell's view-router then
 * mounts the lazy-loaded `<CompanyProfile partnerId={selectedId} />`
 * component (Phase 3). The same view key is reused when the user
 * navigates from inside the marketplace browser (e.g. clicks a company
 * name on a post-detail card) so the SPA stays on the same view key
 * without a full route change.
 */
export default async function PortalMarketplaceCompanyPage({
  params,
}: {
  params: Promise<{ partnerId: string }>;
}) {
  const { partnerId } = await params;
  return (
    <PortalShell
      initialView="portal-marketplace-company"
      initialSelectedId={partnerId}
    />
  );
}
