"use client";

import * as React from "react";
import { useAppStore } from "@/lib/store/app-store";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useT } from "@/lib/i18n/store";
import { cn } from "@/lib/utils";
import { fmtRelative } from "@/lib/utils/format";
import { toast } from "sonner";

import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import {
  Card, CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LoadMoreFooter } from "@/components/common/load-more-footer";
import {
  Tooltip, TooltipContent, TooltipTrigger,
} from "@/components/ui/tooltip";

import {
  Bell, Check, CheckCheck, Trash2, Search, Filter,
  FileText, CheckCircle2, XCircle, Inbox, DollarSign, AlertTriangle,
  MessageSquare, ShieldCheck, ShieldAlert, HelpCircle, UserPlus,
  Clock, Calendar, PenTool, FileSignature, Lock, Package,
  Info, AlertOctagon, Loader2,
} from "lucide-react";

/* ═══════════════════════════════════════════════════════════════════════════
   NOTIF-UX — Notifications view (full page)
   ═══════════════════════════════════════════════════════════════════════════
   This is the full-page Notifications surface linked from the sidebar's
   "Administration" section and from the topbar bell's "View all
   notifications" footer. It supports:
     • Pagination via "Load more" (20 items per page)
     • Type filter (offers / invoices / messages / KYC / marketplace / portal / task / system)
     • Read/unread toggle
     • Free-text search across title + message
     • Per-item "Mark as read" + "Delete" actions
     • "Mark all as read" header button
     • Date grouping (Today / Yesterday / Earlier)
     • Empty state: "You're all caught up!" with a checkmark icon

   It talks to:
     • GET /api/notifications?limit=&offset=&type=&read=&q=
     • PUT /api/notifications (with `{ id }` body for single mark-read, no body for all)
     • DELETE /api/notifications/[id]
   ═══════════════════════════════════════════════════════════════════════════ */

const PAGE_SIZE = 20;

