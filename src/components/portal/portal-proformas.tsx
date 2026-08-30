"use client";

import { useState, useEffect, useMemo } from "react";
import { useQuery, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  FileText,
  Search,
  Eye,
  Download,
  Lock,
  Inbox,
  Phone,
  Loader2,
  ChevronDown,
  Calendar,
  Clock,
  CheckCircle2,
  XCircle,
  Crown,
  AlertTriangle,
  DollarSign,
  Hourglass,
} from "lucide-react";
import { useAppStore } from "@/lib/store/app-store";
import { useT } from "@/lib/i18n/store";
import { fmtMoney, fmtDate, fmtMoneyDetailed } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { Proforma, ProformaStatus, OfferLineItem, PortalTier } from "@/lib/supabase/types";
import { useDebounced } from "@/lib/hooks/use-debounced";

const STATUS_STYLES: Record<ProformaStatus, string> = {
  draft: "bg-secondary text-secondary-foreground",
  sent: "border-transparent bg-chart-1 text-white",
  // PORTAL-L4 — "viewed" was identical to "sent" (both bg-chart-1 solid).
  // A partner scanning the list could not tell "I've seen this proforma"
  // apart from "this is freshly issued, awaiting first view". The 80%
  // opacity mute keeps it in the same visual family (chart-1 / blue) but
  // signals that the proforma has been opened by the client.
  viewed: "border-transparent bg-chart-1/80 text-white",
  accepted: "border-transparent bg-emerald-600 text-white",
  paid: "border-transparent bg-emerald-700 text-white",
  expired: "border-transparent bg-destructive text-destructive-foreground",
  // AUDIT2-LOGIC-UX H1 — proper "rejected" status (was collapsed into
  // "expired"). Distinct from timeout — this is an active rejection.
  rejected: "border-transparent bg-rose-600 text-white",
};

const STATUS_LABEL_KEYS: Record<ProformaStatus, string> = {
  draft: "portal-status-draft",
  sent: "portal-status-sent",
  viewed: "portal-status-viewed",
  accepted: "portal-status-accepted",
  paid: "portal-status-paid",
  expired: "portal-status-expired",
  rejected: "portal-status-rejected",
};

const STATUS_ICONS: Record<ProformaStatus, React.ComponentType<{ className?: string }>> = {
  draft: FileText,
  sent: Clock,
  viewed: Eye,
  accepted: CheckCircle2,
  paid: CheckCircle2,
  expired: Hourglass,
  rejected: XCircle,
};

