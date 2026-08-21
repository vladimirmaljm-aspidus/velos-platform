"use client";

import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  FileText,
  FolderOpen,
  Package,
  Clock,
  ArrowRight,
  Lock,
  Crown,
  Shield,
  Boxes,
  Briefcase,
  User,
  Building2,
  Loader2,
  Inbox,
  ShoppingCart,
  ShieldCheck,
  ShieldAlert,
  Bell,
  Receipt,
  FileCheck,
  Activity,
  Mail,
  MessageSquare,
  CreditCard,
  Info,
  AlertTriangle,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { useAppStore } from "@/lib/store/app-store";
import { useT } from "@/lib/i18n/store";
import { fmtMoney, fmtDate, fmtRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type {
  PortalAccess,
  PortalTier,
  Offer,
  SharedDocument,
  Partner,
  OfferStatus,
  Invoice,
  Proforma,
  InvoiceStatus,
  ProformaStatus,
  Notification,
  NotificationType,
} from "@/lib/supabase/types";

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

const STATUS_STYLES: Record<OfferStatus, string> = {
  draft: "bg-secondary text-secondary-foreground",
  sent: "border-transparent bg-chart-1 text-white",
  accepted: "border-transparent bg-emerald-600 text-white",
  rejected: "border-transparent bg-destructive text-destructive-foreground",
  expired: "bg-muted text-muted-foreground",
};

const INVOICE_STATUS_STYLES: Record<InvoiceStatus, string> = {
  draft: "bg-secondary text-secondary-foreground",
  sent: "border-transparent bg-chart-1 text-white",
  paid: "border-transparent bg-emerald-600 text-white",
  overdue: "border-transparent bg-destructive text-destructive-foreground",
  cancelled: "bg-muted text-muted-foreground",
};

const PROFORMA_STATUS_STYLES: Record<ProformaStatus, string> = {
  draft: "bg-secondary text-secondary-foreground",
  sent: "border-transparent bg-chart-1 text-white",
  viewed: "border-transparent bg-chart-1 text-white",
  accepted: "border-transparent bg-emerald-600 text-white",
  paid: "border-transparent bg-emerald-700 text-white",
  expired: "border-transparent bg-destructive text-destructive-foreground",
};

const DOC_CATEGORY_STYLES: Record<string, string> = {
  contract: "border-transparent bg-chart-1 text-white",
  invoice: "border-transparent bg-chart-4 text-white",
  spec: "border-transparent bg-chart-2 text-white",
  other: "bg-secondary text-secondary-foreground",
};

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

const NOTIF_CATEGORY_CONFIG: Record<
  string,
  { icon: React.ComponentType<{ className?: string }>; color: string; bg: string }
> = {
  info: { icon: Info, color: "text-primary", bg: "bg-primary/10" },
  warning: { icon: AlertTriangle, color: "text-amber-600", bg: "bg-amber-500/10" },
  success: { icon: CheckCircle2, color: "text-emerald-600", bg: "bg-emerald-500/10" },
  error: { icon: XCircle, color: "text-destructive", bg: "bg-destructive/10" },
};

export function PortalDashboard() {
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
    enabled: !!portalAccess?.can_view_profile,
  });

  const offersQ = useQuery<{ items: Offer[]; total: number }>({
    queryKey: ["portal-offers"],
    queryFn: async () => {
      const r = await fetch("/api/portal/offers");
      if (!r.ok) throw new Error("Failed to load offers");
      return r.json();
    },
    enabled: !!portalAccess?.can_view_offers,
  });

  const docsQ = useQuery<{ items: SharedDocument[]; total: number }>({
    queryKey: ["portal-documents"],
    queryFn: async () => {
      const r = await fetch("/api/portal/documents");
      if (!r.ok) throw new Error("Failed to load documents");
      return r.json();
    },
    enabled: !!portalAccess?.can_view_documents,
  });

  const catalogQ = useQuery<{ items: unknown[]; total: number }>({
    queryKey: ["portal-catalog"],
    queryFn: async () => {
      const r = await fetch("/api/portal/catalog");
      if (!r.ok) throw new Error("Failed to load catalog");
      return r.json();
    },
    enabled: !!portalAccess?.can_view_catalog,
  });

  const invoicesQ = useQuery<{ items: Invoice[]; total: number }>({
    queryKey: ["portal-invoices"],
    queryFn: async () => {
      const r = await fetch("/api/portal/invoices");
      if (!r.ok) throw new Error("Failed to load invoices");
      return r.json();
    },
    enabled: !!portalAccess?.can_view_invoices,
  });

  const proformasQ = useQuery<{ items: Proforma[]; total: number }>({
    queryKey: ["portal-proformas"],
    queryFn: async () => {
      const r = await fetch("/api/portal/proformas");
      if (!r.ok) throw new Error("Failed to load proformas");
      return r.json();
    },
    enabled: !!portalAccess?.can_view_invoices,
  });

  const notifsQ = useQuery<{ items: Notification[]; total: number }>({
    queryKey: ["portal-notifications"],
    queryFn: async () => {
      const r = await fetch("/api/portal/notifications");
      if (!r.ok) throw new Error("Failed to load notifications");
      return r.json();
    },
    refetchInterval: 30_000,
  });

  if (!portalAccess) return null;

  const tier = portalAccess.tier;
  const TierIcon = TIER_META[tier].icon;
  const partner = profileQ.data?.partner;
  const partnerName = partner?.name || t("portal-default-client");
  const entityType = partner?.entity_type === "individual" ? t("portal-individual") : t("portal-company");

  const recentOffers = (offersQ.data?.items || []).slice(0, 5);
  const recentDocs = (docsQ.data?.items || []).slice(0, 5);
  const recentInvoices = (invoicesQ.data?.items || []).slice(0, 5);
  const recentProformas = (proformasQ.data?.items || []).slice(0, 5);
  const recentNotifications = (notifsQ.data?.items || []).slice(0, 5);

  const activeOffersCount =
    offersQ.data?.items?.filter((o) => o.status === "sent" || o.status === "draft")
      .length ?? 0;

  const unreadNotifCount = notifsQ.data?.items?.filter((n) => !n.read).length ?? 0;
  const overdueInvoicesCount =
    invoicesQ.data?.items?.filter((i) => i.status === "overdue").length ?? 0;
  const unpaidInvoicesCount =
    invoicesQ.data?.items?.filter((i) => i.status === "sent" || i.status === "overdue")
      .length ?? 0;

  // Build activity timeline from notifications
  const activityItems = buildActivityTimeline(
    recentNotifications,
    recentInvoices,
    recentProformas,
    recentOffers
  );

  // KYC alert visibility — show if not exempt and partner KYC is pending/not submitted
  const kycPending =
    !portalAccess.exempt_kyc &&
    (partner?.kyc_status === "not_submitted" || partner?.kyc_status === "pending");

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Welcome hero card with mesh + gradient border */}
      <div className="border-gradient shadow-soft-lg">
        <div className="relative bg-card rounded-[calc(var(--radius-xl)-1px)] overflow-hidden">
          <div className="absolute inset-0 bg-mesh-portal opacity-70" />
          <div className="absolute top-0 right-0 h-32 w-32 bg-primary/10 blur-3xl rounded-full" />
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
                  {t("portal-welcome-back")}{" "}
                  <span className="text-gradient-emerald">
                    {partnerName.split(" ")[0]}
                  </span>
                </h1>
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  <Badge className={cn("gap-1", TIER_META[tier].className)}>
                    <TierIcon className="size-3" />
                    {t(TIER_META[tier].labelKey)}
                  </Badge>
                  <Badge variant="outline" className="gap-1 bg-card/60">
                    {partner?.entity_type === "individual" ? (
                      <User className="size-3" />
                    ) : (
                      <Building2 className="size-3" />
                    )}
                    {entityType}
                  </Badge>
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
              <div className="flex flex-wrap gap-2">
                {portalAccess.can_view_offers && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setView("portal-offers")}
                    className="bg-card/60 backdrop-blur-sm smooth hover:shadow-soft-md"
                  >
                    <FileText className="size-4 mr-1" /> {t("portal-action-view-offers")}
                  </Button>
                )}
                {portalAccess.can_view_catalog && (
                  <Button
                    size="sm"
                    onClick={() => setView("portal-catalog")}
                    className="smooth hover:shadow-soft-md"
                  >
                    <Package className="size-4 mr-1" /> {t("portal-action-browse-catalog")}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* KYC pending alert */}
      {kycPending && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-4 sm:p-5 shadow-soft">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              <div className="size-10 rounded-xl bg-amber-500/15 text-amber-700 dark:text-amber-400 flex items-center justify-center shrink-0">
                <ShieldAlert className="size-5" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold">
                  {t("portal-kyc-alert-title")}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {partner?.kyc_status === "not_submitted"
                    ? t("portal-kyc-alert-not-submitted")
                    : t("portal-kyc-alert-pending")}
                </p>
              </div>
            </div>
            {partner?.kyc_status === "not_submitted" && (
              <Button
                size="sm"
                onClick={() => setView("portal-kyc")}
                className="bg-amber-600 hover:bg-amber-700 text-white shrink-0 smooth hover:shadow-soft-md"
              >
                <ShieldCheck className="size-4 mr-1" /> {t("portal-kyc-alert-start")}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Overdue invoices alert */}
      {overdueInvoicesCount > 0 && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/[0.06] p-4 sm:p-5 shadow-soft">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              <div className="size-10 rounded-xl bg-destructive/15 text-destructive flex items-center justify-center shrink-0">
                <AlertTriangle className="size-5" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold">
                  {t("portal-overdue-alert-title").replace("{n}", String(overdueInvoicesCount))}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t("portal-overdue-alert-desc")}
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setView("portal-invoices")}
              className="border-destructive/30 text-destructive hover:bg-destructive/10 shrink-0 smooth"
            >
              <Receipt className="size-4 mr-1" /> {t("portal-action-view-invoices")}
            </Button>
          </div>
        </div>
      )}

      {/* KPI cards — expanded to 6 with invoice, proforma, and notification counts */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        {portalAccess.can_view_offers ? (
          <KpiPremium
            label={t("portal-kpi-active-offers")}
            value={offersQ.isLoading ? "—" : activeOffersCount}
            sub={t("portal-kpi-total").replace("{n}", String(offersQ.data?.total ?? 0))}
            icon={FileText}
          />
        ) : (
          <LockedKpi label={t("portal-kpi-active-offers")} icon={FileText} t={t} />
        )}

        {portalAccess.can_view_invoices ? (
          <KpiPremium
            label={t("portal-kpi-invoices")}
            value={invoicesQ.isLoading ? "—" : invoicesQ.data?.total ?? 0}
            sub={unpaidInvoicesCount > 0 ? t("portal-kpi-unpaid").replace("{n}", String(unpaidInvoicesCount)) : t("portal-kpi-all-settled")}
            icon={Receipt}
            accent={unpaidInvoicesCount > 0 ? "text-destructive" : undefined}
          />
        ) : (
          <LockedKpi label={t("portal-kpi-invoices")} icon={Receipt} t={t} />
        )}

        {portalAccess.can_view_invoices ? (
          <KpiPremium
            label={t("portal-kpi-proformas")}
            value={proformasQ.isLoading ? "—" : proformasQ.data?.total ?? 0}
            sub={t("portal-kpi-proformas-sub")}
            icon={FileCheck}
          />
        ) : (
          <LockedKpi label={t("portal-kpi-proformas")} icon={FileCheck} t={t} />
        )}

        <KpiPremium
          label={t("portal-kpi-notifications")}
          value={notifsQ.isLoading ? "—" : unreadNotifCount}
          sub={t("portal-kpi-total").replace("{n}", String(notifsQ.data?.total ?? 0))}
          icon={Bell}
          accent={unreadNotifCount > 0 ? "text-primary" : undefined}
          onClick={() => setView("portal-notifications")}
        />

        {portalAccess.can_view_documents ? (
          <KpiPremium
            label={t("portal-kpi-documents")}
            value={docsQ.isLoading ? "—" : docsQ.data?.total ?? 0}
            sub={t("portal-kpi-documents-sub")}
            icon={FolderOpen}
          />
        ) : (
          <LockedKpi label={t("portal-kpi-documents")} icon={FolderOpen} t={t} />
        )}

        <KpiPremium
          label={t("portal-kpi-last-login")}
          value={fmtRelative(portalAccess.last_login_at)}
          sub={portalAccess.last_login_ip || undefined}
          icon={Clock}
          accent="text-amber-600"
        />
      </div>

      {/* Recent offers + documents */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent offers */}
        <div className="card-premium">
          <div className="flex flex-row items-center justify-between p-5 pb-3">
            <div>
              <h3 className="text-base font-semibold tracking-tight">{t("portal-recent-offers")}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("portal-recent-offers-sub")}
              </p>
            </div>
            {portalAccess.can_view_offers && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setView("portal-offers")}
                className="text-primary"
              >
                {t("portal-action-view-all")} <ArrowRight className="size-3.5 ml-1" />
              </Button>
            )}
          </div>
          <div className="px-2 pb-2">
            {!portalAccess.can_view_offers ? (
              <LockedNotice t={t} />
            ) : offersQ.isLoading ? (
              <LoadingRow />
            ) : recentOffers.length === 0 ? (
              <EmptyRow
                icon={Inbox}
                title={t("portal-empty-offers")}
                desc={t("portal-empty-offers-desc")}
              />
            ) : (
              <div className="space-y-1 max-h-80 overflow-y-auto custom-scroll">
                {recentOffers.map((o) => (
                  <button
                    key={o.id}
                    onClick={() => setView("portal-offers")}
                    className="w-full flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-accent smooth"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground shrink-0 tabular">
                          {o.number}
                        </span>
                        <Badge
                          className={cn("text-xs px-1.5 py-0 capitalize", STATUS_STYLES[o.status])}
                        >
                          {o.status}
                        </Badge>
                      </div>
                      <p className="text-sm font-medium truncate mt-0.5">{o.subject}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-semibold tabular">
                        {fmtMoney(o.total, o.currency)}
                      </p>
                      <p className="text-xs text-muted-foreground tabular">
                        {fmtDate(o.created_at)}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Recent documents */}
        <div className="card-premium">
          <div className="flex flex-row items-center justify-between p-5 pb-3">
            <div>
              <h3 className="text-base font-semibold tracking-tight">{t("portal-recent-documents")}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("portal-recent-documents-sub")}
              </p>
            </div>
            {portalAccess.can_view_documents && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setView("portal-documents")}
                className="text-primary"
              >
                {t("portal-action-view-all")} <ArrowRight className="size-3.5 ml-1" />
              </Button>
            )}
          </div>
          <div className="px-2 pb-2">
            {!portalAccess.can_view_documents ? (
              <LockedNotice t={t} />
            ) : docsQ.isLoading ? (
              <LoadingRow />
            ) : recentDocs.length === 0 ? (
              <EmptyRow
                icon={FolderOpen}
                title={t("portal-empty-docs")}
                desc={t("portal-empty-docs-desc")}
              />
            ) : (
              <div className="space-y-1 max-h-80 overflow-y-auto custom-scroll">
                {recentDocs.map((d) => (
                  <div
                    key={d.id}
                    className="flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 hover:bg-accent smooth"
                  >
                    <div className="min-w-0 flex-1 flex items-center gap-3">
                      <div className="size-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                        <FileText className="size-4 text-primary" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{d.filename}</p>
                        <p className="text-xs text-muted-foreground tabular">
                          {fmtDate(d.created_at)}
                        </p>
                      </div>
                    </div>
                    <Badge
                      className={cn(
                        "text-xs px-1.5 py-0 capitalize",
                        DOC_CATEGORY_STYLES[d.category]
                      )}
                    >
                      {d.category}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Recent invoices + proformas */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent invoices */}
        <div className="card-premium">
          <div className="flex flex-row items-center justify-between p-5 pb-3">
            <div>
              <h3 className="text-base font-semibold tracking-tight">{t("portal-recent-invoices")}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("portal-recent-invoices-sub")}
              </p>
            </div>
            {portalAccess.can_view_invoices && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setView("portal-invoices")}
                className="text-primary"
              >
                {t("portal-action-view-all")} <ArrowRight className="size-3.5 ml-1" />
              </Button>
            )}
          </div>
          <div className="px-2 pb-2">
            {!portalAccess.can_view_invoices ? (
              <LockedNotice t={t} />
            ) : invoicesQ.isLoading ? (
              <LoadingRow />
            ) : recentInvoices.length === 0 ? (
              <EmptyRow
                icon={Receipt}
                title={t("portal-empty-invoices")}
                desc={t("portal-empty-invoices-desc")}
              />
            ) : (
              <div className="space-y-1 max-h-80 overflow-y-auto custom-scroll">
                {recentInvoices.map((inv) => (
                  <button
                    key={inv.id}
                    onClick={() => setView("portal-invoices")}
                    className="w-full flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-accent smooth"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground shrink-0 tabular">
                          {inv.number}
                        </span>
                        <Badge
                          className={cn(
                            "text-xs px-1.5 py-0 capitalize",
                            INVOICE_STATUS_STYLES[inv.status]
                          )}
                        >
                          {inv.status}
                        </Badge>
                      </div>
                      <p className="text-sm font-medium truncate mt-0.5">{inv.subject}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-semibold tabular">
                        {fmtMoney(inv.total, inv.currency)}
                      </p>
                      <p className="text-xs text-muted-foreground tabular">
                        {t("portal-due-label").replace("{date}", fmtDate(inv.due_date))}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Recent proformas */}
        <div className="card-premium">
          <div className="flex flex-row items-center justify-between p-5 pb-3">
            <div>
              <h3 className="text-base font-semibold tracking-tight">{t("portal-recent-proformas")}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("portal-recent-proformas-sub")}
              </p>
            </div>
            {portalAccess.can_view_invoices && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setView("portal-proformas")}
                className="text-primary"
              >
                {t("portal-action-view-all")} <ArrowRight className="size-3.5 ml-1" />
              </Button>
            )}
          </div>
          <div className="px-2 pb-2">
            {!portalAccess.can_view_invoices ? (
              <LockedNotice t={t} />
            ) : proformasQ.isLoading ? (
              <LoadingRow />
            ) : recentProformas.length === 0 ? (
              <EmptyRow
                icon={FileCheck}
                title={t("portal-empty-proformas")}
                desc={t("portal-empty-proformas-desc")}
              />
            ) : (
              <div className="space-y-1 max-h-80 overflow-y-auto custom-scroll">
                {recentProformas.map((pro) => (
                  <button
                    key={pro.id}
                    onClick={() => setView("portal-proformas")}
                    className="w-full flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-accent smooth"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground shrink-0 tabular">
                          {pro.number}
                        </span>
                        <Badge
                          className={cn(
                            "text-xs px-1.5 py-0 capitalize",
                            PROFORMA_STATUS_STYLES[pro.status]
                          )}
                        >
                          {pro.status}
                        </Badge>
                      </div>
                      <p className="text-sm font-medium truncate mt-0.5">{pro.subject}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-semibold tabular">
                        {fmtMoney(pro.total, pro.currency)}
                      </p>
                      <p className="text-xs text-muted-foreground tabular">
                        {fmtDate(pro.issue_date)}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Activity timeline + Quick actions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Activity timeline */}
        <div className="card-premium">
          <div className="flex flex-row items-center justify-between p-5 pb-3">
            <div>
              <h3 className="text-base font-semibold tracking-tight">{t("portal-recent-activity")}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("portal-recent-activity-sub")}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setView("portal-notifications")}
              className="text-primary"
            >
              {t("portal-action-view-all")} <ArrowRight className="size-3.5 ml-1" />
            </Button>
          </div>
          <div className="px-2 pb-2">
            {activityItems.length === 0 ? (
              <EmptyRow
                icon={Activity}
                title={t("portal-empty-activity")}
                desc={t("portal-empty-activity-desc")}
              />
            ) : (
              <div className="space-y-0 max-h-80 overflow-y-auto custom-scroll">
                {activityItems.slice(0, 8).map((item, idx) => {
                  const Icon = item.icon;
                  return (
                    <div
                      key={idx}
                      className="flex items-start gap-3 px-3 py-2.5 hover:bg-accent/50 smooth rounded-lg"
                    >
                      <div className={cn("size-8 rounded-full flex items-center justify-center shrink-0 mt-0.5", item.bg)}>
                        <Icon className={cn("size-3.5", item.color)} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium leading-snug">{item.title}</p>
                        <p className="text-xs text-muted-foreground mt-0.5 tabular">
                          {fmtRelative(item.date)}
                        </p>
                      </div>
                      {item.action && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs text-primary shrink-0 h-7 px-2"
                          onClick={() => setView(item.action!)}
                        >
                          {t("portal-action-view")}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Quick links */}
        <div className="card-premium">
          <div className="p-5 pb-3">
            <h3 className="text-base font-semibold tracking-tight">{t("portal-quick-links")}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("portal-quick-links-sub")}
            </p>
          </div>
          <div className="px-2 pb-2">
            <div className="grid grid-cols-2 gap-2">
              <QuickLink
                title={t("portal-ql-view-offers")}
                desc={t("portal-ql-view-offers-desc")}
                icon={FileText}
                onClick={() => setView("portal-offers")}
                locked={!portalAccess.can_view_offers}
              />
              <QuickLink
                title={t("portal-ql-submit-rfq")}
                desc={t("portal-ql-submit-rfq-desc")}
                icon={ShoppingCart}
                onClick={() => setView("portal-rfq")}
                locked={!portalAccess.can_submit_rfq}
              />
              <QuickLink
                title={t("portal-ql-view-docs")}
                desc={t("portal-ql-view-docs-desc")}
                icon={FolderOpen}
                onClick={() => setView("portal-documents")}
                locked={!portalAccess.can_view_documents}
              />
              <QuickLink
                title={t("portal-ql-browse-catalog")}
                desc={t("portal-ql-browse-catalog-desc")}
                icon={Package}
                onClick={() => setView("portal-catalog")}
                locked={!portalAccess.can_view_catalog}
              />
              <QuickLink
                title={t("portal-ql-invoices")}
                desc={t("portal-ql-invoices-desc")}
                icon={CreditCard}
                onClick={() => setView("portal-invoices")}
                locked={!portalAccess.can_view_invoices}
              />
              <QuickLink
                title={t("portal-ql-proformas")}
                desc={t("portal-ql-proformas-desc")}
                icon={FileCheck}
                onClick={() => setView("portal-proformas")}
                locked={!portalAccess.can_view_invoices}
              />
              <QuickLink
                title={t("portal-ql-notifications")}
                desc={t("portal-unread").replace("{n}", String(unreadNotifCount))}
                icon={Bell}
                onClick={() => setView("portal-notifications")}
                highlight={unreadNotifCount > 0}
              />
              <QuickLink
                title={t("portal-ql-messages")}
                desc={t("portal-ql-messages-desc")}
                icon={MessageSquare}
                onClick={() => setView("portal-messages")}
              />
              <QuickLink
                title={t("portal-ql-my-profile")}
                desc={t("portal-ql-my-profile-desc")}
                icon={User}
                onClick={() => setView("portal-profile")}
              />
              {!portalAccess.exempt_kyc && (
                <QuickLink
                  title={t("portal-ql-complete-kyc")}
                  desc={t("portal-ql-complete-kyc-desc")}
                  icon={ShieldCheck}
                  onClick={() => setView("portal-kyc")}
                  highlight={kycPending}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Activity timeline builder ────────────────────────────────────────────────

interface ActivityItem {
  title: string;
  date: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  bg: string;
  action?: ViewKey;
}

function buildActivityTimeline(
  notifications: Notification[],
  invoices: Invoice[],
  proformas: Proforma[],
  offers: Offer[]
): ActivityItem[] {
  const items: ActivityItem[] = [];

  // From notifications
  for (const n of notifications) {
    const cat = getNotifCategory(n.type);
    const cfg = NOTIF_CATEGORY_CONFIG[cat];
    items.push({
      title: n.title,
      date: n.created_at,
      icon: cfg.icon,
      color: cfg.color,
      bg: cfg.bg,
      action: inferActionFromNotif(n),
    });
  }

  // From invoices (recent status changes)
  for (const inv of invoices) {
    if (inv.status === "overdue") {
      items.push({
        title: `Invoice ${inv.number} is overdue`,
        date: inv.due_date,
        icon: AlertTriangle,
        color: "text-destructive",
        bg: "bg-destructive/10",
        action: "portal-invoices",
      });
    } else if (inv.status === "paid") {
      items.push({
        title: `Invoice ${inv.number} has been paid`,
        date: inv.paid_at || inv.updated_at,
        icon: CheckCircle2,
        color: "text-emerald-600",
        bg: "bg-emerald-500/10",
        action: "portal-invoices",
      });
    }
  }

  // From proformas
  for (const pro of proformas) {
    if (pro.status === "sent") {
      items.push({
        title: `Proforma ${pro.number} sent for review`,
        date: pro.sent_at || pro.created_at,
        icon: FileCheck,
        color: "text-primary",
        bg: "bg-primary/10",
        action: "portal-proformas",
      });
    }
  }

  // From offers
  for (const o of offers) {
    if (o.status === "sent") {
      items.push({
        title: `Offer ${o.number} is ready for review`,
        date: o.updated_at,
        icon: FileText,
        color: "text-primary",
        bg: "bg-primary/10",
        action: "portal-offers",
      });
    } else if (o.status === "accepted") {
      items.push({
        title: `Offer ${o.number} was accepted`,
        date: o.updated_at,
        icon: CheckCircle2,
        color: "text-emerald-600",
        bg: "bg-emerald-500/10",
        action: "portal-offers",
      });
    }
  }

  // Sort by date descending
  items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // Deduplicate by title
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.title)) return false;
    seen.add(item.title);
    return true;
  });
}

function inferActionFromNotif(n: Notification): ViewKey | undefined {
  const type = n.type;
  if (type.startsWith("offer_")) return "portal-offers";
  if (type.startsWith("invoice_")) return "portal-invoices";
  if (type.startsWith("kyc_")) return "portal-kyc";
  if (type.startsWith("rfq_")) return "portal-rfq";
  if (type === "document_shared") return "portal-documents";
  if (type === "portal_message") return "portal-messages";
  if (type.startsWith("portal_")) return "portal-notifications";
  if (type === "low_stock_alert") return "portal-catalog";
  if (type.startsWith("task_")) return "portal-notifications";
  return "portal-notifications";
}

// ─── KPI card components ──────────────────────────────────────────────────────

function KpiPremium({
  label,
  value,
  sub,
  icon: Icon,
  accent,
  onClick,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  accent?: string;
  onClick?: () => void;
}) {
  return (
    <div
      className={cn(
        "card-premium p-5 group",
        onClick && "cursor-pointer hover:border-primary/30 smooth hover:shadow-soft-md"
      )}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground truncate">{label}</p>
          <p className={cn("text-2xl font-semibold tracking-tight mt-1.5 tabular truncate", accent)}>
            {value}
          </p>
          {sub && <p className="text-xs text-muted-foreground mt-1 truncate">{sub}</p>}
        </div>
        <div
          className={cn(
            "size-10 rounded-xl flex items-center justify-center shrink-0 smooth group-hover:scale-110",
            accent ? "bg-amber-500/15 text-amber-600" : "bg-primary/10 text-primary"
          )}
        >
          <Icon className="size-5" />
        </div>
      </div>
    </div>
  );
}

function LockedKpi({
  label,
  icon: Icon,
  t,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  t: (k: string) => string;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border/60 bg-muted/30 p-5 opacity-80">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground truncate">{label}</p>
          <div className="flex items-center gap-1.5 mt-2.5">
            <Lock className="size-3.5 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">{t("portal-locked")}</span>
          </div>
        </div>
        <div className="size-10 rounded-xl bg-muted flex items-center justify-center shrink-0 text-muted-foreground">
          <Icon className="size-4" />
        </div>
      </div>
    </div>
  );
}

function LockedNotice({ t }: { t: (k: string) => string }) {
  return (
    <div className="rounded-lg border border-dashed border-border/60 bg-muted/30 p-6 text-center m-2">
      <div className="size-12 rounded-full bg-muted flex items-center justify-center mx-auto mb-3">
        <Lock className="size-5 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">{t("portal-section-locked")}</p>
      <p className="text-xs text-muted-foreground mt-1">
        {t("portal-section-locked-desc")}
      </p>
    </div>
  );
}

function LoadingRow() {
  return (
    <div className="flex items-center justify-center py-8">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </div>
  );
}

function EmptyRow({
  icon: Icon,
  title,
  desc,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  desc: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center m-2">
      <div className="size-12 rounded-full bg-gradient-to-br from-primary/10 to-primary/5 flex items-center justify-center mb-3">
        <Icon className="size-5 text-primary" />
      </div>
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground mt-1 max-w-xs">{desc}</p>
    </div>
  );
}

function QuickLink({
  title,
  desc,
  icon: Icon,
  onClick,
  locked,
  highlight,
}: {
  title: string;
  desc: string;
  icon: React.ComponentType<{ className?: string }>;
  onClick: () => void;
  locked?: boolean;
  highlight?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={locked}
      className={cn(
        "group relative text-left rounded-xl p-4 smooth overflow-hidden border",
        locked
          ? "border-dashed border-border/60 bg-muted/30 opacity-70 cursor-not-allowed"
          : highlight
            ? "border-amber-500/30 bg-amber-500/[0.06] shadow-soft hover:shadow-soft-md hover:-translate-y-0.5"
            : "border-border/60 bg-card shadow-soft hover:shadow-soft-md hover:-translate-y-0.5 hover:border-primary/30"
      )}
    >
      {!locked && (
        <div className="absolute top-0 right-0 h-20 w-20 bg-primary/[0.06] blur-2xl rounded-full opacity-0 group-hover:opacity-100 smooth" />
      )}
      <div className="relative flex items-center gap-3">
        <div
          className={cn(
            "size-9 rounded-lg flex items-center justify-center shrink-0 smooth group-hover:scale-105",
            locked
              ? "bg-muted text-muted-foreground"
              : highlight
                ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                : "bg-gradient-to-br from-primary/15 to-primary/5 text-primary"
          )}
        >
          {locked ? <Lock className="size-4" /> : <Icon className="size-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold truncate">{title}</p>
          <p className="text-xs text-muted-foreground truncate mt-0.5">{desc}</p>
        </div>
      </div>
    </button>
  );
}

// Type import for ViewKey used in the activity builder
import type { ViewKey } from "@/lib/store/app-store";