// ── Notification shape (subset of the DB row, just the fields we render) ──
interface NotifItem {
  id: string;
  title: string;
  message: string;
  type: string;
  read: boolean;
  created_at: string;
  entity_type?: string | null;
  entity_id?: string | null;
  action_url?: string | null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   ICON + COLOR HELPERS — shared with the topbar bell (re-exported below)
   ═══════════════════════════════════════════════════════════════════════════ */

type IconComp = React.ComponentType<{ className?: string }>;

const NOTIF_ICON_MAP: Record<string, IconComp> = {
  offer_accepted:        CheckCircle2,
  offer_rejected:        XCircle,
  offer_received:        Inbox,
  offer_sent:            FileText,
  offer_expired:         Clock,
  offer_countered:       FileText,
  invoice_paid:          DollarSign,
  invoice_overdue:       AlertTriangle,
  invoice_sent:          FileText,
  proforma_sent:         FileText,
  proforma_accepted:     CheckCircle2,
  proforma_rejected:     XCircle,
  message_new:           MessageSquare,
  portal_message:        MessageSquare,
  marketplace_message_received: MessageSquare,
  email_failed:          AlertOctagon,
  kyc_submitted:         ShieldCheck,
  kyc_approved:          ShieldCheck,
  kyc_rejected:          ShieldAlert,
  marketplace_question:  HelpCircle,
  marketplace_answer:    MessageSquare,
  marketplace_response_received: Inbox,
  marketplace_response_accepted: CheckCircle2,
  marketplace_response_rejected: XCircle,
  signup_request:       UserPlus,
  trial_expiring:        Clock,
  contract_created:      FileText,
  escrow_released:       Lock,
  document_signed:       PenTool,
  document_shared:       FileSignature,
  event_registered:      Calendar,
  rfq_received:          Inbox,
  rfq_quoted:            FileText,
  portal_access_requested: UserPlus,
  portal_access_approved: CheckCircle2,
  portal_invite_sent:    Inbox,
  task_assigned:         Calendar,
  task_due_soon:         Clock,
  low_stock_alert:       Package,
  system_message:        Info,
};

const NOTIF_COLOR_MAP: Record<string, string> = {
  offer_accepted:        "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10",
  offer_rejected:        "text-destructive bg-destructive/10",
  offer_received:        "text-blue-600 dark:text-blue-400 bg-blue-500/10",
  offer_sent:            "text-blue-600 dark:text-blue-400 bg-blue-500/10",
  offer_expired:         "text-amber-600 dark:text-amber-400 bg-amber-500/10",
  offer_countered:      "text-blue-600 dark:text-blue-400 bg-blue-500/10",
  invoice_paid:          "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10",
  invoice_overdue:       "text-destructive bg-destructive/10",
  invoice_sent:          "text-blue-600 dark:text-blue-400 bg-blue-500/10",
  proforma_sent:         "text-blue-600 dark:text-blue-400 bg-blue-500/10",
  proforma_accepted:     "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10",
  proforma_rejected:     "text-destructive bg-destructive/10",
  message_new:           "text-blue-600 dark:text-blue-400 bg-blue-500/10",
  portal_message:        "text-blue-600 dark:text-blue-400 bg-blue-500/10",
  marketplace_message_received: "text-blue-600 dark:text-blue-400 bg-blue-500/10",
  email_failed:          "text-destructive bg-destructive/10",
  kyc_submitted:         "text-purple-600 dark:text-purple-400 bg-purple-500/10",
  kyc_approved:          "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10",
  kyc_rejected:          "text-destructive bg-destructive/10",
  marketplace_question:  "text-blue-600 dark:text-blue-400 bg-blue-500/10",
  marketplace_answer:    "text-blue-600 dark:text-blue-400 bg-blue-500/10",
  marketplace_response_received: "text-blue-600 dark:text-blue-400 bg-blue-500/10",
  marketplace_response_accepted: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10",
  marketplace_response_rejected: "text-destructive bg-destructive/10",
  signup_request:        "text-orange-600 dark:text-orange-400 bg-orange-500/10",
  trial_expiring:        "text-amber-600 dark:text-amber-400 bg-amber-500/10",
  contract_created:      "text-blue-600 dark:text-blue-400 bg-blue-500/10",
  escrow_released:       "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10",
  document_signed:       "text-blue-600 dark:text-blue-400 bg-blue-500/10",
  document_shared:       "text-blue-600 dark:text-blue-400 bg-blue-500/10",
  event_registered:      "text-purple-600 dark:text-purple-400 bg-purple-500/10",
  rfq_received:          "text-blue-600 dark:text-blue-400 bg-blue-500/10",
  rfq_quoted:            "text-blue-600 dark:text-blue-400 bg-blue-500/10",
  portal_access_requested: "text-orange-600 dark:text-orange-400 bg-orange-500/10",
  portal_access_approved:  "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10",
  portal_invite_sent:    "text-blue-600 dark:text-blue-400 bg-blue-500/10",
  task_assigned:         "text-blue-600 dark:text-blue-400 bg-blue-500/10",
  task_due_soon:         "text-amber-600 dark:text-amber-400 bg-amber-500/10",
  low_stock_alert:       "text-amber-600 dark:text-amber-400 bg-amber-500/10",
  system_message:        "text-muted-foreground bg-muted/40",
};

/**
 * Resolve a Lucide icon for a notification type. Falls back to a generic
 * Bell icon for unknown types so the UI never renders without an icon
 * (the spec maps 16+ known types; this is the safety net).
 */
export function getNotifIcon(type: string): IconComp {
  return NOTIF_ICON_MAP[type] ?? Bell;
}

/**
 * Resolve a Tailwind colour class string (text + bg tint) for a notification
 * type. The fallback is a neutral muted-foreground style. Returns the full
 * `text-… bg-…` pair so callers can apply both with one `cn()` call.
 */
export function getNotifColor(type: string): string {
  return NOTIF_COLOR_MAP[type] ?? "text-muted-foreground bg-muted/40";
}

// ── Filter dropdown options (group → label key) ──────────────────────────
const TYPE_OPTIONS: { value: string; labelKey: string }[] = [
  { value: "all",        labelKey: "notif-all-types" },
  { value: "offer",      labelKey: "notif-type-offer" },
  { value: "invoice",    labelKey: "notif-type-invoice" },
  { value: "proforma",   labelKey: "notif-type-proforma" },
  { value: "message",    labelKey: "notif-type-message" },
  { value: "kyc",        labelKey: "notif-type-kyc" },
  { value: "marketplace",labelKey: "notif-type-marketplace" },
  { value: "portal",     labelKey: "notif-type-portal" },
  { value: "task",       labelKey: "notif-type-task" },
  { value: "system",     labelKey: "notif-type-system" },
];

/* ═══════════════════════════════════════════════════════════════════════════
   VIEW
   ═══════════════════════════════════════════════════════════════════════════ */

export function NotificationsView() {
  const setView = useAppStore((s) => s.setView);
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  // ── Filter state ────────────────────────────────────────────────────────
  const [typeFilter, setTypeFilter] = React.useState<string>("all");
  const [readFilter, setReadFilter] = React.useState<"all" | "unread" | "read">("all");
  const [search, setSearch] = React.useState("");
  // Debounced search — we don't want to refetch on every keystroke.
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  React.useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(id);
  }, [search]);

  // ── Pagination state ────────────────────────────────────────────────────
  // We append pages (increment `pages`) on "Load more" and reset to 1 when
  // any filter changes. `offset = (pages - 1) * PAGE_SIZE`.
  const [pages, setPages] = React.useState(1);
  const [items, setItems] = React.useState<NotifItem[]>([]);
  const [total, setTotal] = React.useState(0);
  const [unreadCount, setUnreadCount] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  // Reset pagination to page 1 whenever any filter changes.
  React.useEffect(() => {
// eslint-disable-next-line react-hooks/set-state-in-effect
    setPages(1);
  }, [typeFilter, readFilter, debouncedSearch, tenantKey]);

  // Fetch page 1 whenever filters or tenant change.
  React.useEffect(() => {
    let active = true;
// eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    const offset = 0;
    const url = api("/api/notifications", {
      limit: PAGE_SIZE,
      offset,
      type: typeFilter !== "all" ? typeFilter : undefined,
      read: readFilter !== "all" ? readFilter : undefined,
      q: debouncedSearch || undefined,
    });
    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        if (!active) return;
        const its = Array.isArray(data?.items) ? data.items : [];
        setItems(its);
        setTotal(typeof data?.total === "number" ? data.total : its.length);
        setUnreadCount(typeof data?.unread_count === "number" ? data.unread_count : 0);
      })
      .catch(() => {
        if (!active) return;
        toast.error("Failed to load notifications.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, typeFilter, readFilter, debouncedSearch, tenantKey]);

  // ── Actions ──────────────────────────────────────────────────────────────
  const loadMore = React.useCallback(async () => {
    if (loadingMore || items.length >= total) return;
    setLoadingMore(true);
    const nextPages = pages + 1;
    const offset = (nextPages - 1) * PAGE_SIZE;
    try {
      const url = api("/api/notifications", {
        limit: PAGE_SIZE,
        offset,
        type: typeFilter !== "all" ? typeFilter : undefined,
        read: readFilter !== "all" ? readFilter : undefined,
        q: debouncedSearch || undefined,
      });
      const r = await fetch(url);
      const data = await r.json();
      const its = Array.isArray(data?.items) ? data.items : [];
      setItems((prev) => [...prev, ...its]);
      setTotal(typeof data?.total === "number" ? data.total : total);
      setPages(nextPages);
    } catch {
      toast.error("Failed to load more notifications.");
    } finally {
      setLoadingMore(false);
    }
  }, [api, loadingMore, items.length, total, pages, typeFilter, readFilter, debouncedSearch, tenantKey]);

  const markAllRead = React.useCallback(async () => {
    try {
      const r = await fetch(api("/api/notifications"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // No body = mark-all (server-side fallback for back-compat with the
        // existing topbar call which sends no body).
      });
      if (!r.ok) throw new Error("Failed");
      setItems((prev) => prev.map((n) => ({ ...n, read: true })));
      setUnreadCount(0);
      toast.success(t("mark-all-read"));
    } catch {
      toast.error("Failed to mark all as read.");
    }
  }, [api, t]);

  const markOneRead = React.useCallback(async (id: string) => {
    setBusyId(id);
    try {
      const r = await fetch(api("/api/notifications"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!r.ok) throw new Error("Failed");
      setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
      setUnreadCount((c) => Math.max(0, c - 1));
    } catch {
      toast.error("Failed to mark notification.");
    } finally {
      setBusyId(null);
    }
  }, [api]);

  const deleteOne = React.useCallback(async (id: string) => {
    setBusyId(id);
    try {
      const r = await fetch(api(`/api/notifications/${id}`), { method: "DELETE" });
      if (!r.ok) throw new Error("Failed");
      const removed = items.find((n) => n.id === id);
      setItems((prev) => prev.filter((n) => n.id !== id));
      setTotal((c) => Math.max(0, c - 1));
      if (removed && !removed.read) setUnreadCount((c) => Math.max(0, c - 1));
      toast.success("Notification deleted.");
    } catch {
      toast.error("Failed to delete notification.");
    } finally {
      setBusyId(null);
    }
  }, [api, items]);

  // Click on a notification row → mark read + navigate to the related entity.
  // The view-map mirrors the topbar's existing handler so the UX stays
  // consistent between the bell dropdown and the full page.
  function handleRowClick(n: NotifItem) {
    if (!n.read) markOneRead(n.id);
    if (n.entity_type) {
      const viewMap: Record<string, string> = {
        offer: "offers", invoice: "invoices", proforma: "proformas",
        kyc_submission: "kyc-review", deal: "deals", task: "tasks",
        portal_rfq: "portal-rfqs", document: "documents",
        portal_access: "portal-rfqs", partner: "partners", product: "products",
        marketplace_post: "portal-marketplace",
        marketplace_response: "portal-marketplace",
      };
      const targetView = viewMap[n.entity_type];
      if (targetView) setView(targetView as any);
    }
  }

  // ── Date grouping (localized) ─────────────────────────────────────────
  const groups = useGroupedNotifications(items);
  const hasItems = items.length > 0;
  const shown = items.length;
  const hasMore = shown < total;

  return (
    <div className="space-y-6">
      <PageHeader title={t("notif-title")} description={t("notif-desc")} />

      {/* ── Toolbar ────────────────────────────────────────────────────────── */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            {/* Search */}
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground/60 pointer-events-none" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("notif-search-placeholder")}
                className="pl-8 h-9 rounded-lg bg-background"
                aria-label={t("notif-search-placeholder")}
              />
            </div>

            {/* Type filter (dropdown — keeps the toolbar compact on mobile) */}
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="h-9 w-full sm:w-[180px] rounded-lg">
                <Filter className="size-3.5 mr-1.5 text-muted-foreground/70" />
                <SelectValue placeholder={t("notif-all-types")} />
              </SelectTrigger>
              <SelectContent>
                {TYPE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {t(opt.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Read filter (segmented control — small, mobile-friendly) */}
            <Tabs value={readFilter} onValueChange={(v) => setReadFilter(v as any)}>
              <TabsList className="h-9 rounded-lg">
                <TabsTrigger value="all" className="px-2.5 text-xs">{t("notif-status-all")}</TabsTrigger>
                <TabsTrigger value="unread" className="px-2.5 text-xs">
                  {t("notif-status-unread")}
                  {unreadCount > 0 && (
                    <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px] tabular-nums">
                      {unreadCount > 99 ? "99+" : unreadCount}
                    </Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="read" className="px-2.5 text-xs">{t("notif-status-read")}</TabsTrigger>
              </TabsList>
            </Tabs>

            {/* Mark all as read */}
            <Button
              variant="outline"
              size="sm"
              onClick={markAllRead}
              disabled={unreadCount === 0}
              className="h-9 rounded-lg shrink-0"
            >
              <CheckCheck className="size-4 mr-1.5" />
              {t("mark-all-read")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── List ───────────────────────────────────────────────────────────── */}
      <Card className="border-border/60 shadow-soft rounded-xl overflow-hidden">
        {loading ? (
          <CardContent className="p-4 space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-start gap-3 py-3">
                <Skeleton className="size-9 rounded-full shrink-0" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-3 w-3/4" />
                </div>
              </div>
            ))}
          </CardContent>
        ) : !hasItems ? (
          <EmptyState
            icon={<CheckCircle2 className="size-8 text-emerald-500" />}
            title={t("notif-empty-title")}
            description={t("notif-empty-desc")}
            className="py-20"
          />
        ) : (
          <div className="divide-y divide-border/40">
            {groups.map((g) => (
              <div key={g.label}>
                {/* Date header */}
                <div className="sticky top-0 z-10 bg-muted/40 backdrop-blur-sm px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {g.label}
                </div>
                <ul className="divide-y divide-border/30">
                  {g.items.map((n) => {
                    const Icon = getNotifIcon(n.type);
                    const color = getNotifColor(n.type);
                    const isBusy = busyId === n.id;
                    return (
                      <li key={n.id}>
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => handleRowClick(n)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              handleRowClick(n);
                            }
                          }}
                          className={cn(
                            "w-full text-left px-4 py-3 flex items-start gap-3 smooth relative group cursor-pointer",
                            !n.read && "bg-accent/30",
                            "hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none",
                          )}
                        >
                          {/* Unread dot */}
                          {!n.read && (
                            <span className="absolute left-1.5 top-1/2 -translate-y-1/2 size-1.5 rounded-full bg-emerald-500" />
                          )}

                          {/* Icon */}
                          <div className={cn("size-9 shrink-0 rounded-full flex items-center justify-center", color)}>
                            <Icon className="size-4" />
                          </div>

                          {/* Body */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-baseline gap-2">
                              <p className={cn("text-sm truncate", n.read ? "font-medium" : "font-semibold")}>
                                {n.title}
                              </p>
                              <span className="text-xs text-muted-foreground ml-auto shrink-0 tabular-nums">
                                {fmtRelative(n.created_at)}
                              </span>
                            </div>
                            {n.message && (
                              <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{n.message}</p>
                            )}
                            <div className="flex items-center gap-2 mt-1.5">
                              <Badge variant="outline" className="text-[10px] h-5 px-1.5 font-normal capitalize">
                                {n.type.replace(/_/g, " ")}
                              </Badge>
                              {n.read ? (
                                <Badge variant="secondary" className="text-[10px] h-5 px-1.5 font-normal">
                                  {t("notif-status-read")}
                                </Badge>
                              ) : (
                                <Badge className="text-[10px] h-5 px-1.5 font-normal bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/15">
                                  {t("notif-status-unread")}
                                </Badge>
                              )}
                            </div>
                          </div>

                          {/* Per-item actions */}
                          <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 smooth">
                            {!n.read && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="size-7 rounded-md text-muted-foreground hover:text-emerald-600 hover:bg-emerald-500/10"
                                    disabled={isBusy}
                                    onClick={(e) => { e.stopPropagation(); markOneRead(n.id); }}
                                    aria-label={t("notif-mark-read")}
                                  >
                                    {isBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent side="bottom">{t("notif-mark-read")}</TooltipContent>
                              </Tooltip>
                            )}
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="size-7 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                  disabled={isBusy}
                                  onClick={(e) => { e.stopPropagation(); deleteOne(n.id); }}
                                  aria-label={t("notif-delete")}
                                >
                                  <Trash2 className="size-3.5" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="bottom">{t("notif-delete")}</TooltipContent>
                            </Tooltip>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}

        {/* Load more footer */}
        {!loading && hasItems && (
          <LoadMoreFooter
            shown={shown}
            total={total}
            hasMore={hasMore}
            loading={loadingMore}
            onClick={loadMore}
            loadMoreLabel={t("notif-load-more")}
            loadingLabel={t("notif-loading")}
            showingLabel={t("notif-showing")}
          />
        )}
      </Card>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

interface NotifGroup {
  label: string;
  items: NotifItem[];
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function groupByDate(items: NotifItem[]): NotifGroup[] {
  const todayStart = startOfDay(new Date());
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);

  const today: NotifItem[] = [];
  const yesterday: NotifItem[] = [];
  const earlier: NotifItem[] = [];

  for (const n of items) {
    const d = new Date(n.created_at);
    if (d >= todayStart) today.push(n);
    else if (d >= yesterdayStart) yesterday.push(n);
    else earlier.push(n);
  }

  // The list comes pre-sorted by created_at desc from the API, so each
  // bucket is already in the right order. We just need to drop empty
  // buckets and emit a sentinel label — the localized header text is
  // applied by `useGroupedNotifications` at the call site.
  const groups: NotifGroup[] = [];
  if (today.length) groups.push({ label: "today", items: today });
  if (yesterday.length) groups.push({ label: "yesterday", items: yesterday });
  if (earlier.length) groups.push({ label: "earlier", items: earlier });
  return groups;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Localized grouping — wraps `groupByDate` with the i18n function so the
   sticky date headers ("Today" / "Yesterday" / "Earlier") are localized.
   ═══════════════════════════════════════════════════════════════════════════ */
function useGroupedNotifications(items: NotifItem[]): NotifGroup[] {
  const t = useT();
  return React.useMemo(() => {
    const raw = groupByDate(items);
    return raw.map((g) => ({
      label:
        g.label === "today"     ? t("misc-today") :
        g.label === "yesterday" ? t("notif-yesterday") :
        t("notif-earlier"),
      items: g.items,
    }));
  }, [items, t]);
}