export function PortalProformas() {
  const t = useT();
  const qc = useQueryClient();
  const portalAccess = useAppStore((s) => s.portalAccess) as any;
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search, 300);
  const [detailId, setDetailId] = useState<string | null>(null);

  const proformasQ = useInfiniteQuery<{ items: Proforma[]; total: number }>({
    queryKey: ["portal-proformas", debouncedSearch],
    queryFn: async ({ pageParam }) => {
      // 2b2-F4 — paginate via ?limit=&offset= so a partner with >50
      // proformas can reach older rows by clicking "Load more".
      const pageIdx = Number(pageParam) || 0;
      const offset = pageIdx * 50;
      const r = await fetch(`/api/portal/proformas?limit=50&offset=${offset}`);
      if (!r.ok) throw new Error("Failed to load proformas");
      return r.json();
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const fetched = allPages.reduce((sum, p) => sum + (p.items?.length ?? 0), 0);
      if (fetched >= (lastPage.total ?? 0)) return undefined;
      if ((lastPage.items?.length ?? 0) < 50) return undefined;
      return allPages.length;
    },
  });

  const detailQ = useQuery<Proforma>({
    queryKey: ["portal-proforma", detailId],
    queryFn: async () => {
      const r = await fetch("/api/portal/proformas");
      if (!r.ok) throw new Error("Failed to load proforma");
      const data = await r.json();
      const found = (data.items as Proforma[]).find((p) => p.id === detailId);
      if (!found) throw new Error("Proforma not found");
      return found;
    },
    enabled: !!detailId,
  });

  // `allItems` flattened from the infinite-query pages.
  const allItems = useMemo(
    () => (proformasQ.data?.pages ?? []).flatMap((p) => p.items ?? []),
    [proformasQ.data],
  );
  const total = proformasQ.data?.pages?.[0]?.total ?? 0;
  const hasMore = allItems.length < total;

  const filtered = debouncedSearch
    ? allItems.filter(
        (p) =>
          p.number.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
          p.subject.toLowerCase().includes(debouncedSearch.toLowerCase())
      )
    : allItems;

  const canDownloadPdf = !!portalAccess?.can_download_pdf;
  const tier = portalAccess?.tier as PortalTier | undefined;

  function handleDownloadPdf(proformaId: string) {
    window.open(`/api/portal/proformas/${proformaId}/pdf`, "_blank");
  }

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("portal-proformas-title").split(" ")[0]}{" "}
            <span className="text-gradient-emerald">
              {t("portal-proformas-title").split(" ").slice(1).join(" ")}
            </span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {proformasQ.data
              ? t("portal-proformas-count").replace("{n}", String(filtered.length))
              : t("portal-proformas-loading")}
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("portal-search-number-subject")}
            className="pl-10 h-10 smooth focus-visible:ring-primary/40 focus-visible:border-primary/40"
          />
        </div>
      </div>

      {/* Table in premium card */}
      <div className="card-premium overflow-hidden">
        {proformasQ.isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyProformas t={t} />
        ) : (
          <div className="max-h-[calc(100vh-280px)] overflow-y-auto custom-scroll">
            <div className="overflow-x-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-card z-10">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[130px]">{t("portal-col-number")}</TableHead>
                  <TableHead>{t("portal-col-subject")}</TableHead>
                  <TableHead className="w-[120px]">{t("portal-col-status")}</TableHead>
                  <TableHead className="text-right w-[120px]">{t("portal-col-total")}</TableHead>
                  <TableHead className="w-[80px] text-center hidden md:table-cell">{t("portal-col-currency")}</TableHead>
                  <TableHead className="w-[110px] hidden lg:table-cell">{t("portal-col-issue-date")}</TableHead>
                  <TableHead className="w-[110px] hidden lg:table-cell">{t("portal-col-valid-until")}</TableHead>
                  <TableHead className="w-[110px] text-right">{t("portal-col-actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((pro) => {
                  const StatusIcon = STATUS_ICONS[pro.status];
                  return (
                    <TableRow
                      key={pro.id}
                      onClick={() => setDetailId(pro.id)}
                      className="cursor-pointer smooth hover:bg-accent/60"
                    >
                      <TableCell className="font-mono text-xs tabular text-muted-foreground">
                        {pro.number}
                      </TableCell>
                      <TableCell className="font-medium">{pro.subject}</TableCell>
                      <TableCell>
                        <Badge
                          className={cn(
                            "text-xs gap-1 capitalize",
                            STATUS_STYLES[pro.status]
                          )}
                        >
                          <StatusIcon className="size-3" />
                          {t(STATUS_LABEL_KEYS[pro.status])}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular">
                        {fmtMoney(pro.total, pro.currency)}
                      </TableCell>
                      <TableCell className="text-center text-sm text-muted-foreground hidden md:table-cell">
                        {pro.currency}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-sm tabular text-muted-foreground">
                        {fmtDate(pro.issue_date)}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-sm tabular text-muted-foreground">
                        {fmtDate(pro.valid_until)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 smooth hover:bg-accent"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDetailId(pro.id);
                            }}
                            aria-label={t("portal-aria-view-proforma")}
                          >
                            <Eye className="size-4" />
                          </Button>
                          {canDownloadPdf ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 smooth hover:bg-accent hover:text-primary"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDownloadPdf(pro.id);
                              }}
                              aria-label={t("portal-aria-download-pdf")}
                            >
                              <Download className="size-4" />
                            </Button>
                          ) : (
                            <TooltipProvider delayDuration={200}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="size-8 text-muted-foreground cursor-not-allowed"
                                      disabled
                                      aria-label={t("portal-aria-pdf-locked")}
                                    >
                                      <Lock className="size-4" />
                                    </Button>
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top">
                                  <p>{t("portal-pdf-upgrade-tooltip").replace("{tier}", t(tier === "limited" ? "portal-pdf-upgrade-standard-premium" : "portal-pdf-upgrade-premium"))}</p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            </div>
          </div>
        )}

        {/* 2b2-F4 — Load more button. */}
        {hasMore && (
          <div className="border-t border-border/40 p-4 flex flex-col items-center gap-2">
            <p className="text-xs text-muted-foreground tabular">
              {allItems.length} / {total}
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => proformasQ.fetchNextPage()}
              disabled={proformasQ.isFetchingNextPage}
              className="gap-1.5"
            >
              {proformasQ.isFetchingNextPage ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ChevronDown className="size-4" />
              )}
              {proformasQ.isFetchingNextPage
                ? t("marketplace-loading-more")
                : t("marketplace-load-more")}
            </Button>
          </div>
        )}
      </div>

      {/* Detail sheet — glass-strong */}
      <Sheet open={!!detailId} onOpenChange={(o) => !o && setDetailId(null)}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto custom-scroll glass-strong border-l border-border/60">
          {detailQ.isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : detailQ.data ? (
            <ProformaDetail
              proforma={detailQ.data}
              canDownloadPdf={canDownloadPdf}
              tier={tier}
              onDownload={() => handleDownloadPdf(detailQ.data.id)}
              onRespond={async (decision) => {
                const note = decision === "accept"
                  ? window.prompt(t("portal-proforma-accept-note"), "") || ""
                  : window.prompt(t("portal-proforma-reject-note"), "") || "";
                try {
                  const r = await fetch(`/api/portal/proformas/${detailQ.data.id}/respond`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ decision, note }),
                  });
                  if (!r.ok) {
                    const e = await r.json().catch(() => ({}));
                    throw new Error(e.error || "Request failed");
                  }
                  toast.success(decision === "accept" ? t("portal-proforma-accepted") : t("portal-proforma-rejected"));
                  qc.invalidateQueries({ queryKey: ["portal-proformas"] });
                  setDetailId(null);
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Failed");
                }
              }}
              t={t}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function EmptyProformas({ t }: { t: (k: string) => string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center px-6">
      <div className="size-16 rounded-full bg-gradient-to-br from-primary/15 to-primary/5 flex items-center justify-center mb-4">
        <Inbox className="size-7 text-primary" />
      </div>
      <p className="text-base font-semibold">{t("portal-proformas-empty-title")}</p>
      <p className="text-sm text-muted-foreground mt-1 max-w-sm">
        {t("portal-proformas-empty-desc")}
      </p>
      <Button variant="outline" size="sm" disabled className="mt-4">
        <Phone className="size-4 mr-1.5" /> {t("portal-proformas-empty-cta")}
      </Button>
    </div>
  );
}

