"use client";

import { useState, useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Bell,
  Info,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Loader2,
  Inbox,
  Mail,
  MailOpen,
  ExternalLink,
} from "lucide-react";
import { fmtRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type { Notification, NotificationType } from "@/lib/supabase/types";
import { useAppStore, ViewKey } from "@/lib/store/app-store";
import { useT } from "@/lib/i18n/store";
import { useRealtime } from "@/hooks/use-realtime";

/** Map a server-issued action_url (often an admin path) to a portal ViewKey. */
function portalViewForUrl(url: string, type: NotificationType): ViewKey | null {
  const u = url.toLowerCase();
  // PORTAL-M3 — URL-based matching takes precedence over type-based matching.
  // A notification with type="rfq_received" but URL="/logistics?open=..." must
  // route to the logistics view, not the RFQ view. We check the URL first,
  // then fall back to type-based matching for URLs with no clear path segment.
  if (u.includes("/logistics")) return "portal-logistics";
  if (u.includes("/rfq")) return "portal-rfq";
  if (u.includes("/kyc")) return "portal-kyc";
  if (u.includes("/invoice")) return "portal-invoices";
  if (u.includes("/offer")) return "portal-offers";
  if (u.includes("/proforma")) return "portal-proformas";
  if (u.includes("/document")) return "portal-documents";
  if (u.includes("/messages")) return "portal-messages";
  if (u.includes("/portal-access")) return "portal-messages";
  // Marketplace (Phase 2) — point negotiation + response notifications at the
  // negotiation rooms view. The deep-link path /portal/marketplace/negotiations
  // is rendered by NegotiationsBrowser inside PortalShell.
  if (u.includes("/marketplace/negotiation")) return "portal-marketplace-negotiations";
  // Fall back to type-based matching when the URL has no clear path segment.
  if (type === "portal_message") return "portal-messages";
  if (type === "rfq_received" || type === "rfq_quoted") return "portal-rfq";
  if (type.startsWith("kyc_")) return "portal-kyc";
  if (type.startsWith("invoice_")) return "portal-invoices";
  if (type.startsWith("offer_")) return "portal-offers";
  if (type.startsWith("proforma_")) return "portal-proformas";
  if (type === "document_shared") return "portal-documents";
  if (type.startsWith("marketplace_")) return "portal-marketplace-negotiations";
  return null;
}

/** Map notification type to a visual category */
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
  // marketplace_message_received + everything else → info
  return "info";
}

const CATEGORY_CONFIG: Record<
  string,
  { icon: React.ComponentType<{ className?: string }>; color: string; bg: string }
> = {
  info: { icon: Info, color: "text-primary", bg: "bg-primary/10" },
  warning: { icon: AlertTriangle, color: "text-amber-600", bg: "bg-amber-500/10" },
  success: { icon: CheckCircle2, color: "text-emerald-600", bg: "bg-emerald-500/10" },
  error: { icon: XCircle, color: "text-destructive", bg: "bg-destructive/10" },
};

