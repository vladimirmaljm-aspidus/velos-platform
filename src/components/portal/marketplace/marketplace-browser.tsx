"use client";

import { useEffect, useState } from "react";
import { useAppStore, type ViewKey } from "@/lib/store/app-store";
import { useSearchParams } from "next/navigation";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Store, Package, Inbox, Plus, Handshake, Users, LineChart, HelpCircle } from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { MarketplaceList } from "./marketplace-list";
import { MarketplaceCreatePost, type MarketplaceEditPost } from "./marketplace-create-post";
import { MarketplaceMyPosts } from "./marketplace-my-posts";
import { MarketplaceResponses } from "./marketplace-responses";
import { MarketplacePostDetail } from "./marketplace-post-detail";
import { MarketplaceDisclaimerBanner } from "./marketplace-disclaimer";
import { CommunicationLockedCard } from "./communication-locked";
import { HowItWorks } from "./how-it-works";
import { useMarketplacePermissions } from "@/lib/portal/use-marketplace-permissions";

/**
 * Task 2-c — quick-navigation chips rendered under the marketplace header.
 * They surface the whole marketplace surface (negotiations / community /
 * intelligence) from one place; the "How it works" chip opens the
 * 4-stage trade-lifecycle explainer in a dialog.
 */
const QUICK_LINKS: Array<{
  icon: React.ComponentType<{ className?: string }>;
  labelKey: string;
  view: ViewKey;
}> = [
  { icon: Handshake, labelKey: "marketplace-quick-negotiations", view: "portal-marketplace-negotiations" },
  { icon: Users, labelKey: "marketplace-quick-community", view: "portal-marketplace-community" },
  { icon: LineChart, labelKey: "marketplace-quick-intelligence", view: "portal-marketplace-intelligence" },
];

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
 *
 * Task 2-c: this component owns the marketplace header (title + subtitle
 * + Create button) and the quick-nav chip row — MarketplaceList no longer
 * renders its own duplicate title header.
 */
export function MarketplaceBrowser() {
  const t = useT();
  const selectedId = useAppStore((s) => s.selectedId);
  const setSelectedId = useAppStore((s) => s.setSelectedId);
  const setView = useAppStore((s) => s.setView);
  const sp = useSearchParams();
  const [tab, setTab] = useState<"browse" | "my-posts" | "responses">("browse");
  const [createOpen, setCreateOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  // 2-a — the post being edited in the create-post wizard (null = the
  // dialog, when open, runs in create mode). Owned here so My-Posts can
  // thread its Edit button up without knowing about the dialog.
  const [editingPost, setEditingPost] = useState<MarketplaceEditPost | null>(null);
  const { canCommunicate, blockReason } = useMarketplacePermissions();

  // Auto-open the create dialog when arriving via `?create=1` (e.g. the
  // "+ Create post" button in MarketplaceMyPosts redirects here) — but
  // never for clients whose tier/KYC blocks communication; they get the
  // locked card instead of a form the API would reject.
  useEffect(() => {
    if (sp?.get("create") === "1" && canCommunicate) {
// eslint-disable-next-line react-hooks/set-state-in-effect
      setCreateOpen(true);
      setEditingPost(null);
      setTab("browse");
    }
  }, [sp, canCommunicate]);

  // If a post id is selected, render the detail view (regardless of tab).
  if (selectedId) {
    return <MarketplacePostDetail postId={selectedId} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Store className="h-6 w-6" />
            {t("marketplace-title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t("marketplace-subtitle")}
          </p>
        </div>
        {/* Create CTA — hidden for clients whose tier/KYC blocks
            communication (the locked card below explains why). */}
        {canCommunicate && (
          <Button
            onClick={() => {
              // Never stack the edit dialog under a fresh create dialog.
              setEditingPost(null);
              setCreateOpen(true);
            }}
            className="shrink-0 gap-1.5 w-full sm:w-auto"
          >
            <Plus className="h-4 w-4" />
            {t("marketplace-create-post")}
          </Button>
        )}
      </div>

      {/* Quick navigation — one place to reach every marketplace surface. */}
      <nav aria-label={t("marketplace-title")} className="flex flex-wrap items-center gap-2">
        {QUICK_LINKS.map((link) => {
          const Icon = link.icon;
          return (
            <Button
              key={link.view}
              type="button"
              variant="outline"
              size="sm"
              className="rounded-full gap-1.5 smooth hover:border-primary/40 hover:text-primary"
              onClick={() => setView(link.view)}
            >
              <Icon className="size-3.5" />
              {t(link.labelKey)}
            </Button>
          );
        })}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-full gap-1.5 smooth hover:border-primary/40 hover:text-primary"
          onClick={() => setHowOpen(true)}
        >
          <HelpCircle className="size-3.5" />
          {t("marketplace-quick-how-it-works")}
        </Button>
      </nav>

      {/* Compliance notice — always visible, never dismissible. */}
      <MarketplaceDisclaimerBanner />

      {/* Communication gate — read-only clients see WHY they can't act. */}
      {!canCommunicate && blockReason && (
        <CommunicationLockedCard reason={blockReason} context="browser" />
      )}

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
          <MarketplaceList onCreateClick={() => { setEditingPost(null); setCreateOpen(true); }} />
        </TabsContent>

        <TabsContent value="my-posts" className="mt-4">
          <MarketplaceMyPosts
            onCreateClick={() => { setTab("browse"); setEditingPost(null); setCreateOpen(true); }}
            onEditClick={(p) => {
              // Editing wins over a pending create session (one dialog).
              setCreateOpen(false);
              setEditingPost(p);
            }}
          />
        </TabsContent>

        <TabsContent value="responses" className="mt-4">
          <MarketplaceResponses />
        </TabsContent>
      </Tabs>

      {/* 2-a — ONE dialog instance serves both create and edit modes:
          editingPost (non-null) switches the wizard to edit mode and drives
          the open state; closing it clears the edit target. */}
      <MarketplaceCreatePost
        open={createOpen || !!editingPost}
        editPost={editingPost ?? undefined}
        onOpenChange={(o) => {
          if (!o) {
            setCreateOpen(false);
            setEditingPost(null);
          }
        }}
      />

      {/* "How it works" explainer — the full 4-stage trade lifecycle
          (browse → negotiate → deal room → ship), with per-stage CTAs
          that navigate the SPA. */}
      <Dialog open={howOpen} onOpenChange={setHowOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>{t("how-it-works-title")}</DialogTitle>
            <DialogDescription>{t("how-it-works-subtitle")}</DialogDescription>
          </DialogHeader>
          <HowItWorks
            hideHeader
            showCta={false}
            className="border-0 shadow-none bg-transparent"
            onNavigate={() => setHowOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
