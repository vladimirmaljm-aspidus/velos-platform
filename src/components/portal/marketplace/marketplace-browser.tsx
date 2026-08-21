"use client";

import { useEffect, useState } from "react";
import { useAppStore } from "@/lib/store/app-store";
import { useSearchParams } from "next/navigation";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Store, Package, Inbox, Send } from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { MarketplaceList } from "./marketplace-list";
import { MarketplaceCreatePost } from "./marketplace-create-post";
import { MarketplaceMyPosts } from "./marketplace-my-posts";
import { MarketplaceResponses } from "./marketplace-responses";
import { MarketplacePostDetail } from "./marketplace-post-detail";

/**
 * MarketplaceBrowser — the portal-shell view that ties together the
 * marketplace's six Phase-1 components (list, detail, create, my-posts,
 * received/sent responses). Rendered inside PortalShell when the active
 * view is `portal-marketplace`.
 *
 * Routing:
 *   • `/portal/marketplace`            → list tab, no detail
 *   • `/portal/marketplace?create=1`   → list tab + create dialog open
 *   • `/portal/marketplace/[id]`       → detail view of that post
 *
 * The `[id]` page passes `initialSelectedId` to PortalShell which writes
 * it into the app-store; this component reads `selectedId` from the
 * store. When the user clicks a card, the list calls
 * `setSelectedId(id)` to drill into the detail (no URL change — same SPA
 * drill-down pattern as partner-360). The back button in the detail view
 * calls `setSelectedId(null)`.
 */
export function MarketplaceBrowser() {
  const t = useT();
  const selectedId = useAppStore((s) => s.selectedId);
  const setSelectedId = useAppStore((s) => s.setSelectedId);
  const sp = useSearchParams();
  const [tab, setTab] = useState<"browse" | "my-posts" | "responses">("browse");
  const [createOpen, setCreateOpen] = useState(false);

  // Auto-open the create dialog when arriving via `?create=1` (e.g. the
  // "+ Create post" button in MarketplaceMyPosts redirects here).
  useEffect(() => {
    if (sp?.get("create") === "1") {
// eslint-disable-next-line react-hooks/set-state-in-effect
      setCreateOpen(true);
      setTab("browse");
    }
  }, [sp]);

  // If a post id is selected, render the detail view (regardless of tab).
  if (selectedId) {
    return <MarketplacePostDetail postId={selectedId} />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Store className="h-6 w-6" />
          {t("marketplace-title")}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {t("marketplace-subtitle")}
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="browse" className="gap-1">
            <Package className="h-3.5 w-3.5" />
            {t("marketplace-browse")}
          </TabsTrigger>
          <TabsTrigger value="my-posts" className="gap-1">
            <Store className="h-3.5 w-3.5" />
            {t("marketplace-my-posts")}
          </TabsTrigger>
          <TabsTrigger value="responses" className="gap-1">
            <Inbox className="h-3.5 w-3.5" />
            {t("marketplace-responses-title")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="browse" className="mt-4">
          <MarketplaceList onCreateClick={() => setCreateOpen(true)} />
        </TabsContent>

        <TabsContent value="my-posts" className="mt-4">
          <MarketplaceMyPosts onCreateClick={() => { setTab("browse"); setCreateOpen(true); }} />
        </TabsContent>

        <TabsContent value="responses" className="mt-4">
          <MarketplaceResponses />
        </TabsContent>
      </Tabs>

      <MarketplaceCreatePost open={createOpen} onOpenChange={setCreateOpen} />

      {/* Unused import placeholder so the Send icon stays in the bundle
          for future tab additions. */}
      <span className="hidden"><Send /></span>
    </div>
  );
}
