"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  Loader2,
  Calendar,
  Clock,
  CheckCircle2,
  XCircle,
  Crown,
  Check,
  X,
} from "lucide-react";
import { useAppStore } from "@/lib/store/app-store";
import { useT } from "@/lib/i18n/store";
import { fmtMoney, fmtDate, fmtMoneyDetailed } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { Offer, OfferStatus, OfferLineItem, PortalTier } from "@/lib/supabase/types";
import { useDebounced } from "@/lib/hooks/use-debounced";

const STATUS_STYLES: Record<OfferStatus, string> = {
  draft: "bg-secondary text-secondary-foreground",
  sent: "border-transparent bg-chart-1 text-white",
  accepted: "border-transparent bg-emerald-600 text-white",
  rejected: "border-transparent bg-destructive text-destructive-foreground",
  expired: "bg-muted text-muted-foreground",
};

const STATUS_LABEL_KEYS: Record<OfferStatus, string> = {
  draft: "portal-status-draft",
  sent: "portal-status-sent",
  accepted: "portal-status-accepted",
  rejected: "portal-status-rejected",
  expired: "portal-status-expired",
};

const STATUS_ICONS: Record<OfferStatus, React.ComponentType<{ className?: string }>> = {
  draft: FileText,
  sent: Clock,
  accepted: CheckCircle2,
  rejected: XCircle,
  expired: Calendar,
};

