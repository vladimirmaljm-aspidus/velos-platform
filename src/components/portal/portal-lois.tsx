"use client";

import { useState, useEffect, useMemo } from "react";
import { useQuery, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  ChevronDown,
  Calendar,
  Clock,
  CheckCircle2,
  XCircle,
  Crown,
  DollarSign,
  Hourglass,
  Building2,
  Package,
  MapPin,
  Truck,
  CreditCard,
  ClipboardList,
  FileCheck2,
  Globe,
} from "lucide-react";
import { useAppStore } from "@/lib/store/app-store";
import { useT } from "@/lib/i18n/store";
import { fmtMoney, fmtDate } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { LetterOfIntent, LoiStatus, PortalTier } from "@/lib/supabase/types";
import { useDebounced } from "@/lib/hooks/use-debounced";

// BUILD-LOI-PORTAL — status visuals. Same family as proformas (chart-1 for
// sent, emerald for accepted, rose for rejected, destructive for expired).
// "viewed" intentionally absent: the LOI state machine has no viewed status.
const STATUS_STYLES: Record<string, string> = {
  draft: "bg-secondary text-secondary-foreground",
  sent: "border-transparent bg-chart-1 text-white",
  accepted: "border-transparent bg-emerald-600 text-white",
  rejected: "border-transparent bg-rose-600 text-white",
  expired: "border-transparent bg-destructive text-destructive-foreground",
  cancelled: "bg-secondary text-secondary-foreground",
};

const STATUS_LABEL_KEYS: Record<string, string> = {
  draft: "portal-status-draft",
  sent: "portal-status-sent",
  accepted: "portal-status-accepted",
  rejected: "portal-status-rejected",
  expired: "portal-status-expired",
  cancelled: "portal-status-cancelled",
};

const STATUS_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  draft: FileText,
  sent: Clock,
  accepted: CheckCircle2,
  rejected: XCircle,
  expired: Hourglass,
  cancelled: XCircle,
};

/** Normalize the LOI `specifications` field (array OR record) to entries. */
function toSpecEntries(specs: unknown): Array<{ name: string; value: string }> {
  if (Array.isArray(specs)) {
    return specs
      .filter((s: any) => s && s.name && s.value != null)
      .map((s: any) => ({ name: String(s.name), value: String(s.value) }));
  }
  if (specs && typeof specs === "object") {
    return Object.entries(specs as Record<string, unknown>)
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => ({ name: k, value: String(v) }));
  }
  return [];
}

/** Normalize the LOI `coa_params` field to visible entries. */
function toCoaEntries(coa: unknown): Array<{ name: string; value: string }> {
  if (coa && typeof coa === "object" && !Array.isArray(coa)) {
    return Object.entries(coa as Record<string, unknown>)
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => ({ name: k, value: String(v) }));
  }
  return [];
}