function ProformaDetail({
  proforma,
  canDownloadPdf,
  tier,
  onDownload,
  onRespond,
  t,
}: {
  proforma: Proforma;
  canDownloadPdf: boolean;
  tier?: PortalTier;
  onDownload: () => void;
  onRespond: (decision: "accept" | "reject") => void;
  t: (k: string) => string;
}) {
  const StatusIcon = STATUS_ICONS[proforma.status];
  const canRespond = proforma.status === "sent" || proforma.status === "viewed";

  // PORTAL-M2 — Fire view-tracking endpoint once per detail open.
  useEffect(() => {
    if (!proforma.id) return;
    fetch(`/api/portal/proformas/${proforma.id}/view`, {
      method: "POST",
    }).catch(() => {});
  }, [proforma.id]);

  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2 flex-wrap">
          <FileText className="size-5 text-primary" />
          <span className="font-mono text-base tabular">{proforma.number}</span>
          <Badge className={cn("gap-1", STATUS_STYLES[proforma.status])}>
            <StatusIcon className="size-3" />
            {t(STATUS_LABEL_KEYS[proforma.status])}
          </Badge>
        </SheetTitle>
        <SheetDescription className="text-sm font-medium text-foreground">
          {proforma.subject}
        </SheetDescription>
      </SheetHeader>

      <div className="px-4 pb-4 space-y-5">
        {/* Summary tiles */}
        <div className="grid grid-cols-2 gap-3">
          <SummaryTile icon={Calendar} label={t("portal-detail-issue-date")} value={fmtDate(proforma.issue_date)} />
          <SummaryTile icon={Hourglass} label={t("portal-detail-valid-until")} value={fmtDate(proforma.valid_until)} />
          <SummaryTile icon={DollarSign} label={t("portal-detail-currency")} value={proforma.currency} />
          {proforma.paid_at && (
            <SummaryTile icon={CheckCircle2} label={t("portal-detail-paid-on")} value={fmtDate(proforma.paid_at)} />
          )}
        </div>

        {/* Line items */}
        <div>
          <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
            <FileText className="size-4 text-primary" />
            {t("portal-detail-line-items")}
            <span className="text-xs text-muted-foreground font-normal">
              ({proforma.items.length})
            </span>
          </h3>
          <div className="rounded-lg border border-border/60 overflow-hidden shadow-soft">
            <div className="overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/40">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-xs">{t("portal-col-product")}</TableHead>
                  <TableHead className="text-xs text-right w-[70px]">{t("portal-col-qty")}</TableHead>
                  <TableHead className="text-xs text-right w-[100px] hidden sm:table-cell">
                    {t("portal-col-unit-price")}
                  </TableHead>
                  <TableHead className="text-xs text-right w-[60px] hidden sm:table-cell">
                    {t("portal-col-disc")}
                  </TableHead>
                  <TableHead className="text-xs text-right w-[110px]">{t("portal-col-total")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {proforma.items.map((it: OfferLineItem, idx: number) => (
                  <TableRow key={idx}>
                    <TableCell>
                      <p className="text-sm font-medium">{it.product_name}</p>
                      <p className="text-xs text-muted-foreground font-mono tabular">
                        {it.sku}
                      </p>
                    </TableCell>
                    <TableCell className="text-right text-sm tabular">{it.quantity}</TableCell>
                    <TableCell className="text-right text-sm tabular hidden sm:table-cell">
                      {fmtMoney(it.unit_price, proforma.currency)}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular hidden sm:table-cell">
                      {it.discount}%
                    </TableCell>
                    <TableCell className="text-right text-sm font-semibold tabular">
                      {fmtMoney(it.total, proforma.currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          </div>
        </div>

        {/* Totals */}
        <div className="rounded-xl border border-border/60 bg-muted/30 p-4 space-y-2 shadow-soft">
          <TotalRow label={t("portal-detail-subtotal")} value={fmtMoneyDetailed(proforma.subtotal, proforma.currency)} />
          {proforma.discount_total > 0 && (
            <TotalRow
              label={t("portal-detail-discount")}
              value={`− ${fmtMoneyDetailed(proforma.discount_total, proforma.currency)}`}
              muted
            />
          )}
          <TotalRow label={t("portal-detail-tax")} value={fmtMoneyDetailed(proforma.tax_total, proforma.currency)} muted />
          <div className="border-t border-border/60 pt-2 flex items-center justify-between">
            <span className="text-sm font-semibold">{t("portal-detail-total")}</span>
            <span className="text-xl font-bold tabular text-gradient-emerald">
              {fmtMoneyDetailed(proforma.total, proforma.currency)}
            </span>
          </div>
        </div>

        {/* Notes */}
        {proforma.notes && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
              {t("portal-detail-notes")}
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">{proforma.notes}</p>
          </div>
        )}

        {/* Download PDF */}
        <div className="border-t border-border/60 pt-4">
          {canDownloadPdf ? (
            <Button
              onClick={onDownload}
              className="w-full shadow-soft hover:shadow-soft-md smooth"
            >
              <Download className="size-4 mr-2" /> {t("portal-download-pdf")}
            </Button>
          ) : (
            <div className="rounded-xl border border-dashed border-border/60 bg-muted/30 p-5 text-center">
              <div className="size-10 rounded-full bg-muted flex items-center justify-center mx-auto mb-2">
                <Lock className="size-4 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium flex items-center justify-center gap-1.5">
                {t("portal-pdf-locked")}
                {tier === "premium" && (
                  <Crown className="size-3.5 text-amber-600" />
                )}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5 max-w-xs mx-auto">
                {tier === "premium"
                  ? t("portal-pdf-locked-premium")
                  : t("portal-pdf-locked-proforma")}
              </p>
            </div>
          )}
        </div>

        {/* Accept / Reject buttons — only when proforma is pending response */}
        {canRespond && (
          <div className="flex gap-2 pt-2">
            <Button
              onClick={() => onRespond("accept")}
              className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white shadow-soft"
            >
              <CheckCircle2 className="size-4 mr-2" /> {t("portal-accept")}
            </Button>
            <Button
              onClick={() => onRespond("reject")}
              variant="outline"
              className="flex-1 border-red-300 text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950"
            >
              <XCircle className="size-4 mr-2" /> {t("portal-reject")}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

function SummaryTile({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-card p-3 shadow-soft">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3" />
        {label}
      </div>
      <p className="text-sm font-medium tabular mt-1">{value}</p>
    </div>
  );
}

function TotalRow({
  label,
  value,
  muted,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className={muted ? "text-muted-foreground" : ""}>{label}</span>
      <span className={cn("tabular", muted ? "text-muted-foreground" : "font-medium")}>
        {value}
      </span>
    </div>
  );
}
