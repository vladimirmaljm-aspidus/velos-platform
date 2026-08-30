"use client";

import { useState, useEffect, useMemo } from "react";
import { useQuery, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  ChevronDown,
  ArrowRightLeft,
  Send,
} from "lucide-react";
import { useAppStore } from "@/lib/store/app-store";
import { useT } from "@/lib/i18n/store";
import { fmtMoney, fmtDate, fmtMoneyDetailed } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { Offer, OfferLineItem, PortalTier } from "@/lib/supabase/types";
import { useDebounced } from "@/lib/hooks/use-debounced";
import { CURRENCIES as REF_CURRENCIES } from "@/lib/data/reference";

// PORTAL-L3 — widened from `Record<OfferStatus, string>` to
// `Record<string, string>` so the runtime "viewed" status (set by
// lib/portal/mark-viewed.ts when the partner first opens a sent offer)
// gets a DISTINCT style instead of falling back to the default Badge
// class. "viewed" was previously missing entirely, so the badge silently
// rendered with no className — visually identical to a freshly-created
// "draft" offer. The sky-tinted style now distinguishes "the partner has
// seen this, awaiting their response" from "we're still drafting".
const STATUS_STYLES: Record<string, string> = {
  draft: "bg-secondary text-secondary-foreground",
  sent: "border-transparent bg-chart-1 text-white",
  viewed: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-400",
  accepted: "border-transparent bg-emerald-600 text-white",
  rejected: "border-transparent bg-rose-600 text-white",
  expired: "bg-muted text-muted-foreground",
  countered: "border-transparent bg-amber-500 text-white",
};

const STATUS_LABEL_KEYS: Record<string, string> = {
  draft: "portal-status-draft",
  sent: "portal-status-sent",
  viewed: "portal-status-viewed",
  accepted: "portal-status-accepted",
  rejected: "portal-status-rejected",
  expired: "portal-status-expired",
  countered: "portal-status-countered",
};

const STATUS_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  draft: FileText,
  sent: Clock,
  viewed: Eye,
  accepted: CheckCircle2,
  rejected: XCircle,
  expired: Calendar,
  countered: ArrowRightLeft,
};

