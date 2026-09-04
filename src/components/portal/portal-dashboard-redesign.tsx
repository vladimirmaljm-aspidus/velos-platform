"use client";

import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  Plus,
  Store,
  Inbox,
  ArrowRight,
  TrendingUp,
  TrendingDown,
  Gavel,
  FileText,
  Eye,
  MessageSquare,
  Clock,
  Crown,
  Shield,
  Boxes,
  Briefcase,
  Bell,
  CheckCircle2,
  AlertTriangle,
  Info,
  XCircle,
  Handshake,
  FileCheck2,
} from "lucide-react";
import { useAppStore, ViewKey } from "@/lib/store/app-store";
import { useT } from "@/lib/i18n/store";
import { fmtRelative, fmtMoney, fmtDate } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type {
  PortalAccess,
  PortalTier,
  Partner,
  Notification,
  NotificationType,
} from "@/lib/supabase/types";
import type {
  MarketplacePostType,
  MarketplaceResponseStatus,
} from "@/lib/supabase/marketplace-types";
import { MarketplacePostCard, type MarketplacePostCardData } from "./marketplace/marketplace-post-card";
import { HowItWorks } from "./marketplace/how-it-works";

const TIER_META: Record<
  PortalTier,
  { labelKey: string; className: string; icon: React.ComponentType<{ className?: string }> }
> = {
  premium: {
    labelKey: "portal-tier-premium",
    className: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",
    icon: Crown,
  },
  business: {
    labelKey: "portal-tier-business",
    className: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    icon: Briefcase,
  },
  standard: {
    labelKey: "portal-tier-standard",
    className: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-400",
    icon: Shield,
  },
  basic: {
    labelKey: "portal-tier-basic",
    className: "border-transparent bg-muted text-muted-foreground",
    icon: Boxes,
  },
  limited: {
    labelKey: "portal-tier-basic",
    className: "border-transparent bg-muted text-muted-foreground",
    icon: Boxes,
  },
};