export function PortalNotifications() {
  const t = useT();
  const queryClient = useQueryClient();
  const setView = useAppStore((s) => s.setView);
  const [markingRead, setMarkingRead] = useState<string | null>(null);

  // PORTAL-L1 — backend now returns { items, count, unread_count } (was
  // { items, total }). `count` is the number of items returned (after the
  // optional ?limit slice), `unread_count` is the number of unread items.
  // This page renders the FULL list (no limit), so count === items.length.
  const notifsQ = useQuery<{ items: Notification[]; count: number; unread_count: number }>({
    queryKey: ["portal-notifications"],
    queryFn: async () => {
      const r = await fetch("/api/portal/notifications");
      if (!r.ok) throw new Error("Failed to load notifications");
      return r.json();
    },
    // REALTIME-WS: removed the previous 30s polling — the realtime gateway
    // pushes notification:new events (received via useRealtime below), which
    // invalidate this query for an instant refresh. `refetchOnWindowFocus`
    // (React Query default) covers the case where the user returns to the
    // tab; the page is rarely left open in the background like the bell is.
    refetchOnWindowFocus: true,
  });

  // ── REALTIME-WS: live invalidation ──────────────────────────────────────
  // The realtime gateway emits `notification:new` whenever a notification is
  // persisted for this tenant (see `src/lib/realtime/notify.ts` callers).
  // When the user is an admin (the useRealtime hook keys off `user.id` from
  // the admin store), this subscription invalidates the portal-notifications
  // query, causing an immediate refetch — far faster than the old 30s poll.
  // For pure-portal users the hook is a no-op (user.id is null), and the
  // refetchOnWindowFocus + manual refresh path remains.
  useRealtime({
    "notification:new": useCallback(() => {
      queryClient.invalidateQueries({ queryKey: ["portal-notifications"] });
    }, [queryClient]),
  });

  const items = notifsQ.data?.items || [];
  const unreadCount = items.filter((n) => !n.read).length;

  const markAsRead = useCallback(
    async (id: string) => {
      setMarkingRead(id);
      try {
        const r = await fetch(`/api/portal/notifications/${id}/read`, { method: "PUT" });
        if (!r.ok) throw new Error("Failed to mark as read");
        queryClient.invalidateQueries({ queryKey: ["portal-notifications"] });
      } catch {
        // silent fail
      } finally {
        setMarkingRead(null);
      }
    },
    [queryClient]
  );

  const markAllRead = useCallback(async () => {
    // 2b2-F2 — replace N parallel PUTs (each scanning the full partner
    // notification list) with a single POST to the bulk endpoint. The
    // backend runs one `UPDATE notifications SET read_at = now(),
    // read = true WHERE partner_id = $1 AND tenant_id = $2 AND
    // type IN (PORTAL_SAFE_TYPES) AND read = false` — one statement,
    // one round-trip, regardless of how many unread notifications the
    // partner has. The `updated` count is returned in the response so
    // the UI can show "Marked N as read" (we currently invalidate the
    // query for the list refetch — same UX, far less load).
    try {
      await fetch("/api/portal/notifications/read-all", { method: "POST" });
    } catch {
      // silent fail — the query invalidation below still fires so the
      // UI reflects whatever the server actually updated.
    }
    queryClient.invalidateQueries({ queryKey: ["portal-notifications"] });
  }, [queryClient]);

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            <span className="text-gradient-emerald">{t("portal-notif-title")}</span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {notifsQ.data
              ? t("portal-notif-count")
                  .replace("{n}", String(items.length))
                  .replace("{unread}", unreadCount > 0 ? t("portal-notif-unread").replace("{n}", String(unreadCount)) : "")
              : t("portal-notif-loading")}
          </p>
        </div>
        {unreadCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={markAllRead}
            className="smooth"
          >
            <MailOpen className="size-4 mr-1.5" />
            {t("portal-notif-mark-all")}
          </Button>
        )}
      </div>

      {/* Notification list */}
      <div className="card-premium overflow-hidden">
        {notifsQ.isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <EmptyNotifications />
        ) : (
          <div className="max-h-[calc(100vh-280px)] overflow-y-auto custom-scroll divide-y divide-border/60">
            {items.map((notif) => {
              const category = getNotifCategory(notif.type);
              const config = CATEGORY_CONFIG[category];
              const Icon = config.icon;
              const isMarking = markingRead === notif.id;

              return (
                <div
                  key={notif.id}
                  className={cn(
                    "flex items-start gap-3 p-4 smooth hover:bg-accent/40 transition-colors",
                    !notif.read && "bg-primary/[0.03]"
                  )}
                >
                  {/* Category icon */}
                  <div className={cn("size-9 rounded-full flex items-center justify-center shrink-0 mt-0.5", config.bg)}>
                    <Icon className={cn("size-4", config.color)} />
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className={cn("text-sm leading-snug", !notif.read ? "font-semibold" : "font-medium text-foreground/80")}>
                          {notif.title}
                        </p>
                        <p className="text-sm text-muted-foreground mt-0.5 leading-relaxed line-clamp-2">
                          {notif.message}
                        </p>
                      </div>

                      {/* Unread indicator */}
                      {!notif.read && (
                        <div className="size-2.5 rounded-full bg-primary shrink-0 mt-1.5 ring-2 ring-primary/20" />
                      )}
                    </div>

                    {/* Meta row */}
                    <div className="flex items-center gap-3 mt-2">
                      <span className="text-xs text-muted-foreground tabular">
                        {fmtRelative(notif.created_at)}
                      </span>
                      <Badge variant="outline" className="text-xs capitalize px-1.5 py-0">
                        {notif.type.replace(/_/g, " ")}
                      </Badge>

                      {/* Action link — rewritten to portal navigation */}
                      {notif.action_url && (() => {
                        const target = portalViewForUrl(notif.action_url, notif.type);
                        if (!target) return null;
                        return (
                          <button
                            type="button"
                            onClick={() => {
                              if (!notif.read) markAsRead(notif.id);
                              setView(target);
                            }}
                            className="text-xs text-primary hover:underline inline-flex items-center gap-0.5"
                          >
                            {notif.action_label || t("portal-notif-action-view")}
                            <ExternalLink className="size-3" />
                          </button>
                        );
                      })()}
                    </div>
                  </div>

                  {/* Mark as read button */}
                  {!notif.read && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0 smooth hover:bg-accent hover:text-primary"
                      onClick={() => markAsRead(notif.id)}
                      disabled={isMarking}
                      aria-label={t("portal-notif-mark-as-read")}
                    >
                      {isMarking ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Mail className="size-4" />
                      )}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyNotifications() {
  const t = useT();
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center px-6">
      <div className="size-16 rounded-full bg-gradient-to-br from-primary/15 to-primary/5 flex items-center justify-center mb-4">
        <Inbox className="size-7 text-primary" />
      </div>
      <p className="text-base font-semibold">{t("portal-notif-empty-title")}</p>
      <p className="text-sm text-muted-foreground mt-1 max-w-sm">
        {t("portal-notif-empty-desc")}
      </p>
    </div>
  );
}