export function PortalLois() {
  const t = useT();
  const qc = useQueryClient();
  const portalAccess = useAppStore((s) => s.portalAccess) as any;
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search, 300);
  const [detailId, setDetailId] = useState<string | null>(null);

  const loisQ = useInfiniteQuery<{ items: LetterOfIntent[]; total: number }>({
    queryKey: ["portal-lois", debouncedSearch],
    queryFn: async ({ pageParam }) => {
      const pageIdx = Number(pageParam) || 0;
      const offset = pageIdx * 50;
      const r = await fetch(`/api/portal/lois?limit=50&offset=${offset}`);
      if (!r.ok) throw new Error("Failed to load LOIs");
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

  // Detail fetch — uses the dedicated [id] endpoint (unlike proformas,
  // which re-downloads the whole list; that breaks past page 1).
  const detailQ = useQuery<LetterOfIntent>({
    queryKey: ["portal-loi", detailId],
    queryFn: async () => {
      const r = await fetch(`/api/portal/lois/${detailId}`);
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to load LOI");
      }
      return r.json();
    },
    enabled: !!detailId,
  });

  const allItems = useMemo(
    () => (loisQ.data?.pages ?? []).flatMap((p) => p.items ?? []),
    [loisQ.data],
  );
  const total = loisQ.data?.pages?.[0]?.total ?? 0;
  const hasMore = allItems.length < total;

  const filtered = debouncedSearch
    ? allItems.filter(
        (l) =>
          l.number.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
          l.subject.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
          (l.product_name || "").toLowerCase().includes(debouncedSearch.toLowerCase()) ||
          (l.buyer_name || "").toLowerCase().includes(debouncedSearch.toLowerCase()),
      )
    : allItems;

  const canDownloadPdf = !!portalAccess?.can_download_pdf;
  const tier = portalAccess?.tier as PortalTier | undefined;

  // ─── Respond dialog state (proper dialog, not window.prompt) ──────────
  const [respondOpen, setRespondOpen] = useState(false);
  const [respondDecision, setRespondDecision] = useState<"accept" | "reject">("accept");
  const [respondNote, setRespondNote] = useState("");
  const [responding, setResponding] = useState(false);

  async function submitResponse() {
    if (!detailId) return;
    setResponding(true);
    try {
      const r = await fetch(`/api/portal/lois/${detailId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: respondDecision, note: respondNote.trim() || undefined }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Request failed");
      }
      toast.success(
        respondDecision === "accept" ? t("portal-loi-accepted") : t("portal-loi-rejected"),
      );
      qc.invalidateQueries({ queryKey: ["portal-lois"] });
      qc.invalidateQueries({ queryKey: ["portal-loi", detailId] });
      setRespondOpen(false);
      setRespondNote("");
      setDetailId(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setResponding(false);
    }
  }

  function openRespond(decision: "accept" | "reject") {
    setRespondDecision(decision);
    setRespondNote("");
    setRespondOpen(true);
  }

  function handleDownloadPdf(loiId: string) {
    window.open(`/api/portal/lois/${loiId}/pdf`, "_blank");
  }

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("portal-lois-title").split(" ")[0]}{" "}
            <span className="text-gradient-emerald">
              {t("portal-lois-title").split(" ").slice(1).join(" ")}
            </span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {loisQ.data
              ? t("portal-lois-count").replace("{n}", String(filtered.length))
              : t("portal-lois-loading")}
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
        {loisQ.isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : loisQ.isError ? (
          <div className="flex flex-col items-center justify-center py-12 text-center px-6 gap-3">
            <p className="text-sm text-muted-foreground">{t("portal-lois-load-error")}</p>
            <Button variant="outline" size="sm" onClick={() => loisQ.refetch()}>
              {t("portal-notif-retry")}
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <EmptyLois t={t} />
        ) : (
          <div className="max-h-[calc(100vh-280px)] overflow-y-auto custom-scroll">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-[130px]">{t("portal-col-number")}</TableHead>
                    <TableHead>{t("portal-col-subject")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("portal-col-product")}</TableHead>
                    <TableHead className="w-[120px]">{t("portal-col-status")}</TableHead>
                    <TableHead className="text-right w-[120px]">{t("portal-loi-total-value")}</TableHead>
                    <TableHead className="w-[80px] text-center hidden md:table-cell">{t("portal-col-currency")}</TableHead>
                    <TableHead className="w-[110px] hidden lg:table-cell">{t("portal-col-valid-until")}</TableHead>
                    <TableHead className="w-[110px] text-right">{t("portal-col-actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((loi) => {
                    const StatusIcon = STATUS_ICONS[loi.status] || FileText;
                    return (
                      <TableRow
                        key={loi.id}
                        onClick={() => setDetailId(loi.id)}
                        className="cursor-pointer smooth hover:bg-accent/60"
                      >
                        <TableCell className="font-mono text-xs tabular text-muted-foreground">
                          {loi.number}
                        </TableCell>
                        <TableCell className="font-medium max-w-[220px] truncate" title={loi.subject}>
                          {loi.subject}
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-sm text-muted-foreground max-w-[180px] truncate" title={loi.product_name}>
                          {loi.product_name}
                        </TableCell>
                        <TableCell>
                          <Badge
                            className={cn(
                              "text-xs gap-1 capitalize",
                              STATUS_STYLES[loi.status] || STATUS_STYLES.draft,
                            )}
                          >
                            <StatusIcon className="size-3" />
                            {t(STATUS_LABEL_KEYS[loi.status] || "portal-status-draft")}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular">
                          {fmtMoney(loi.total_value, loi.currency)}
                        </TableCell>
                        <TableCell className="text-center text-sm text-muted-foreground hidden md:table-cell">
                          {loi.currency}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell text-sm tabular text-muted-foreground">
                          {fmtDate(loi.validity_until)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 smooth hover:bg-accent"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDetailId(loi.id);
                              }}
                              aria-label={t("portal-aria-view-loi")}
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
                                  handleDownloadPdf(loi.id);
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
                                    <p>
                                      {t("portal-pdf-upgrade-tooltip").replace(
                                        "{tier}",
                                        t(tier === "limited" ? "portal-pdf-upgrade-standard-premium" : "portal-pdf-upgrade-premium"),
                                      )}
                                    </p>
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

        {/* Load more */}
        {hasMore && (
          <div className="border-t border-border/40 p-4 flex flex-col items-center gap-2">
            <p className="text-xs text-muted-foreground tabular">
              {allItems.length} / {total}
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => loisQ.fetchNextPage()}
              disabled={loisQ.isFetchingNextPage}
              className="gap-1.5"
            >
              {loisQ.isFetchingNextPage ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ChevronDown className="size-4" />
              )}
              {loisQ.isFetchingNextPage
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
          ) : detailQ.isError ? (
            <div className="flex flex-col items-center justify-center py-12 text-center gap-3 px-6">
              <XCircle className="size-8 text-destructive" />
              <p className="text-sm text-muted-foreground">
                {(detailQ.error as Error)?.message || t("portal-lois-load-error")}
              </p>
              <Button variant="outline" size="sm" onClick={() => detailQ.refetch()}>
                {t("portal-notif-retry")}
              </Button>
            </div>
          ) : detailQ.data ? (
            <LoiDetail
              loi={detailQ.data}
              canDownloadPdf={canDownloadPdf}
              tier={tier}
              t={t}
              onDownload={() => handleDownloadPdf(detailQ.data.id)}
              onRespond={openRespond}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      {/* Respond confirmation dialog (accept / reject with optional note) */}
      <Dialog open={respondOpen} onOpenChange={setRespondOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle
              className={cn(
                "flex items-center gap-2",
                respondDecision === "reject" && "text-destructive",
              )}
            >
              {respondDecision === "accept" ? (
                <CheckCircle2 className="size-5 text-emerald-600" />
              ) : (
                <XCircle className="size-5 text-destructive" />
              )}
              {respondDecision === "accept"
                ? t("portal-loi-accept-title")
                : t("portal-loi-reject-title")}
            </DialogTitle>
            <DialogDescription>
              {respondDecision === "accept"
                ? t("portal-loi-accept-desc")
                : t("portal-loi-reject-desc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Textarea
              value={respondNote}
              onChange={(e) => setRespondNote(e.target.value)}
              placeholder={t("portal-loi-respond-note-placeholder")}
              rows={3}
              maxLength={5000}
              className="resize-none"
            />
            <p className="text-xs text-muted-foreground text-right tabular">
              {respondNote.length}/5000
            </p>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setRespondOpen(false)} disabled={responding}>
              {t("portal-loi-respond-cancel")}
            </Button>
            <Button
              onClick={submitResponse}
              disabled={responding}
              className={cn(
                "gap-2",
                respondDecision === "accept"
                  ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                  : "bg-destructive hover:bg-destructive/90 text-destructive-foreground",
              )}
            >
              {responding ? (
                <Loader2 className="size-4 animate-spin" />
              ) : respondDecision === "accept" ? (
                <CheckCircle2 className="size-4" />
              ) : (
                <XCircle className="size-4" />
              )}
              {respondDecision === "accept" ? t("portal-accept") : t("portal-reject")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyLois({ t }: { t: (k: string) => string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center px-6">
      <div className="size-16 rounded-full bg-gradient-to-br from-primary/15 to-primary/5 flex items-center justify-center mb-4">
        <FileText className="size-7 text-primary" />
      </div>
      <p className="text-base font-semibold">{t("portal-lois-empty-title")}</p>
      <p className="text-sm text-muted-foreground mt-1 max-w-sm">
        {t("portal-lois-empty-desc")}
      </p>
    </div>
  );
}

function LoiDetail({
  loi,
  canDownloadPdf,
  tier,
  onDownload,
  onRespond,
  t,
}: {
  loi: LetterOfIntent;
  canDownloadPdf: boolean;
  tier?: PortalTier;
  onDownload: () => void;
  onRespond: (decision: "accept" | "reject") => void;
  t: (k: string) => string;
}) {
  const StatusIcon = STATUS_ICONS[loi.status] || FileText;
  // Only a SENT LOI is respondable (the LOI state machine has no "viewed"
  // status — viewing keeps it "sent" until the partner decides).
  const canRespond = loi.status === "sent";

  // Fire view-tracking endpoint once per detail open (PORTAL-M2 parity).
  useEffect(() => {
    if (!loi.id) return;
    fetch(`/api/portal/lois/${loi.id}/view`, { method: "POST" }).catch(() => {});
  }, [loi.id]);

  const coaEntries = toCoaEntries(loi.coa_params);
  const specEntries = toSpecEntries(loi.specifications);

  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2 flex-wrap">
          <FileText className="size-5 text-primary" />
          <span className="font-mono text-base tabular">{loi.number}</span>
          <Badge className={cn("gap-1", STATUS_STYLES[loi.status] || STATUS_STYLES.draft)}>
            <StatusIcon className="size-3" />
            {t(STATUS_LABEL_KEYS[loi.status] || "portal-status-draft")}
          </Badge>
        </SheetTitle>
        <SheetDescription className="text-sm font-medium text-foreground">
          {loi.subject}
        </SheetDescription>
      </SheetHeader>

      <div className="px-4 pb-4 space-y-5">
        {/* Buyer block — who is issuing this LOI (the portal client is the seller) */}
        <div className="rounded-xl border border-primary/25 bg-primary/[0.04] p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-primary mb-2 flex items-center gap-1.5">
            <Building2 className="size-3.5" />
            {t("portal-loi-buyer")}
          </p>
          <p className="text-sm font-semibold">{loi.buyer_name}</p>
          {loi.buyer_address && (
            <p className="text-xs text-muted-foreground mt-1 flex items-start gap-1.5">
              <MapPin className="size-3 mt-0.5 shrink-0" />
              {loi.buyer_address}
            </p>
          )}
          {loi.buyer_contact && (
            <p className="text-xs text-muted-foreground mt-1">{loi.buyer_contact}</p>
          )}
          <p className="text-xs text-muted-foreground/80 mt-2 italic">
            {t("portal-loi-you-are-seller")}
          </p>
        </div>

        {/* Summary tiles */}
        <div className="grid grid-cols-2 gap-3">
          <SummaryTile icon={Calendar} label={t("portal-loi-sent-on")} value={fmtDate(loi.sent_at)} />
          <SummaryTile icon={Hourglass} label={t("portal-col-valid-until")} value={fmtDate(loi.validity_until)} />
          <SummaryTile icon={DollarSign} label={t("portal-detail-currency")} value={loi.currency} />
          {loi.responded_at && (
            <SummaryTile icon={CheckCircle2} label={t("portal-loi-responded")} value={fmtDate(loi.responded_at)} />
          )}
        </div>

        {/* Product */}
        <div>
          <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
            <Package className="size-4 text-primary" />
            {t("portal-loi-product")}
          </h3>
          <div className="rounded-lg border border-border/60 shadow-soft overflow-hidden">
            <div className="p-4 space-y-2">
              <p className="text-sm font-semibold">{loi.product_name}</p>
              {loi.product_description && (
                <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
                  {loi.product_description}
                </p>
              )}
              <div className="flex flex-wrap gap-2 pt-1">
                {loi.hs_code && (
                  <Badge variant="outline" className="text-xs gap-1 font-mono">
                    <ClipboardList className="size-3" /> HS {loi.hs_code}
                  </Badge>
                )}
                {loi.origin_country && (
                  <Badge variant="outline" className="text-xs gap-1">
                    <Globe className="size-3" /> {loi.origin_country}
                  </Badge>
                )}
              </div>
            </div>
            <Table>
              <TableBody>
                <TableRow>
                  <TableCell className="text-xs text-muted-foreground w-[45%]">
                    {t("portal-loi-quantity")}
                  </TableCell>
                  <TableCell className="text-right text-sm font-medium tabular">
                    {loi.quantity} {loi.unit}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-xs text-muted-foreground">
                    {t("portal-loi-unit-price")}
                  </TableCell>
                  <TableCell className="text-right text-sm tabular">
                    {fmtMoney(loi.unit_price, loi.currency)}
                  </TableCell>
                </TableRow>
                <TableRow className="bg-muted/30">
                  <TableCell className="text-xs font-semibold">
                    {t("portal-loi-total-value")}
                  </TableCell>
                  <TableCell className="text-right text-sm font-bold tabular text-gradient-emerald">
                    {fmtMoney(loi.total_value, loi.currency)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </div>

        {/* COA (Certificate of Analysis) */}
        {coaEntries.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
              <FileCheck2 className="size-4 text-primary" />
              {t("portal-loi-coa")}
            </h3>
            <div className="rounded-lg border border-border/60 shadow-soft divide-y divide-border/60">
              {coaEntries.map((entry, i) => (
                <div key={`coa-${i}`} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="text-muted-foreground">{entry.name}</span>
                  <span className="font-medium tabular">{entry.value}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Specifications */}
        {specEntries.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
              <ClipboardList className="size-4 text-primary" />
              {t("portal-loi-specs")}
            </h3>
            <div className="rounded-lg border border-border/60 shadow-soft divide-y divide-border/60">
              {specEntries.map((entry, i) => (
                <div key={`spec-${i}`} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="text-muted-foreground">{entry.name}</span>
                  <span className="font-medium tabular max-w-[55%] text-right">{entry.value}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Commercial terms */}
        {(loi.delivery_terms || loi.delivery_date || loi.payment_terms) && (
          <div>
            <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
              <Truck className="size-4 text-primary" />
              {t("portal-loi-commercial-terms")}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {loi.delivery_terms && (
                <SummaryTile icon={Truck} label={t("portal-loi-delivery-terms")} value={loi.delivery_terms} />
              )}
              {loi.delivery_date && (
                <SummaryTile icon={Calendar} label={t("portal-loi-delivery-date")} value={fmtDate(loi.delivery_date)} />
              )}
              {loi.payment_terms && (
                <SummaryTile icon={CreditCard} label={t("portal-loi-payment-terms")} value={loi.payment_terms} />
              )}
            </div>
          </div>
        )}

        {/* LOI legal text */}
        {loi.terms_text && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
              {t("portal-loi-terms")}
            </p>
            <div className="rounded-lg border border-border/60 bg-muted/20 p-4">
              <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
                {loi.terms_text}
              </p>
            </div>
          </div>
        )}

        {/* Notes */}
        {loi.notes && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
              {t("portal-detail-notes")}
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
              {loi.notes}
            </p>
          </div>
        )}

        {/* Non-binding notice */}
        <p className="text-xs text-muted-foreground/70 italic border-t border-border/40 pt-3">
          {t("portal-loi-nonbinding")}
        </p>

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
                {tier === "premium" && <Crown className="size-3.5 text-amber-600" />}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5 max-w-xs mx-auto">
                {tier === "premium" ? t("portal-pdf-locked-premium") : t("portal-pdf-locked-loi")}
              </p>
            </div>
          )}
        </div>

        {/* Accept / Reject — only while the LOI awaits the seller's response */}
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

        {/* Terminal state note */}
        {!canRespond && loi.status === "accepted" && (
          <div className="rounded-lg border border-emerald-600/30 bg-emerald-600/5 p-3 flex items-start gap-2">
            <CheckCircle2 className="size-4 text-emerald-600 mt-0.5 shrink-0" />
            <p className="text-xs text-muted-foreground">{t("portal-loi-accepted-note")}</p>
          </div>
        )}
        {!canRespond && loi.status === "rejected" && (
          <div className="rounded-lg border border-rose-600/30 bg-rose-600/5 p-3 flex items-start gap-2">
            <XCircle className="size-4 text-rose-600 mt-0.5 shrink-0" />
            <p className="text-xs text-muted-foreground">{t("portal-loi-rejected-note")}</p>
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
      <p className="text-sm font-medium tabular mt-1 break-words">{value}</p>
    </div>
  );
}