const TYPE_BADGE: Record<MarketplacePostType, { labelKey: string; cls: string }> = {
  buy: { labelKey: "marketplace-buy", cls: "border-transparent bg-green-500/15 text-green-700 dark:text-green-400" },
  sell: { labelKey: "marketplace-sell", cls: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  auction: { labelKey: "marketplace-auction", cls: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  contract: { labelKey: "marketplace-contract", cls: "border-transparent bg-violet-500/15 text-violet-700 dark:text-violet-400" },
};

function getNotifCategory(type: NotificationType): "info" | "warning" | "success" | "error" {
  if (type.startsWith("kyc_rejected") || type === "invoice_overdue" || type === "low_stock_alert" || type === "marketplace_response_rejected") return "error";
  if (type.startsWith("kyc_submitted") || type === "rfq_received" || type === "task_due_soon" || type === "marketplace_response_received") return "warning";
  if (
    type.startsWith("kyc_approved") ||
    type === "invoice_paid" ||
    type === "offer_accepted" ||
    type === "rfq_quoted" ||
    type === "portal_access_approved" ||
    type === "marketplace_response_accepted"
  )
    return "success";
  return "info";
}

const NOTIF_CATEGORY_CONFIG: Record<
  string,
  { icon: React.ComponentType<{ className?: string }>; color: string; bg: string }
> = {
  info: { icon: Info, color: "text-primary", bg: "bg-primary/10" },
  warning: { icon: AlertTriangle, color: "text-amber-600", bg: "bg-amber-500/10" },
  success: { icon: CheckCircle2, color: "text-emerald-600", bg: "bg-emerald-500/10" },
  error: { icon: XCircle, color: "text-destructive", bg: "bg-destructive/10" },
};

interface MyPostRow {
  id: string;
  post_type: MarketplacePostType;
  product_name: string;
  quantity: number;
  unit: string;
  target_price: number | null;
  currency: string;
  status: string;
  views_count: number;
  responses_count: number;
  created_at: string;
}

interface ResponseRow {
  id: string;
  post_id: string;
  quantity: number | null;
  unit_price: number | null;
  currency: string;
  delivery_date: string | null;
  delivery_location: string | null;
  incoterm: string | null;
  payment_terms: string | null;
  message: string | null;
  status: MarketplaceResponseStatus;
  is_counter: boolean;
  created_at: string;
}

interface NegotiationRow {
  id: string;
  post_id: string;
  status: string;
  contact_revealed: boolean;
  last_message_at: string | null;
  created_at: string;
  awaiting_party?: "A" | "B" | null;
}

/**
 * UI-3 step 5 — Portal dashboard redesign.
 *
 * A marketplace-focused welcome page that replaces the Phase-1
 * `portal-dashboard.tsx` (which led with CRM-side KPIs like
 * offers/invoices/proformas the client doesn't manage). The redesign is
 * friendlier for a marketplace trader:
 *
 *   • Hero welcome with the partner's first name + tier badge.
 *   • Quick stats: My posts / My responses / Active negotiations.
 *   • Quick actions: Create Post, Browse Marketplace, View My Offers.
 *   • Recent marketplace posts (latest 4) — gives the dashboard life even
 *     when the user has nothing of their own yet.
 *   • Recent responses received on the user's posts.
 *   • Recent activity feed (built from notifications).
 *   • For brand-new accounts with zero posts, the HowItWorks explainer
 *     replaces the empty "recent posts" block so first-time users see a
 *     clear path to their first post.
 */
export function PortalDashboardRedesign() {
  const t = useT();
  const portalAccess = useAppStore((s) => s.portalAccess) as PortalAccess | null;
  const setView = useAppStore((s) => s.setView);

  const profileQ = useQuery<{ partner: Partner }>({
    queryKey: ["portal-profile"],
    queryFn: async () => {
      const r = await fetch("/api/portal/profile");
      if (!r.ok) throw new Error("Failed to load profile");
      return r.json();
    },
  });

  const myPostsQ = useQuery<{ items: MyPostRow[]; total: number }>({
    queryKey: ["portal-marketplace-my-posts"],
    queryFn: async () => {
      const r = await fetch("/api/marketplace/my-posts");
      if (!r.ok) return { items: [], total: 0 };
      return r.json();
    },
  });

  const myResponsesQ = useQuery<{ sent?: ResponseRow[]; received?: ResponseRow[] }>({
    queryKey: ["portal-marketplace-my-responses"],
    queryFn: async () => {
      const r = await fetch("/api/marketplace/my-responses");
      if (!r.ok) return { sent: [], received: [] };
      return r.json();
    },
  });

  const negotiationsQ = useQuery<{ items: NegotiationRow[] }>({
    queryKey: ["portal-marketplace-negotiations"],
    queryFn: async () => {
      const r = await fetch("/api/marketplace/negotiations");
      if (!r.ok) return { items: [] };
      return r.json();
    },
  });

  const notifsQ = useQuery<{ items: Notification[]; total: number }>({
    queryKey: ["portal-notifications"],
    queryFn: async () => {
      // 2b2-F3 — pass ?limit=6 so the store caps the DB query (was:
      // fetch all partner notifications every 60s + slice in JS to 6
      // for the widget). The widget only renders `recentNotifs.slice(0, 6)`
      // — there's no point pulling thousands of rows.
      const r = await fetch("/api/portal/notifications?limit=6");
      if (!r.ok) return { items: [], total: 0 };
      return r.json();
    },
    // REALTIME-WS: 30s → 60s. Dashboard widgets don't need 30s freshness;
    // live events (offer/invoice/portal) are pushed by the realtime gateway
    // and surface via useRealtime in the parent PortalShell.
    refetchInterval: 60_000,
  });

  // Latest marketplace posts — the "what's happening" feed.
  const recentMarketQ = useQuery<{ items: MarketplacePostCardData[]; total: number }>({
    queryKey: ["portal-marketplace-recent"],
    queryFn: async () => {
      const r = await fetch("/api/marketplace?limit=4&sort=recent");
      if (!r.ok) return { items: [], total: 0 };
      return r.json();
    },
  });

  // BUILD-LOI-PORTAL — LOIs addressed to this partner. Only fetched when the
  // partner can view trade documents (same gate as the LOI module itself);
  // drives the "awaiting your response" stat card that makes the LOI module
  // discoverable from the dashboard. Errors degrade silently to 0.
  const loisQ = useQuery<{ items: Array<{ status: string }>; total: number }>({
    queryKey: ["portal-lois-dashboard"],
    queryFn: async () => {
      const r = await fetch("/api/portal/lois?limit=50");
      if (!r.ok) return { items: [], total: 0 };
      return r.json();
    },
    enabled: !!portalAccess?.can_view_offers,
  });

  if (!portalAccess) return null;

  const tier = portalAccess.tier;
  const TierIcon = TIER_META[tier].icon;
  const partner = profileQ.data?.partner;
  const partnerName = partner?.name || t("portal-default-client");
  const firstName = partnerName.split(" ")[0] || partnerName;
  const country = partner?.country;

  const myPosts = myPostsQ.data?.items ?? [];
  const myPostsTotal = myPostsQ.data?.total ?? 0;
  const receivedResponses = myResponsesQ.data?.received ?? [];
  const sentResponses = myResponsesQ.data?.sent ?? [];
  const activeNegotiations = (negotiationsQ.data?.items ?? []).filter(
    (n) => n.status === "active" || n.status === "awaiting",
  );
  const recentNotifs = (notifsQ.data?.items ?? []).slice(0, 6);
  const unreadNotifCount = (notifsQ.data?.items ?? []).filter((n) => !n.read).length;
  const recentMarket = recentMarketQ.data?.items ?? [];

  // Stats cards
  // BUILD-LOI-PORTAL — pending-LOI stat appended when the partner can view
  // trade documents: counts SENT LOIs (the ones awaiting the seller's
  // accept/reject). The grid switches 3→4 columns on lg.
  const pendingLois = (loisQ.data?.items ?? []).filter(
    (l) => String(l.status || "").toLowerCase() === "sent",
  ).length;
  const stats = [
    {
      label: t("portal-dashboard-redesign-my-posts"),
      value: myPostsQ.isLoading ? "—" : myPostsTotal,
      icon: Store,
      color: "text-emerald-700 dark:text-emerald-400",
      bg: "bg-emerald-500/10",
      onClick: () => setView("portal-marketplace" as ViewKey),
    },
    {
      label: t("portal-dashboard-redesign-my-responses"),
      value: myResponsesQ.isLoading ? "—" : receivedResponses.length + sentResponses.length,
      icon: Inbox,
      color: "text-sky-700 dark:text-sky-400",
      bg: "bg-sky-500/10",
      onClick: () => setView("portal-marketplace" as ViewKey),
    },
    {
      label: t("portal-dashboard-redesign-negotiations"),
      value: negotiationsQ.isLoading ? "—" : activeNegotiations.length,
      icon: Handshake,
      color: "text-amber-700 dark:text-amber-400",
      bg: "bg-amber-500/10",
      onClick: () => setView("portal-marketplace-negotiations" as ViewKey),
    },
    ...(portalAccess?.can_view_offers
      ? [
          {
            label: t("portal-dashboard-redesign-pending-lois"),
            value: loisQ.isLoading ? "—" : pendingLois,
            icon: FileCheck2,
            color: "text-teal-700 dark:text-teal-400",
            bg: "bg-teal-500/10",
            onClick: () => setView("portal-lois" as ViewKey),
          },
        ]
      : []),
  ];

  // Quick actions
  // AUDIT2-LOW #5: previously the "View offers" quick action routed to
  // portal-marketplace when !can_view_offers, which was misleading
  // because the button label said "View offers". Now the "View offers"
  // quick action is only shown when the user can actually view offers.
  // When !can_view_offers we substitute a permission-appropriate
  // replacement: "Request a Quote" if can_submit_rfq, else "Browse
  // catalog" if can_view_catalog. If neither is allowed the slot is
  // omitted entirely.
  const quickActions = [
    {
      label: t("portal-dashboard-redesign-create-post"),
      icon: Plus,
      onClick: () => setView("portal-marketplace" as ViewKey),
      primary: true,
    },
    {
      label: t("portal-dashboard-redesign-browse"),
      icon: Store,
      onClick: () => setView("portal-marketplace" as ViewKey),
      primary: false,
    },
    portalAccess.can_view_offers
      ? {
          label: t("portal-dashboard-redesign-view-offers"),
          icon: FileText,
          onClick: () => setView("portal-offers" as ViewKey),
          primary: false,
        }
      : portalAccess.can_submit_rfq
        ? {
            label: t("portal-nav-request-quote"),
            icon: FileText,
            onClick: () => setView("portal-rfq" as ViewKey),
            primary: false,
          }
        : portalAccess.can_view_catalog
          ? {
              label: t("portal-dashboard-redesign-browse-catalog"),
              icon: FileText,
              onClick: () => setView("portal-catalog" as ViewKey),
              primary: false,
            }
          : null,
  ].filter((qa): qa is NonNullable<typeof qa> => qa !== null);

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* ─── Welcome hero ──────────────────────────────────────────────── */}
      <div className="border-gradient shadow-soft-lg">
        <div className="relative bg-card rounded-[calc(var(--radius-xl)-1px)] overflow-hidden">
          <div className="absolute inset-0 bg-mesh-portal opacity-70" />
          <div className="relative p-6 sm:p-8">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm text-muted-foreground mb-1.5">
                  {fmtDate(new Date().toISOString(), {
                    weekday: "long",
                    day: "2-digit",
                    month: "long",
                  })}
                </p>
                <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
                  {t("portal-dashboard-redesign-welcome").replace("{name}", firstName)}
                </h1>
                <p className="text-sm text-muted-foreground mt-1.5">
                  {t("portal-dashboard-redesign-subtitle")}
                </p>
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  <Badge className={cn("gap-1", TIER_META[tier].className)}>
                    <TierIcon className="size-3" />
                    {t(TIER_META[tier].labelKey)}
                  </Badge>
                  {country && (
                    <Badge variant="outline" className="gap-1 bg-card/60">
                      {country}
                    </Badge>
                  )}
                  {portalAccess.last_login_at && (
                    <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                      <Clock className="size-3" />
                      {t("portal-last-login")} {fmtRelative(portalAccess.last_login_at)}
                    </span>
                  )}
                  {unreadNotifCount > 0 && (
                    <Badge
                      className="gap-1 border-transparent bg-primary/15 text-primary cursor-pointer smooth hover:bg-primary/25"
                      onClick={() => setView("portal-notifications")}
                    >
                      <Bell className="size-3" />
                      {t("portal-unread").replace("{n}", String(unreadNotifCount))}
                    </Badge>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-2 shrink-0">
                {quickActions.map((qa) => {
                  const Icon = qa.icon;
                  return (
                    <Button
                      key={qa.label}
                      variant={qa.primary ? "default" : "outline"}
                      size="sm"
                      onClick={qa.onClick}
                      className={cn(
                        "gap-1.5 smooth hover:shadow-soft-md",
                        !qa.primary && "bg-card/60 backdrop-blur-sm",
                      )}
                    >
                      <Icon className="size-4" />
                      {qa.label}
                    </Button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ─── Quick stats ───────────────────────────────────────────────── */}
      <div className={cn(
        "grid grid-cols-1 sm:grid-cols-2 gap-4",
        stats.length === 3 ? "lg:grid-cols-3" : "lg:grid-cols-4",
      )}>
        {stats.map((s) => {
          const Icon = s.icon;
          return (
            <button
              key={s.label}
              onClick={s.onClick}
              className="card-premium text-left group"
            >
              <div className="p-5 flex items-center gap-4">
                <div className={cn("size-12 rounded-xl flex items-center justify-center shrink-0", s.bg)}>
                  <Icon className={cn("size-6", s.color)} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-muted-foreground">{s.label}</p>
                  <p className="text-2xl font-semibold tabular mt-0.5">{s.value}</p>
                </div>
                <ArrowRight className="size-4 text-muted-foreground/50 group-hover:text-foreground smooth" />
              </div>
            </button>
          );
        })}
      </div>

      {/* ─── Quick actions row (mobile-only — the hero already has them on sm+) */}
      <div className="sm:hidden grid grid-cols-3 gap-2">
        {quickActions.map((qa) => {
          const Icon = qa.icon;
          return (
            <Button
              key={qa.label}
              variant={qa.primary ? "default" : "outline"}
              size="sm"
              onClick={qa.onClick}
              className="gap-1 text-xs px-2"
            >
              <Icon className="size-3.5" />
              <span className="truncate">{qa.label}</span>
            </Button>
          );
        })}
      </div>

      {/* ─── Recent marketplace posts + Recent activity ─────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Recent marketplace posts — 2/3 width */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold tracking-tight">
                {t("portal-dashboard-redesign-recent-posts")}
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("portal-dashboard-redesign-recent-posts-sub")}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setView("portal-marketplace" as ViewKey)}
              className="text-primary"
            >
              {t("portal-action-view-all")} <ArrowRight className="size-3.5 ml-1" />
            </Button>
          </div>

          {recentMarketQ.isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : recentMarket.length === 0 ? (
            <HowItWorks onCreateClick={() => setView("portal-marketplace" as ViewKey)} />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {recentMarket.map((post) => (
                <MarketplacePostCard
                  key={post.id}
                  post={post}
                  onClick={(id) => {
                    useAppStore.getState().setSelectedId(id);
                    setView("portal-marketplace" as ViewKey);
                  }}
                />
              ))}
            </div>
          )}
        </div>

        {/* Recent activity — 1/3 width */}
        <div className="lg:col-span-1">
          <div className="card-premium h-full">
            <div className="p-5 pb-3 flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold tracking-tight">
                  {t("portal-dashboard-redesign-activity")}
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t("portal-dashboard-redesign-activity-sub")}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setView("portal-notifications")}
                className="text-primary"
              >
                <ArrowRight className="size-3.5" />
              </Button>
            </div>
            <div className="px-2 pb-2">
              {notifsQ.isLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : recentNotifs.length === 0 ? (
                <div className="px-3 py-8 text-center">
                  <div className="size-10 mx-auto rounded-xl bg-muted flex items-center justify-center mb-2">
                    <Bell className="size-5 text-muted-foreground" />
                  </div>
                  <p className="text-xs text-muted-foreground">{t("portal-dashboard-redesign-no-activity")}</p>
                </div>
              ) : (
                <div className="space-y-1 max-h-96 overflow-y-auto custom-scroll">
                  {recentNotifs.map((n) => {
                    const cat = getNotifCategory(n.type);
                    const cfg = NOTIF_CATEGORY_CONFIG[cat];
                    const Icon = cfg.icon;
                    return (
                      <button
                        key={n.id}
                        onClick={() => setView("portal-notifications")}
                        className="w-full flex items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-accent smooth"
                      >
                        <div className={cn("size-8 rounded-lg flex items-center justify-center shrink-0", cfg.bg)}>
                          <Icon className={cn("size-4", cfg.color)} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium line-clamp-2">{n.title}</p>
                          {n.message && (
                            <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{n.message}</p>
                          )}
                          <p className="text-xs text-muted-foreground mt-0.5 tabular">
                            {fmtRelative(n.created_at)}
                          </p>
                        </div>
                        {!n.read && <span className="mt-1 size-1.5 rounded-full bg-primary shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ─── My posts + Recent responses received ──────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* My posts */}
        <div className="card-premium">
          <div className="p-5 pb-3 flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold tracking-tight">
                {t("portal-dashboard-redesign-my-posts")}
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("marketplace-my-posts-count").replace("{n}", String(myPostsTotal))}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setView("portal-marketplace" as ViewKey)}
              className="text-primary"
            >
              {t("portal-action-view-all")} <ArrowRight className="size-3.5 ml-1" />
            </Button>
          </div>
          <div className="px-2 pb-2">
            {myPostsQ.isLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : myPosts.length === 0 ? (
              <div className="px-3 py-8 text-center">
                <div className="size-10 mx-auto rounded-xl bg-emerald-500/10 flex items-center justify-center mb-2">
                  <Plus className="size-5 text-emerald-700 dark:text-emerald-400" />
                </div>
                <p className="text-xs text-muted-foreground">{t("portal-dashboard-redesign-no-posts")}</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3 gap-1"
                  onClick={() => setView("portal-marketplace" as ViewKey)}
                >
                  <Plus className="size-3.5" />
                  {t("portal-dashboard-redesign-cta-create")}
                </Button>
              </div>
            ) : (
              <div className="space-y-1 max-h-80 overflow-y-auto custom-scroll">
                {myPosts.slice(0, 5).map((p) => {
                  const badge = TYPE_BADGE[p.post_type] ?? TYPE_BADGE.sell;
                  return (
                    <button
                      key={p.id}
                      onClick={() => {
                        useAppStore.getState().setSelectedId(p.id);
                        setView("portal-marketplace" as ViewKey);
                      }}
                      className="w-full flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-accent smooth"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <Badge className={cn("text-xs px-1.5 py-0", badge.cls)}>
                            {t(badge.labelKey)}
                          </Badge>
                          <span className="text-xs text-muted-foreground capitalize">{p.status}</span>
                        </div>
                        <p className="text-sm font-medium truncate mt-0.5">{p.product_name}</p>
                        <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                          <span className="inline-flex items-center gap-1">
                            <Eye className="size-3" />
                            <span className="tabular">{p.views_count}</span>
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <MessageSquare className="size-3" />
                            <span className="tabular">{p.responses_count}</span>
                          </span>
                          <span className="tabular">{fmtRelative(p.created_at)}</span>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-semibold tabular">
                          {p.target_price ? fmtMoney(p.target_price, p.currency) : "—"}
                        </p>
                        <p className="text-xs text-muted-foreground tabular">
                          {p.quantity.toLocaleString()} {p.unit}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Recent responses received */}
        <div className="card-premium">
          <div className="p-5 pb-3 flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold tracking-tight">
                {t("portal-dashboard-redesign-recent-responses")}
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("portal-dashboard-redesign-recent-responses-sub")}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setView("portal-marketplace" as ViewKey)}
              className="text-primary"
            >
              {t("portal-action-view-all")} <ArrowRight className="size-3.5 ml-1" />
            </Button>
          </div>
          <div className="px-2 pb-2">
            {myResponsesQ.isLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : receivedResponses.length === 0 ? (
              <div className="px-3 py-8 text-center">
                <div className="size-10 mx-auto rounded-xl bg-sky-500/10 flex items-center justify-center mb-2">
                  <Inbox className="size-5 text-sky-700 dark:text-sky-400" />
                </div>
                <p className="text-xs text-muted-foreground">{t("portal-dashboard-redesign-no-responses")}</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3 gap-1"
                  onClick={() => setView("portal-marketplace" as ViewKey)}
                >
                  <Store className="size-3.5" />
                  {t("portal-dashboard-redesign-cta-browse")}
                </Button>
              </div>
            ) : (
              <div className="space-y-1 max-h-80 overflow-y-auto custom-scroll">
                {receivedResponses.slice(0, 5).map((r) => (
                  <button
                    key={r.id}
                    onClick={() => {
                      useAppStore.getState().setSelectedId(r.post_id);
                      setView("portal-marketplace" as ViewKey);
                    }}
                    className="w-full flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-accent smooth"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Badge className="text-xs px-1.5 py-0 capitalize border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-400">
                          {r.status}
                        </Badge>
                        {r.is_counter && (
                          <Badge className="text-xs px-1.5 py-0 border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400">
                            Counter
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm font-medium truncate mt-0.5">
                        {r.message ? r.message : `Response on ${fmtDate(r.created_at)}`}
                      </p>
                      <p className="text-xs text-muted-foreground tabular mt-0.5">
                        {fmtRelative(r.created_at)}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-semibold tabular">
                        {r.unit_price ? fmtMoney(r.unit_price, r.currency) : "—"}
                      </p>
                      {r.quantity && (
                        <p className="text-xs text-muted-foreground tabular">
                          {r.quantity.toLocaleString()}
                        </p>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