export function PortalOffers() {
  const t = useT();
  const portalAccess = useAppStore((s) => s.portalAccess) as any;
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search, 300);
  const [detailId, setDetailId] = useState<string | null>(null);

  const offersQ = useInfiniteQuery<{ items: Offer[]; total: number }>({
    queryKey: ["portal-offers", debouncedSearch],
    queryFn: async ({ pageParam }) => {
      // 2b2-F4 — paginate via ?limit=&offset= so a partner with >50
      // offers can reach older rows by clicking "Load more". The
      // previous useQuery fetched only the first 50 (the store's
      // default cap) and silently truncated history. Page size 50
      // matches the store default; the queryKey includes the search
      // query so changing the search resets to page 0.
      const pageIdx = Number(pageParam) || 0;
      const offset = pageIdx * 50;
      const r = await fetch(`/api/portal/offers?limit=50&offset=${offset}`);
      if (!r.ok) throw new Error("Failed to load offers");
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

  // Flatten every fetched page into a single items array (mirrors
  // marketplace-list.tsx's pattern).
  const allItems = useMemo(
    () => (offersQ.data?.pages ?? []).flatMap((p) => p.items ?? []),
    [offersQ.data],
  );
  const total = offersQ.data?.pages?.[0]?.total ?? 0;
  const hasMore = allItems.length < total;

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

  // `allItems` is now declared above (from the infinite-query pages).
  // Apply the client-side search filter on top of the loaded items.
  // NOTE: the search only filters what's been loaded so far — if the
  // user is looking for an older item not yet fetched, they need to
  // click "Load more" first. This is no worse than the previous
  // behavior (which capped at 50 rows), and now the user can actually
  // reach older rows by loading more.
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

        {/* 2b2-F4 — Load more button. Hidden when there's nothing
            more to fetch (hasMore is false). Mirrors marketplace-list.tsx. */}
        {hasMore && (
          <div className="border-t border-border/40 p-4 flex flex-col items-center gap-2">
            <p className="text-xs text-muted-foreground tabular">
              {allItems.length} / {total}
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => offersQ.fetchNextPage()}
              disabled={offersQ.isFetchingNextPage}
              className="gap-1.5"
            >
              {offersQ.isFetchingNextPage ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ChevronDown className="size-4" />
              )}
              {offersQ.isFetchingNextPage
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

  // PORTAL-M2 — Fire view-tracking endpoint once per detail open.
  // Swallow errors (fire-and-forget). useEffect dep is offer.id so it
  // only re-fires when the user opens a different offer detail.
  useEffect(() => {
    if (!offer.id) return;
    fetch(`/api/portal/offers/${offer.id}/view`, { method: "POST" }).catch(
      () => {},
    );
  }, [offer.id]);

  // FIX-MARKET-UI / FIX 3 — Dialog-driven accept / reject / counter.
  // `window.prompt` was jarring and provided no validation surface; we now
  // use a proper shadcn Dialog for each decision so the user can type a
  // note / reason / counter amount in a styled form.
  const [dialogMode, setDialogMode] = useState<"accept" | "reject" | "counter" | null>(null);
  const [acceptNote, setAcceptNote] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [counterAmount, setCounterAmount] = useState("");
  const [counterCurrency, setCounterCurrency] = useState(offer.currency || "USD");
  const [counterMessage, setCounterMessage] = useState("");

  const canRespond =
    offer.status === "sent" ||
    (offer.status as string) === "viewed" ||
    (offer.status as string) === "countered";

  // Reset dialog state whenever the dialog closes.
  function closeDialog() {
    setDialogMode(null);
    setAcceptNote("");
    setRejectReason("");
    setCounterAmount("");
    setCounterCurrency(offer.currency || "USD");
    setCounterMessage("");
  }

  async function submitAccept() {
    setResponding(true);
    try {
      const res = await fetch(`/api/portal/offers/${offer.id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "accept", note: acceptNote.trim() || undefined }),
      });
      if (res.ok) {
        toast.success(t("portal-toast-offer-accepted"));
        onResponded();
        closeDialog();
      } else {
        const e = await res.json().catch(() => ({}));
        toast.error(e.error || t("portal-toast-offer-update-failed"));
      }
    } catch {
      toast.error(t("portal-toast-network-error"));
    } finally {
      setResponding(false);
    }
  }

  async function submitReject() {
    setResponding(true);
    try {
      const res = await fetch(`/api/portal/offers/${offer.id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "reject", note: rejectReason.trim() || undefined }),
      });
      if (res.ok) {
        toast.success(t("portal-toast-offer-rejected"));
        onResponded();
        closeDialog();
      } else {
        const e = await res.json().catch(() => ({}));
        toast.error(e.error || t("portal-toast-offer-update-failed"));
      }
    } catch {
      toast.error(t("portal-toast-network-error"));
    } finally {
      setResponding(false);
    }
  }

  async function submitCounter() {
    const amt = Number(counterAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.error(t("portal-detail-counter-amount"));
      return;
    }
    setResponding(true);
    try {
      const res = await fetch(`/api/portal/offers/${offer.id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "counter",
          counter_amount: amt,
          counter_currency: counterCurrency,
          counter_message: counterMessage.trim() || undefined,
        }),
      });
      if (res.ok) {
        toast.success(t("portal-detail-counter-sent"));
        onResponded();
        closeDialog();
      } else {
        const e = await res.json().catch(() => ({}));
        toast.error(e.error || t("portal-toast-offer-update-failed"));
      }
    } catch {
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

        {/* FIX-MARKET-UI / FIX 3 — Counter-offer history. */}
        {Array.isArray(offer.counter_offers) && offer.counter_offers.length > 0 && (
          <div className="border-t border-border/60 pt-4 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <ArrowRightLeft className="size-3.5" />
              {t("portal-detail-counter-history")}
            </p>
            <div className="space-y-2">
              {offer.counter_offers.map((c, i) => (
                <div
                  key={i}
                  className="rounded-md border border-amber-500/30 bg-amber-500/[0.05] p-3 space-y-1"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold tabular">
                      {fmtMoney(c.amount, c.currency)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(c.created_at).toLocaleString()}
                    </span>
                  </div>
                  {c.message && (
                    <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
                      {c.message}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Accept / Reject / Counter actions — only available when offer is
            awaiting a response (sent, viewed, or countered). */}
        {canRespond && (
          <div className="border-t border-border/60 pt-4 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t("portal-detail-your-response")}
            </p>
            <div className="grid grid-cols-3 gap-2">
              <Button
                type="button"
                onClick={() => setDialogMode("accept")}
                disabled={responding}
                className="bg-emerald-600 text-white hover:bg-emerald-700 shadow-soft hover:shadow-soft-md smooth"
              >
                <Check className="size-4 mr-1.5" />
                {t("portal-detail-accept")}
              </Button>
              <Button
                type="button"
                onClick={() => setDialogMode("counter")}
                disabled={responding}
                variant="outline"
                className="border-amber-500/40 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10 smooth"
              >
                <ArrowRightLeft className="size-4 mr-1.5" />
                {t("portal-detail-counter")}
              </Button>
              <Button
                type="button"
                onClick={() => setDialogMode("reject")}
                disabled={responding}
                variant="outline"
                className="border-destructive/40 text-destructive hover:bg-destructive/10 smooth"
              >
                <X className="size-4 mr-1.5" />
                {t("portal-detail-reject")}
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

      {/* FIX-MARKET-UI / FIX 3 — Accept / Reject / Counter dialogs.
          Replaces the previous window.prompt() UX with a styled shadcn
          Dialog for each decision. */}
      <Dialog open={dialogMode === "accept"} onOpenChange={(o) => !o && closeDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="size-5 text-emerald-600" />
              {t("portal-detail-accept-dialog-title")}
            </DialogTitle>
            <DialogDescription>
              {t("portal-detail-accept-dialog-desc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="accept-note">{t("portal-detail-accept-dialog-note-label")}</Label>
            <Textarea
              id="accept-note"
              rows={3}
              value={acceptNote}
              onChange={(e) => setAcceptNote(e.target.value)}
              placeholder={t("portal-detail-accept-dialog-note-placeholder")}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDialog}>
              {t("portal-action-cancel")}
            </Button>
            <Button
              type="button"
              onClick={submitAccept}
              disabled={responding}
              className="bg-emerald-600 text-white hover:bg-emerald-700 gap-1.5"
            >
              {responding ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
              {t("portal-detail-confirm-accept")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogMode === "reject"} onOpenChange={(o) => !o && closeDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <XCircle className="size-5 text-destructive" />
              {t("portal-detail-reject-dialog-title")}
            </DialogTitle>
            <DialogDescription>
              {t("portal-detail-reject-dialog-desc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reject-reason">{t("portal-detail-reject-dialog-reason-label")}</Label>
            <Textarea
              id="reject-reason"
              rows={3}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder={t("portal-detail-reject-dialog-reason-placeholder")}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDialog}>
              {t("portal-action-cancel")}
            </Button>
            <Button
              type="button"
              onClick={submitReject}
              disabled={responding}
              variant="outline"
              className="border-destructive/40 text-destructive hover:bg-destructive/10 gap-1.5"
            >
              {responding ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
              {t("portal-detail-confirm-reject")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogMode === "counter"} onOpenChange={(o) => !o && closeDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowRightLeft className="size-5 text-amber-600" />
              {t("portal-detail-counter")}
            </DialogTitle>
            <DialogDescription>
              {t("portal-detail-counter-desc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="counter-amount">{t("portal-detail-counter-amount")}</Label>
                <Input
                  id="counter-amount"
                  type="number"
                  step="0.01"
                  min="0"
                  value={counterAmount}
                  onChange={(e) => setCounterAmount(e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div>
                <Label htmlFor="counter-currency">{t("portal-detail-counter-currency")}</Label>
                <Select value={counterCurrency} onValueChange={setCounterCurrency}>
                  <SelectTrigger id="counter-currency"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {REF_CURRENCIES.slice(0, 16).map((c) => (
                      <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label htmlFor="counter-message">{t("portal-detail-counter-message")}</Label>
              <Textarea
                id="counter-message"
                rows={3}
                value={counterMessage}
                onChange={(e) => setCounterMessage(e.target.value)}
                placeholder={t("portal-detail-counter-message-placeholder")}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDialog}>
              {t("portal-action-cancel")}
            </Button>
            <Button
              type="button"
              onClick={submitCounter}
              disabled={responding || !counterAmount || Number(counterAmount) <= 0}
              variant="outline"
              className="border-amber-500/40 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10 gap-1.5"
            >
              {responding ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              {t("portal-detail-counter-submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