export function PortalOffers() {
  const t = useT();
  const portalAccess = useAppStore((s) => s.portalAccess) as any;
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search, 300);
  const [detailId, setDetailId] = useState<string | null>(null);

  const offersQ = useQuery<{ items: Offer[]; total: number }>({
    queryKey: ["portal-offers", debouncedSearch],
    queryFn: async () => {
      const r = await fetch("/api/portal/offers");
      if (!r.ok) throw new Error("Failed to load offers");
      return r.json();
    },
  });

  const detailQ = useQuery<Offer>({
    queryKey: ["portal-offer", detailId],
    queryFn: async () => {
      // The portal offers endpoint returns all partner offers; find locally
      const r = await fetch("/api/portal/offers");
      if (!r.ok) throw new Error("Failed to load offer");
      const data = await r.json();
      const found = (data.items as Offer[]).find((o) => o.id === detailId);
      if (!found) throw new Error("Offer not found");
      return found;
    },
    enabled: !!detailId,
  });

  const allItems = offersQ.data?.items || [];
  const filtered = debouncedSearch
    ? allItems.filter(
        (o) =>
          o.number.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
          o.subject.toLowerCase().includes(debouncedSearch.toLowerCase())
      )
    : allItems;

  const canDownloadPdf = !!portalAccess?.can_download_pdf;
  const tier = portalAccess?.tier as PortalTier | undefined;

  function handleDownloadPdf(offerId: string) {
    window.open(`/api/portal/offers/${offerId}/pdf`, "_blank");
  }

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("portal-offers-title").split(" ")[0]}{" "}
            <span className="text-gradient-emerald">
              {t("portal-offers-title").split(" ").slice(1).join(" ")}
            </span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {offersQ.data
              ? t("portal-offers-count").replace("{n}", String(filtered.length))
              : t("portal-offers-loading")}
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
        {offersQ.isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyOffers t={t} />
        ) : (
          <div className="max-h-[calc(100vh-280px)] overflow-y-auto custom-scroll">
            <div className="overflow-x-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-card z-10">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[130px]">{t("portal-col-number")}</TableHead>
                  <TableHead>{t("portal-col-subject")}</TableHead>
                  <TableHead className="w-[120px]">{t("portal-col-status")}</TableHead>
                  <TableHead className="text-right w-[140px]">{t("portal-col-total")}</TableHead>
                  <TableHead className="w-[120px] hidden md:table-cell">{t("portal-col-valid-until")}</TableHead>
                  <TableHead className="w-[110px] text-right">{t("portal-col-actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((o) => {
                  const StatusIcon = STATUS_ICONS[o.status];
                  return (
                    <TableRow
                      key={o.id}
                      onClick={() => setDetailId(o.id)}
                      className="cursor-pointer smooth hover:bg-accent/60"
                    >
                      <TableCell className="font-mono text-xs tabular text-muted-foreground">
                        {o.number}
                      </TableCell>
                      <TableCell className="font-medium">{o.subject}</TableCell>
                      <TableCell>
                        <Badge
                          className={cn(
                            "text-xs gap-1 capitalize",
                            STATUS_STYLES[o.status]
                          )}
                        >
                          <StatusIcon className="size-3" />
                          {t(STATUS_LABEL_KEYS[o.status])}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular">
                        {fmtMoney(o.total, o.currency)}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm tabular text-muted-foreground">
                        {fmtDate(o.valid_until)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 smooth hover:bg-accent"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDetailId(o.id);
                            }}
                            aria-label={t("portal-aria-view-offer")}
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
                                handleDownloadPdf(o.id);
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
      </div>

      {/* Detail sheet — glass-strong */}
      <Sheet open={!!detailId} onOpenChange={(o) => !o && setDetailId(null)}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto custom-scroll glass-strong border-l border-border/60">
          {detailQ.isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : detailQ.data ? (
            <OfferDetail
              offer={detailQ.data}
              canDownloadPdf={canDownloadPdf}
              tier={tier}
              onDownload={() => handleDownloadPdf(detailQ.data.id)}
              onResponded={() => {
                qc.invalidateQueries({ queryKey: ["portal-offers"] });
                qc.invalidateQueries({ queryKey: ["portal-offer", detailId] });
              }}
              t={t}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function EmptyOffers({ t }: { t: (k: string) => string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center px-6">
      <div className="size-16 rounded-full bg-gradient-to-br from-primary/15 to-primary/5 flex items-center justify-center mb-4">
        <Inbox className="size-7 text-primary" />
      </div>
      <p className="text-base font-semibold">{t("portal-offers-empty-title")}</p>
      <p className="text-sm text-muted-foreground mt-1 max-w-sm">
        {t("portal-offers-empty-desc")}
      </p>
    </div>
  );
}

function OfferDetail({
  offer,
  canDownloadPdf,
  tier,
  onDownload,
  onResponded,
  t,
}: {
  offer: Offer;
  canDownloadPdf: boolean;
  tier?: PortalTier;
  onDownload: () => void;
  onResponded: () => void;
  t: (k: string) => string;
}) {
  const StatusIcon = STATUS_ICONS[offer.status];
  const [responding, setResponding] = useState(false);

  const canRespond = offer.status === "sent" || (offer.status as string) === "viewed";

  async function handleRespond(decision: "accept" | "reject") {
    const promptLabel =
      decision === "accept"
        ? t("portal-prompt-add-note")
        : t("portal-prompt-reject-reason");
    const note = window.prompt(promptLabel, "") || "";
    setResponding(true);
    try {
      const res = await fetch(`/api/portal/offers/${offer.id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, note }),
      });
      if (res.ok) {
        toast.success(decision === "accept" ? t("portal-toast-offer-accepted") : t("portal-toast-offer-rejected"));
        onResponded();
      } else {
        const e = await res.json().catch(() => ({}));
        toast.error(e.error || t("portal-toast-offer-update-failed"));
      }
    } catch (e) {
      toast.error(t("portal-toast-network-error"));
    } finally {
      setResponding(false);
    }
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2 flex-wrap">
          <FileText className="size-5 text-primary" />
          <span className="font-mono text-base tabular">{offer.number}</span>
          <Badge className={cn("gap-1", STATUS_STYLES[offer.status])}>
            <StatusIcon className="size-3" />
            {t(STATUS_LABEL_KEYS[offer.status])}
          </Badge>
        </SheetTitle>
        <SheetDescription className="text-sm font-medium text-foreground">
          {offer.subject}
        </SheetDescription>
      </SheetHeader>

      <div className="px-4 pb-4 space-y-5">
        {/* Summary tiles */}
        <div className="grid grid-cols-2 gap-3">
          <SummaryTile icon={Calendar} label={t("portal-detail-issued")} value={fmtDate(offer.created_at)} />
          <SummaryTile icon={Clock} label={t("portal-detail-valid-until")} value={fmtDate(offer.valid_until)} />
          <SummaryTile icon={FileText} label={t("portal-detail-sent-on")} value={fmtDate(offer.sent_at)} />
          <SummaryTile icon={CheckCircle2} label={t("portal-detail-responded")} value={fmtDate(offer.responded_at)} />
        </div>

        {/* Line items */}
        <div>
          <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
            <FileText className="size-4 text-primary" />
            {t("portal-detail-line-items")}
            <span className="text-xs text-muted-foreground font-normal">
              ({offer.items.length})
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
                {offer.items.map((it: OfferLineItem, idx: number) => (
                  <TableRow key={idx}>
                    <TableCell>
                      <p className="text-sm font-medium">{it.product_name}</p>
                      <p className="text-xs text-muted-foreground font-mono tabular">
                        {it.sku}
                      </p>
                    </TableCell>
                    <TableCell className="text-right text-sm tabular">{it.quantity}</TableCell>
                    <TableCell className="text-right text-sm tabular hidden sm:table-cell">
                      {fmtMoney(it.unit_price, offer.currency)}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular hidden sm:table-cell">
                      {it.discount}%
                    </TableCell>
                    <TableCell className="text-right text-sm font-semibold tabular">
                      {fmtMoney(it.total, offer.currency)}
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
          <TotalRow label={t("portal-detail-subtotal")} value={fmtMoneyDetailed(offer.subtotal, offer.currency)} />
          {offer.discount_total > 0 && (
            <TotalRow
              label={t("portal-detail-discount")}
              value={`− ${fmtMoneyDetailed(offer.discount_total, offer.currency)}`}
              muted
            />
          )}
          <TotalRow label={t("portal-detail-tax")} value={fmtMoneyDetailed(offer.tax_total, offer.currency)} muted />
          <div className="border-t border-border/60 pt-2 flex items-center justify-between">
            <span className="text-sm font-semibold">{t("portal-detail-total")}</span>
            <span className="text-xl font-bold tabular text-gradient-emerald">
              {fmtMoneyDetailed(offer.total, offer.currency)}
            </span>
          </div>
        </div>

        {/* Notes & terms */}
        {(offer.notes || offer.terms) && (
          <div className="space-y-3">
            {offer.notes && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                  {t("portal-detail-notes")}
                </p>
                <p className="text-sm text-muted-foreground leading-relaxed">{offer.notes}</p>
              </div>
            )}
            {offer.terms && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                  {t("portal-detail-terms")}
                </p>
                <p className="text-sm text-muted-foreground leading-relaxed">{offer.terms}</p>
              </div>
            )}
          </div>
        )}

        {/* Accept / Reject actions — only available when offer is awaiting a response. */}
        {canRespond && (
          <div className="border-t border-border/60 pt-4 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t("portal-detail-your-response")}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Button
                onClick={() => handleRespond("accept")}
                disabled={responding}
                className="bg-emerald-600 text-white hover:bg-emerald-700 shadow-soft hover:shadow-soft-md smooth"
              >
                <Check className="size-4 mr-1.5" />
                {responding ? "…" : t("portal-detail-accept")}
              </Button>
              <Button
                onClick={() => handleRespond("reject")}
                disabled={responding}
                variant="outline"
                className="border-destructive/40 text-destructive hover:bg-destructive/10 smooth"
              >
                <X className="size-4 mr-1.5" />
                {responding ? "…" : t("portal-detail-reject")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t("portal-detail-accept-desc")}
            </p>
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
                  : t("portal-pdf-locked-offer")}
              </p>
            </div>
          )}
        </div>
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
