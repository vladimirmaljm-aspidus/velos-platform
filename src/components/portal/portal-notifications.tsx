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

/** Map a server-issued action_url (often an admin path) to a portal ViewKey. */
function portalViewForUrl(url: string, type: NotificationType): ViewKey | null {
  const u = url.toLowerCase();
  if (u.includes("/portal-access") || type === "portal_message") return "portal-messages";
  if (u.includes("/logistics")) return "portal-logistics";
  if (u.includes("/rfq") || type === "rfq_received" || type === "rfq_quoted") return "portal-rfq";
  if (u.includes("/kyc") || type.startsWith("kyc_")) return "portal-kyc";
  if (u.includes("/invoice") || type.startsWith("invoice_")) return "portal-invoices";
  if (u.includes("/offer") || type.startsWith("offer_")) return "portal-offers";
  if (u.includes("/proforma") || type.startsWith("proforma_")) return "portal-proformas";
  if (u.includes("/document") || type === "document_shared") return "portal-documents";
  if (u.includes("/messages")) return "portal-messages";
  return null;
}

/** Map notification type to a visual category */
function getNotifCategory(type: NotificationType): "info" | "warning" | "success" | "error" {
  if (type.startsWith("kyc_rejected") || type === "invoice_overdue" || type === "low_stock_alert") return "error";
  if (type.startsWith("kyc_submitted") || type === "rfq_received" || type === "task_due_soon") return "warning";
  if (
    type.startsWith("kyc_approved") ||
    type === "invoice_paid" ||
    type === "offer_accepted" ||
    type === "rfq_quoted" ||
    type === "portal_access_approved"
  )
    return "success";
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

  const notifsQ = useQuery<{ items: Notification[]; total: number }>({
    queryKey: ["portal-notifications"],
    queryFn: async () => {
      const r = await fetch("/api/portal/notifications");
      if (!r.ok) throw new Error("Failed to load notifications");
      return r.json();
    },
    refetchInterval: 30_000, // auto-refresh every 30 seconds
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
    const unread = items.filter((n) => !n.read);
    await Promise.all(unread.map((n) => fetch(`/api/portal/notifications/${n.id}/read`, { method: "PUT" })));
    queryClient.invalidateQueries({ queryKey: ["portal-notifications"] });
  }, [items, queryClient]);

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
                      <Badge variant="outline" className="text-[10px] capitalize px-1.5 py-0">
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
