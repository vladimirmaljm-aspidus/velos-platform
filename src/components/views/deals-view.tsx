"use client";

import { useState, useEffect, useMemo } from "react";
import { useNewShortcut } from "@/lib/hooks/use-new-shortcut";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card, CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Collapsible, CollapsibleTrigger, CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  Pagination, PaginationContent, PaginationItem, PaginationPrevious, PaginationNext,
} from "@/components/ui/pagination";
import {
  Plus, Search, Handshake, Pencil, Trash2, Eye, Calendar, User, TrendingUp, LayoutGrid, List,
  FileText, Loader2, MapPin, Mail, Phone, DollarSign, BarChart3, Target, CheckCircle2,
  ChevronDown, ChevronUp, ArrowRight, Package, Scale,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { fmtMoney, fmtDate, fmtRelative } from "@/lib/utils/format";
import { Deal, DealStage, Partner, Offer, CommissionAgent } from "@/lib/supabase/types";
import { useAppStore } from "@/lib/store/app-store";
import { CURRENCIES, DEAL_STAGES, COUNTRIES } from "@/lib/data/reference";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { usePageSize } from "@/lib/hooks/use-page-size";
import { PageSizeSelector } from "@/components/common/page-size-selector";
import { useDebounced } from "@/lib/hooks/use-debounced";
import { useT } from "@/lib/i18n/store";
import { PartnerPicker } from "@/components/common/partner-picker";

const STAGES: DealStage[] = ["lead", "qualified", "proposal", "negotiation", "won", "lost"];

// Deal stage label resolver — keys are translation keys; values fall back to raw stage.
const STAGE_LABEL_KEYS: Record<DealStage, string> = {
  lead: "crm-stage-lead",
  qualified: "crm-stage-qualified",
  proposal: "crm-stage-proposal",
  negotiation: "crm-stage-negotiation",
  won: "crm-stage-won",
  lost: "crm-stage-lost",
};

const STAGE_TEXT: Record<DealStage, string> = {
  lead: "text-muted-foreground",
  qualified: "text-chart-3",
  proposal: "text-chart-4",
  negotiation: "text-chart-1",
  won: "text-primary",
  lost: "text-destructive",
};

const STAGE_BORDER: Record<DealStage, string> = {
  lead: "border-l-muted-foreground",
  qualified: "border-l-chart-3",
  proposal: "border-l-chart-4",
  negotiation: "border-l-chart-1",
  won: "border-l-primary",
  lost: "border-l-destructive",
};

const STAGE_DOT: Record<DealStage, string> = {
  lead: "bg-muted-foreground",
  qualified: "bg-chart-3",
  proposal: "bg-chart-4",
  negotiation: "bg-chart-1",
  won: "bg-primary",
  lost: "bg-destructive",
};

const STAGE_BADGE: Record<DealStage, string> = {
  lead: "bg-muted text-muted-foreground",
  qualified: "bg-[var(--chart-3)]/15 text-chart-3",
  proposal: "bg-[var(--chart-4)]/15 text-chart-4",
  negotiation: "bg-[var(--chart-1)]/15 text-chart-1",
  won: "bg-primary/15 text-primary",
  lost: "bg-destructive/10 text-destructive",
};

const CURRENCIES_LIST = CURRENCIES; // from reference data

const OPEN_STAGES: DealStage[] = ["lead", "qualified", "proposal", "negotiation"];

// ---- Partner context type ----
interface PartnerContext {
  partner: Partner;
  deals: Deal[];
  offers: Offer[];
  invoices: any[];
  proformas: any[];
  productCatalog: any[];
  supplierOffers: any[];
  portalAccess: any;
  kyc: any;
  tradeCalculations: any[];
  inventoryMovements: any[];
}

// ---- Partner quick stats ----
interface PartnerQuickStats {
  totalDealsValue: number;
  totalDeals: number;
  wonDeals: number;
  winRate: number;
  avgDealSize: number;
  currency: string;
}

function computePartnerQuickStats(ctx: PartnerContext | null): PartnerQuickStats | null {
  if (!ctx || !ctx.deals.length) return null;
  const totalDeals = ctx.deals.length;
  const wonDeals = ctx.deals.filter((d) => d.stage === "won").length;
  const totalDealsValue = ctx.deals.reduce((sum, d) => sum + (d.value || 0), 0);
  const avgDealSize = totalDealsValue / totalDeals;
  const winRate = totalDeals > 0 ? Math.round((wonDeals / totalDeals) * 100) : 0;
  const currency = ctx.partner.preferred_currency || ctx.deals[0]?.currency || "EUR";
  return { totalDealsValue, totalDeals, wonDeals, winRate, avgDealSize, currency };
}

/**
 * Full deal profit calculation.
 *
 * Total cost = (buy_cost + bank_costs + other_costs(jsonb) + commission) × exchange_rate
 * Profit     = selling_price (or deal.value fallback) − total_cost
 * Margin %   = profit / selling_price × 100
 *
 * `commissionAmount` is the externally-computed commission (from
 * /api/commission-calculate based on the linked agent's rate). It is used
 * only if the deal itself does not carry an explicit `commission_amount`
 * override.
 */
function computeDealProfit(deal: Deal, commissionAmount: number = 0) {
  const buyCost = Number(deal.buy_cost) || 0;
  const sellingPrice = Number(deal.selling_price) || Number(deal.value) || 0;
  const bankCosts = Number(deal.bank_costs) || 0;
  const otherCosts = Array.isArray(deal.costs)
    ? deal.costs.reduce((s, c) => s + (Number(c?.amount) || 0), 0)
    : 0;
  const exchangeRate = Number(deal.exchange_rate) || 1;
  const commission = Number(deal.commission_amount) || commissionAmount || 0;
  const totalCost = (buyCost + bankCosts + otherCosts + commission) * exchangeRate;
  const profit = sellingPrice - totalCost;
  const marginPct = sellingPrice > 0 ? (profit / sellingPrice) * 100 : 0;
  return {
    buyCost,
    sellingPrice,
    bankCosts,
    otherCosts,
    exchangeRate,
    commission,
    totalCost,
    profit,
    marginPct,
  };
}

export function DealsView() {
  const t = useT();
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search, 300);
  const [stageFilter, setStageFilter] = useState<string>("all");
  const [partnerId, setPartnerId] = useState<string>("all");
  const [layout, setLayout] = useState<"pipeline" | "table">("pipeline");
  const [editing, setEditing] = useState<Deal | null>(null);
  const [showForm, setShowForm] = useState(false);
  useNewShortcut(() => { setEditing(null); setShowForm(true); });
  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const { pageSize: PAGE_SIZE, setPageSize, options: pageSizeOptions } = usePageSize("deals", 20);
// eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setPage(1); }, [PAGE_SIZE]);

  const { data, isLoading } = useQuery({
    queryKey: ["deals", tenantKey, debouncedSearch, stageFilter, partnerId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (stageFilter !== "all") params.set("stage", stageFilter);
      if (partnerId !== "all") params.set("partner_id", partnerId);
      const r = await fetch(api(`/api/deals?${params}`));
      if (!r.ok) throw new Error("Failed to load deals");
      return r.json() as Promise<{ items: Deal[]; total: number }>;
    },
  });

  const { data: partnersData } = useQuery({
    queryKey: ["partners", tenantKey, "list", 200],
    queryFn: async () => {
      const r = await fetch(api(`/api/partners?limit=200`));
      if (!r.ok) throw new Error("Failed to load partners");
      return r.json() as Promise<{ items: Partner[]; total: number }>;
    },
  });

  const partners = partnersData?.items || [];
  const partnerName = useMemo(() => {
    const map = new Map<string, string>();
    partners.forEach((p) => map.set(p.id, p.name));
    return map;
  }, [partners]);

  const allItems = data?.items || [];
  const totalPages = Math.max(1, Math.ceil(allItems.length / PAGE_SIZE));
  const effectivePage = Math.min(page, totalPages);
  const items = allItems.slice((effectivePage - 1) * PAGE_SIZE, effectivePage * PAGE_SIZE);

  const selected = allItems.find((d) => d.id === detailId) || null;

  const pipelineValue = allItems
    .filter((d) => OPEN_STAGES.includes(d.stage))
    .reduce((sum, d) => sum + (d.value || 0), 0);

  const byStage = (() => {
    const map = new Map<DealStage, Deal[]>();
    STAGES.forEach((s) => map.set(s, []));
    allItems.forEach((d) => {
      if (map.has(d.stage)) map.get(d.stage)!.push(d);
    });
    return map;
  })();

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(api(`/api/deals/${id}`), { method: "DELETE" });
      if (!r.ok) throw new Error("Delete failed");
    },
    onSuccess: () => {
      toast.success(t("crm-deal-deleted"));
      qc.invalidateQueries({ queryKey: ["deals", tenantKey] });
      qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
      setDeleteId(null);
    },
    onError: () => toast.error(t("crm-delete-failed")),
  });

  const stageMut = useMutation({
    mutationFn: async ({ id, stage }: { id: string; stage: DealStage }) => {
      const r = await fetch(api(`/api/deals/${id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage }),
      });
      if (!r.ok) throw new Error("Stage change failed");
      return r.json();
    },
    onSuccess: (_data, variables) => {
      toast.success(t("crm-stage-changed-to").replace("${stage}", t(STAGE_LABEL_KEYS[variables.stage])));
      qc.invalidateQueries({ queryKey: ["deals", tenantKey] });
      qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
    },
    onError: () => toast.error(t("crm-stage-change-failed")),
  });

  return (
    <div>
      <PageHeader
        title={t("deals")}
        description={`${data?.total ?? 0} ${t("crm-total-count").replace("${n}", "")} · ${t("crm-pipeline")} ${fmtMoney(pipelineValue)}`}
        actions={
          <Button onClick={() => { setEditing(null); setShowForm(true); }}>
            <Plus className="size-4 mr-1" /> {t("crm-new-deal")}
          </Button>
        }
      />

      <Card className="mb-4 border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-3 flex flex-col md:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder={t("crm-search-by-title")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={stageFilter} onValueChange={setStageFilter}>
            <SelectTrigger className="w-full md:w-44"><SelectValue placeholder={t("crm-stage")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("crm-all-stages")}</SelectItem>
              {STAGES.map((s) => <SelectItem key={s} value={s}>{t(STAGE_LABEL_KEYS[s])}</SelectItem>)}
            </SelectContent>
          </Select>
          <PartnerPicker
            value={partnerId === "all" ? "" : partnerId}
            allowClear
            placeholder={t("crm-partner")}
            onSelect={(p) => setPartnerId(p?.id || "all")}
            className="md:w-52"
          />
          <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
            <Button
              size="sm"
              variant={layout === "pipeline" ? "default" : "ghost"}
              className="h-7"
              onClick={() => setLayout("pipeline")}
              title={t("crm-pipeline-view")}
            >
              <LayoutGrid className="size-4 mr-1" /> {t("crm-pipeline")}
            </Button>
            <Button
              size="sm"
              variant={layout === "table" ? "default" : "ghost"}
              className="h-7"
              onClick={() => setLayout("table")}
              title={t("crm-table-view")}
            >
              <List className="size-4 mr-1" /> {t("crm-table")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <Card className="border-border/60 shadow-soft rounded-xl">
          <CardContent className="p-4 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
          </CardContent>
        </Card>
      ) : allItems.length === 0 ? (
        <EmptyState
          icon={<Handshake className="size-6" />}
          title={t("crm-no-deals")}
          description={t("crm-no-deals-desc")}
          action={<Button onClick={() => { setEditing(null); setShowForm(true); }}><Plus className="size-4 mr-1" /> {t("crm-new-deal")}</Button>}
        />
      ) : layout === "pipeline" ? (
        <PipelineView
          byStage={byStage}
          partnerName={partnerName}
          onOpen={setDetailId}
        />
      ) : (
        <Card className="border-border/60 shadow-soft rounded-xl">
          <CardContent className="p-0">
            <div className="overflow-y-auto custom-scroll">
              <div className="overflow-x-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    <TableHead>{t("crm-title")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("crm-partner")}</TableHead>
                    <TableHead>{t("crm-stage")}</TableHead>
                    <TableHead className="text-right">{t("crm-value")}</TableHead>
                    <TableHead className="hidden lg:table-cell w-40">{t("crm-probability")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("crm-expected-close")}</TableHead>
                    <TableHead className="text-right">{t("actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((d) => (
                    <TableRow
                      key={d.id}
                      className="cursor-pointer hover:bg-muted/50 transition-colors"
                      onClick={() => setDetailId(d.id)}
                    >
                      <TableCell>
                        <div className="font-medium">{d.title}</div>
                        <div className="text-xs text-muted-foreground md:hidden">{partnerName.get(d.partner_id) || "—"}</div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">{partnerName.get(d.partner_id) || "—"}</TableCell>
                      <TableCell>
                        <Badge className={`${STAGE_BADGE[d.stage]} hover:opacity-90`}>
                          <span className={`size-1.5 rounded-full ${STAGE_DOT[d.stage]} mr-1`} />
                          {t(STAGE_LABEL_KEYS[d.stage])}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono tabular">{fmtMoney(d.value, d.currency)}</TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <div className="flex items-center gap-2">
                          <Progress value={d.probability} className="h-1.5 w-20" />
                          <span className="text-xs font-mono tabular text-muted-foreground">{d.probability}%</span>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm">{fmtDate(d.expected_close)}</TableCell>
                      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          <Button size="icon" variant="ghost" className="size-8" onClick={() => setDetailId(d.id)} title={t("view")}>
                            <Eye className="size-4" />
                          </Button>
                          <Button size="icon" variant="ghost" className="size-8" onClick={() => { setEditing(d); setShowForm(true); }} title={t("edit")}>
                            <Pencil className="size-4" />
                          </Button>
                          <Button size="icon" variant="ghost" className="size-8 text-destructive" onClick={() => setDeleteId(d.id)} title={t("delete")}>
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pagination + Page size (table layout only) */}
      {layout === "table" && (
        <div className="mt-4 flex items-center justify-between flex-wrap gap-3">
          <PageSizeSelector value={PAGE_SIZE} onChange={setPageSize} options={pageSizeOptions} />
          {totalPages > 1 && (
            <Pagination>
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className={page <= 1 ? "pointer-events-none opacity-50" : "cursor-pointer"}
                  />
                </PaginationItem>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                  <PaginationItem key={p}>
                    <Button
                      variant={p === page ? "default" : "outline"}
                      size="icon"
                      className="size-8"
                      onClick={() => setPage(p)}
                    >
                      {p}
                    </Button>
                  </PaginationItem>
                ))}
                <PaginationItem>
                  <PaginationNext
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    className={page >= totalPages ? "pointer-events-none opacity-50" : "cursor-pointer"}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          )}
        </div>
      )}

      {/* Form dialog */}
      <DealFormDialog
        open={showForm}
        onOpenChange={setShowForm}
        deal={editing}
        partners={partners}
        onSaved={() => {
          setShowForm(false);
          qc.invalidateQueries({ queryKey: ["deals", tenantKey] });
          qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
        }}
      />

      {/* Detail sheet */}
      <Sheet open={!!detailId} onOpenChange={(o) => !o && setDetailId(null)}>
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto custom-scroll">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Handshake className="size-5" />
              {selected?.title || t("crm-deal")}
            </SheetTitle>
            <SheetDescription>{t("crm-deal-details")}</SheetDescription>
          </SheetHeader>
          {selected ? (
            <DealDetail
              deal={selected}
              partnerName={partnerName.get(selected.partner_id) || "—"}
              partners={partners}
              onStageChange={(stage) => stageMut.mutate({ id: selected.id, stage })}
              onEdit={() => { setEditing(selected); setShowForm(true); setDetailId(null); }}
              onDelete={() => { setDeleteId(selected.id); setDetailId(null); }}
              changing={stageMut.isPending}
            />
          ) : (
            <div className="p-4 space-y-3">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("crm-delete-deal-title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("crm-delete-deal-desc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteId && deleteMut.mutate(deleteId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---- Pipeline view ----
function PipelineView({
  byStage, partnerName, onOpen,
}: {
  byStage: Map<DealStage, Deal[]>;
  partnerName: Map<string, string>;
  onOpen: (id: string) => void;
}) {
  const t = useT();
  return (
    <div className="overflow-x-auto custom-scroll pb-2">
      <div className="flex gap-3 min-w-max">
        {STAGES.map((stage) => {
          const list = byStage.get(stage) || [];
          const total = list.reduce((sum, d) => sum + (d.value || 0), 0);
          return (
            <div key={stage} className="w-72 shrink-0">
              <div className="rounded-xl bg-muted/40 border border-border/60 shadow-soft">
                <div className="p-3 border-b border-border/60">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={`size-2 rounded-full ${STAGE_DOT[stage]}`} />
                      <span className="text-sm font-medium">{t(STAGE_LABEL_KEYS[stage])}</span>
                    </div>
                    <Badge variant="secondary" className="font-mono tabular text-xs">{list.length}</Badge>
                  </div>
                  <p className={`text-xs font-mono tabular mt-1 ${STAGE_TEXT[stage]}`}>{fmtMoney(total)}</p>
                </div>
                <div className="p-2 space-y-2 max-h-[calc(100vh-380px)] overflow-y-auto custom-scroll">
                  {list.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-4">{t("crm-no-deals-pipeline")}</p>
                  )}
                  {list.map((d) => (
                    <button
                      key={d.id}
                      onClick={() => onOpen(d.id)}
                      className={`w-full text-left bg-card rounded-lg border border-l-4 ${STAGE_BORDER[stage]} p-3 hover:shadow-soft-md hover:bg-muted/30 transition-all`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium leading-tight break-words">{d.title}</p>
                        <span className="text-xs font-mono tabular shrink-0">{fmtMoney(d.value, d.currency)}</span>
                      </div>
                      <div className="flex items-center gap-1.5 mt-2 text-xs text-muted-foreground">
                        <User className="size-3" />
                        <span className="truncate">{partnerName.get(d.partner_id) || "—"}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2 mt-2">
                        <Progress value={d.probability} className="h-1 w-16" />
                        <span className="text-xs font-mono tabular text-muted-foreground">{d.probability}%</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- Detail panel ----
function DealDetail({
  deal, partnerName, partners, onStageChange, onEdit, onDelete, changing,
}: {
  deal: Deal;
  partnerName: string;
  partners: Partner[];
  onStageChange: (s: DealStage) => void;
  onEdit: () => void;
  onDelete: () => void;
  changing: boolean;
}) {
  const t = useT();
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const setView = useAppStore((s) => s.setView);
  const setSelectedId = useAppStore((s) => s.setSelectedId);

  // Fetch partner context for quick stats
  const { data: partnerCtx, isLoading: ctxLoading } = useQuery({
    queryKey: ["partner-context", tenantKey, deal.partner_id],
    queryFn: async () => {
      const r = await fetch(api(`/api/automation/partner-context?partner_id=${deal.partner_id}`));
      if (!r.ok) throw new Error("Failed to load partner context");
      return r.json() as Promise<PartnerContext>;
    },
    enabled: !!deal.partner_id,
    staleTime: 60_000,
  });

  // Check if this deal already has an associated offer
  const { data: dealOffers } = useQuery({
    queryKey: ["offers-for-deal", tenantKey, deal.id],
    queryFn: async () => {
      const r = await fetch(api(`/api/offers?limit=100`));
      if (!r.ok) throw new Error("Failed to load offers");
      const result = await r.json() as { items: Offer[]; total: number };
      return result.items.filter((o) => o.deal_id === deal.id);
    },
    enabled: !!deal.id,
    staleTime: 30_000,
  });

  const hasExistingOffer = dealOffers && dealOffers.length > 0;
  const quickStats = computePartnerQuickStats(partnerCtx ?? null);

  // Commission agents — loaded so we can resolve the agent's partner name and
  // rate for display in the detail panel (audit issue D-3: previously showed
  // the raw UUID).
  const { data: agentsData } = useQuery({
    queryKey: ["commission-agents", tenantKey],
    queryFn: async () => {
      const r = await fetch(api(`/api/commission-agents?limit=200`));
      if (!r.ok) throw new Error("Failed to load commission agents");
      return r.json() as Promise<{ items: CommissionAgent[]; total: number }>;
    },
    enabled: !!deal.commission_agent_id,
  });
  const commissionAgents = agentsData?.items || [];
  const commissionAgent = deal.commission_agent_id
    ? commissionAgents.find((a) => a.id === deal.commission_agent_id) || null
    : null;
  const commissionAgentPartnerName = commissionAgent
    ? partners.find((p) => p.id === commissionAgent.partner_id)?.name || null
    : null;

  // Commission preview — uses the same /api/commission-calculate endpoint as
  // the form so the displayed commission matches what will be recorded when
  // the deal is won.
  const { data: commissionPreview } = useQuery({
    queryKey: ["commission-preview", tenantKey, deal.id, deal.commission_agent_id, deal.value, deal.buy_cost, deal.quantity],
    queryFn: async () => {
      if (!deal.commission_agent_id) return null;
      const r = await fetch(api(`/api/commission-calculate`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: deal.commission_agent_id,
          deal_value: deal.value || 0,
          deal_profit: (deal.value || 0) - (deal.buy_cost || 0),
          deal_quantity: deal.quantity || 0,
          deal_unit: deal.unit || "",
          currency: deal.currency || "USD",
        }),
      });
      if (!r.ok) return null;
      return r.json() as Promise<{ calculated_commission: number; currency: string } | null>;
    },
    enabled: !!deal.commission_agent_id,
  });
  const previewCommission = Number(commissionPreview?.calculated_commission) || 0;
  const calc = computeDealProfit(deal, previewCommission);

  // Create offer from deal mutation
  const createOfferMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(api("/api/automation/create-offer-from-deal"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deal_id: deal.id }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to create offer");
      }
      return r.json();
    },
    onSuccess: (data) => {
      toast.success(t("crm-offer-created-from-deal"), {
        description: t("crm-offer-created-from-deal-desc").replace("${number}", data.number || ""),
        action: {
          label: t("crm-view-offer"),
          onClick: () => {
            setSelectedId(data.id);
            setView("offers");
          },
        },
      });
    },
    onError: (e: any) => {
      toast.error(e.message || t("crm-failed-create-offer-from-deal"));
    },
  });

  // Core info cards
  const info = [
    { icon: User, label: t("crm-partner"), value: partnerName },
    { icon: TrendingUp, label: t("crm-value"), value: fmtMoney(deal.value, deal.currency) },
    { icon: Calendar, label: t("crm-expected-close"), value: fmtDate(deal.expected_close) },
  ];

  // Additional deal data — full cost breakdown (audit D-2, D-4)
  const additionalInfo: { icon: typeof DollarSign; label: string; value: string; accent?: string }[] = [];
  if (calc.buyCost) additionalInfo.push({
    icon: DollarSign,
    label: t("crm-buy-cost-total") + (deal.purchase_currency && deal.purchase_currency !== deal.currency ? ` (${deal.purchase_currency})` : ""),
    value: fmtMoney(calc.buyCost, deal.purchase_currency || deal.currency),
  });
  if (calc.sellingPrice && calc.sellingPrice !== deal.value) additionalInfo.push({
    icon: TrendingUp,
    label: t("crm-selling-price-total") + (deal.selling_currency && deal.selling_currency !== deal.currency ? ` (${deal.selling_currency})` : ""),
    value: fmtMoney(calc.sellingPrice, deal.selling_currency || deal.currency),
  });
  if (calc.bankCosts) additionalInfo.push({ icon: DollarSign, label: t("crm-bank-costs"), value: fmtMoney(calc.bankCosts, deal.currency) });
  if (calc.otherCosts) additionalInfo.push({ icon: DollarSign, label: t("crm-other-costs"), value: fmtMoney(calc.otherCosts, deal.currency) });
  if (calc.commission) additionalInfo.push({ icon: DollarSign, label: t("crm-commission"), value: fmtMoney(calc.commission, commissionPreview?.currency || deal.currency) });
  if (calc.exchangeRate && calc.exchangeRate !== 1) additionalInfo.push({ icon: ArrowRight, label: t("crm-exchange-rate"), value: calc.exchangeRate.toString() });
  if (calc.totalCost) additionalInfo.push({ icon: BarChart3, label: t("crm-total-cost"), value: fmtMoney(calc.totalCost, deal.currency) });
  if (calc.profit !== 0 || (calc.buyCost && calc.sellingPrice)) additionalInfo.push({
    icon: TrendingUp,
    label: t("crm-profit"),
    value: fmtMoney(calc.profit, deal.currency),
    accent: calc.profit >= 0 ? "text-chart-1" : "text-destructive",
  });
  additionalInfo.push({
    icon: Target,
    label: t("crm-margin-label"),
    value: `${calc.marginPct.toFixed(1)}%`,
    accent: calc.marginPct >= 0 ? "text-chart-1" : "text-destructive",
  });
  if (deal.quantity) additionalInfo.push({ icon: Package, label: t("crm-quantity-label"), value: `${deal.quantity} ${deal.unit || ""}` });
  if (deal.unit && !deal.quantity) additionalInfo.push({ icon: Scale, label: t("crm-unit"), value: deal.unit });
  if (commissionAgent) {
    const rateLabel =
      commissionAgent.commission_type === "profit_percent" ? t("crm-rate-profit-percent").replace("${rate}", String(commissionAgent.commission_rate))
      : commissionAgent.commission_type === "revenue_percent" ? t("crm-rate-revenue-percent").replace("${rate}", String(commissionAgent.commission_rate))
      : commissionAgent.commission_type === "per_unit" ? t("crm-rate-per-unit").replace("${rate}", String(commissionAgent.commission_per_unit))
      : commissionAgent.commission_type === "fixed" ? t("crm-rate-fixed").replace("${rate}", String(commissionAgent.commission_rate))
      : commissionAgent.commission_type;
    additionalInfo.push({ icon: User, label: t("crm-commission-agent"), value: `${commissionAgentPartnerName || t("crm-unknown")} (${rateLabel})` });
  }

  return (
    <div className="px-4 pb-6 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className={`${STAGE_BADGE[deal.stage]} hover:opacity-90`}>
          <span className={`size-1.5 rounded-full ${STAGE_DOT[deal.stage]} mr-1`} />
          {t(STAGE_LABEL_KEYS[deal.stage])}
        </Badge>
        <Badge variant="outline" className="font-mono tabular">{deal.probability}%</Badge>
        <Badge variant="secondary" className="font-mono">{deal.currency}</Badge>
      </div>

      {/* Quick stage change */}
      <div>
        <p className="text-xs text-muted-foreground mb-2">{t("crm-quick-stage-change")}</p>
        <div className="flex flex-wrap gap-1.5">
          {STAGES.map((s) => (
            <button
              key={s}
              disabled={changing || s === deal.stage}
              onClick={() => onStageChange(s)}
              className={`text-xs px-2.5 py-1 rounded-md border transition ${
                s === deal.stage
                  ? `${STAGE_BADGE[s]} border-transparent font-medium`
                  : "bg-card hover:bg-muted/50 border-border text-muted-foreground"
              } disabled:opacity-60`}
            >
              {t(STAGE_LABEL_KEYS[s])}
            </button>
          ))}
        </div>
      </div>

      {/* Core info */}
      <div className="grid grid-cols-1 gap-2">
        {info.map((x) => {
          const Icon = x.icon;
          return (
            <Card key={x.label} className="border-border/60 shadow-soft rounded-xl">
              <CardContent className="p-3 flex items-center gap-3">
                <Icon className="size-4 text-muted-foreground shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{x.label}</p>
                  <p className="text-sm font-medium break-words">{x.value}</p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Additional deal data (cost tracking, commission, etc.) */}
      {additionalInfo.length > 0 && (
        <Card className="border-border/60 shadow-soft rounded-xl">
          <CardContent className="p-3 space-y-2">
            <div className="flex items-center gap-2">
              <BarChart3 className="size-4 text-primary" />
              <p className="text-xs font-medium text-muted-foreground">{t("crm-deal-details-card")}</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {additionalInfo.map((x) => {
                const Icon = x.icon;
                return (
                  <div key={x.label} className="p-2 rounded bg-muted/50">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <Icon className="size-3 text-muted-foreground" />
                      <p className="text-xs text-muted-foreground">{x.label}</p>
                    </div>
                    <p className={`text-xs font-medium font-mono tabular ${x.accent || ""}`}>{x.value}</p>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Partner Quick Stats */}
      {ctxLoading ? (
        <Card className="border-border/60 shadow-soft rounded-xl">
          <CardContent className="p-3 space-y-2">
            <Skeleton className="h-4 w-32" />
            <div className="grid grid-cols-3 gap-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          </CardContent>
        </Card>
      ) : quickStats ? (
        <Card className="border-border/60 shadow-soft rounded-xl bg-gradient-to-br from-muted/30 to-muted/10">
          <CardContent className="p-3 space-y-2">
            <div className="flex items-center gap-2">
              <BarChart3 className="size-4 text-primary" />
              <p className="text-xs font-medium text-muted-foreground">{t("crm-partner-quick-stats")}</p>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="text-center p-2 rounded-lg bg-card/80 border border-border/40">
                <DollarSign className="size-3.5 text-chart-3 mx-auto mb-1" />
                <p className="text-xs text-muted-foreground">{t("crm-total-value")}</p>
                <p className="text-xs font-semibold font-mono tabular">{fmtMoney(quickStats.totalDealsValue, quickStats.currency)}</p>
              </div>
              <div className="text-center p-2 rounded-lg bg-card/80 border border-border/40">
                <Target className="size-3.5 text-chart-4 mx-auto mb-1" />
                <p className="text-xs text-muted-foreground">{t("crm-win-rate")}</p>
                <p className="text-xs font-semibold font-mono tabular">{quickStats.winRate}%</p>
              </div>
              <div className="text-center p-2 rounded-lg bg-card/80 border border-border/40">
                <TrendingUp className="size-3.5 text-chart-1 mx-auto mb-1" />
                <p className="text-xs text-muted-foreground">{t("crm-avg-deal")}</p>
                <p className="text-xs font-semibold font-mono tabular">{fmtMoney(quickStats.avgDealSize, quickStats.currency)}</p>
              </div>
            </div>
            {partnerCtx && partnerCtx.deals.length > 0 && (
              <div className="pt-1">
                <p className="text-xs text-muted-foreground mb-1">{t("crm-recent-deals-won").replace("${won}", String(quickStats.wonDeals)).replace("${total}", String(quickStats.totalDeals))}</p>
                <div className="space-y-1 max-h-24 overflow-y-auto custom-scroll">
                  {partnerCtx.deals.slice(0, 5).map((d) => (
                    <div key={d.id} className="flex items-center justify-between text-xs px-1.5 py-0.5 rounded bg-muted/40">
                      <span className="truncate max-w-[60%]">{d.title}</span>
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono tabular text-muted-foreground">{fmtMoney(d.value, d.currency)}</span>
                        <Badge className={`${STAGE_BADGE[d.stage]} text-[9px] px-1 py-0`}>
                          {t(STAGE_LABEL_KEYS[d.stage])}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* Create Offer from Deal */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-3 space-y-2">
          <div className="flex items-center gap-2">
            <FileText className="size-4 text-primary" />
            <p className="text-xs font-medium">{t("crm-create-offer-from-deal")}</p>
          </div>
          {hasExistingOffer ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <CheckCircle2 className="size-3.5 text-chart-3" />
                <span>{t("crm-this-deal-already-offer")}</span>
              </div>
              {dealOffers && dealOffers.length > 0 && (
                <div className="space-y-1">
                  {dealOffers.map((o) => (
                    <button
                      key={o.id}
                      onClick={() => {
                        setSelectedId(o.id);
                        setView("offers");
                      }}
                      className="w-full flex items-center justify-between text-xs px-2 py-1.5 rounded-md bg-muted/50 hover:bg-muted transition-colors"
                    >
                      <span className="font-medium">{o.number}</span>
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className="text-[9px] px-1 py-0">{o.status}</Badge>
                        <span className="font-mono tabular">{fmtMoney(o.total, o.currency)}</span>
                        <ArrowRight className="size-3 text-muted-foreground" />
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div>
              <p className="text-xs text-muted-foreground mb-2">
                {t("crm-auto-create-offer-desc")}
              </p>
              <Button
                size="sm"
                onClick={() => createOfferMut.mutate()}
                disabled={createOfferMut.isPending}
                className="w-full"
              >
                {createOfferMut.isPending ? (
                  <>
                    <Loader2 className="size-4 mr-1 animate-spin" /> {t("crm-creating-ellipsis")}
                  </>
                ) : (
                  <>
                    <FileText className="size-4 mr-1" /> {t("crm-create-offer-from-deal")}
                  </>
                )}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {deal.description && (
        <div>
          <p className="text-xs text-muted-foreground mb-1">{t("description")}</p>
          <p className="text-sm whitespace-pre-wrap p-3 rounded-md bg-muted/50">{deal.description}</p>
        </div>
      )}

      {deal.lost_reason && (
        <div>
          <p className="text-xs text-muted-foreground mb-1">{t("crm-lost-reason")}</p>
          <p className="text-sm whitespace-pre-wrap p-3 rounded-md bg-destructive/5 text-destructive">{deal.lost_reason}</p>
        </div>
      )}

      <div className="flex items-center gap-2 pt-2">
        <Button variant="outline" size="sm" onClick={onEdit}>
          <Pencil className="size-4 mr-1" /> {t("edit")}
        </Button>
        <Button variant="outline" size="sm" className="text-destructive" onClick={onDelete}>
          <Trash2 className="size-4 mr-1" /> {t("delete")}
        </Button>
      </div>

      <div className="pt-4 border-t space-y-1">
        <p className="text-xs text-muted-foreground">{t("crm-created-label")}: {fmtDate(deal.created_at)}</p>
        <p className="text-xs text-muted-foreground">{t("crm-updated-label")}: {fmtRelative(deal.updated_at)}</p>
      </div>
    </div>
  );
}

// ---- Stage-to-probability mapping ----
const STAGE_PROBABILITY: Record<DealStage, number> = {
  lead: 20,
  qualified: 40,
  proposal: 60,
  negotiation: 80,
  won: 100,
  lost: 0,
};

// ---- Form dialog ----
function DealFormDialog({
  open, onOpenChange, deal, partners, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  deal: Deal | null;
  partners: Partner[];
  onSaved: () => void;
}) {
  const t = useT();
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const isEditing = !!deal;
  const [form, setForm] = useState<Partial<Deal>>({});
  const [saving, setSaving] = useState(false);

  // Collapsible section state — all open when editing, closed when creating
  const [detailsOpen, setDetailsOpen] = useState(isEditing);
  const [lineItemsOpen, setLineItemsOpen] = useState(isEditing);
  const [commissionOpen, setCommissionOpen] = useState(isEditing);

  // Partner auto-fill context
  const [selectedPartnerId, setSelectedPartnerId] = useState<string>("");
  const [showPartnerContext, setShowPartnerContext] = useState(false);

  // Commission agents
  const { data: agentsData } = useQuery({
    queryKey: ["commission-agents", tenantKey],
    queryFn: async () => {
      const r = await fetch(api(`/api/commission-agents?limit=200`));
      if (!r.ok) throw new Error("Failed to load commission agents");
      return r.json() as Promise<{ items: CommissionAgent[]; total: number }>;
    },
    enabled: open,
  });
  const commissionAgents = agentsData?.items || [];

  // Commission preview — debounced so we don't fire /api/commission-calculate
  // on every keystroke (audit D-4: previously fired on every value/buy_cost/
  // quantity change).
  const debouncedValue = useDebounced(form.value, 400);
  const debouncedBuyCost = useDebounced(form.buy_cost, 400);
  const debouncedQuantity = useDebounced(form.quantity, 400);
  const { data: commissionPreview } = useQuery({
    queryKey: ["commission-preview", tenantKey, form.commission_agent_id, debouncedValue, debouncedBuyCost, debouncedQuantity],
    queryFn: async () => {
      if (!form.commission_agent_id) return null;
      const r = await fetch(api(`/api/commission-calculate`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: form.commission_agent_id,
          deal_value: debouncedValue || 0,
          deal_profit: (debouncedValue || 0) - (debouncedBuyCost || 0),
          deal_quantity: debouncedQuantity || 0,
          deal_unit: form.unit || "",
          currency: form.currency || "USD",
        }),
      });
      if (!r.ok) return null;
      return r.json() as Promise<{
        calculated_commission: number;
        currency: string;
        commission_type?: string;
        breakdown?: { formula?: string };
      } | null>;
    },
    enabled: !!form.commission_agent_id && open,
  });
  const previewCommission = Number(commissionPreview?.calculated_commission) || 0;

  // Live deal profit calc for the form preview (audit D-2: include all costs).
  const formCalc = computeDealProfit(form as Deal, previewCommission);

  const { data: partnerCtx, isLoading: ctxLoading } = useQuery({
    queryKey: ["partner-context", tenantKey, selectedPartnerId],
    queryFn: async () => {
      const r = await fetch(api(`/api/automation/partner-context?partner_id=${selectedPartnerId}`));
      if (!r.ok) throw new Error("Failed to load partner context");
      return r.json() as Promise<PartnerContext>;
    },
    enabled: !!selectedPartnerId && open,
    staleTime: 60_000,
  });

  const quickStats = computePartnerQuickStats(partnerCtx ?? null);

  // Fix: useMemo → useEffect for form initialization side effects
  useEffect(() => {
    if (open) {
      const initial = deal ? { ...deal } : {
        stage: "qualified" as DealStage,
        value: 0,
        currency: "USD",
        probability: 20,
        partner_id: partners[0]?.id || "",
      };
// eslint-disable-next-line react-hooks/set-state-in-effect
      setForm(initial);
      setSelectedPartnerId(initial.partner_id || "");

      // Expand all sections when editing, collapse when creating
      if (deal) {
        setDetailsOpen(true);
        setLineItemsOpen(true);
        setCommissionOpen(true);
      } else {
        setDetailsOpen(false);
        setLineItemsOpen(false);
        setCommissionOpen(false);
      }
    }
  }, [open, deal, partners]);

  // Auto-fill partner data when partner context loads
  useEffect(() => {
    if (partnerCtx && open && !deal) {
      const partner = partnerCtx.partner;
      const updates: Partial<Deal> = {};

      // Auto-fill currency from partner preference
      if (partner.preferred_currency && !form.currency) {
        updates.currency = partner.preferred_currency;
      }

      // Auto-stage progression: if value > 0 and partner selected → "qualified", else → "lead"
      if (form.value && form.value > 0 && form.partner_id) {
        updates.stage = "qualified";
        updates.probability = STAGE_PROBABILITY["qualified"];
      } else if (!form.value || form.value === 0) {
        updates.stage = "lead";
        updates.probability = STAGE_PROBABILITY["lead"];
      }

      if (Object.keys(updates).length > 0) {
// eslint-disable-next-line react-hooks/set-state-in-effect
        setForm((f) => ({ ...f, ...updates }));
      }
    }
  }, [partnerCtx, open, deal]);

  function set<K extends keyof Deal>(k: K, v: Deal[K]) {
    setForm((f) => {
      const updated = { ...f, [k]: v };

      // Auto-stage progression: when value changes
      if (k === "value") {
        if (v && Number(v) > 0 && updated.partner_id) {
          updated.stage = "qualified";
          updated.probability = STAGE_PROBABILITY["qualified"];
        } else {
          updated.stage = "lead";
          updated.probability = STAGE_PROBABILITY["lead"];
        }
      }

      // Auto-stage progression: when partner changes
      if (k === "partner_id") {
        if (v && updated.value && Number(updated.value) > 0) {
          updated.stage = "qualified";
          updated.probability = STAGE_PROBABILITY["qualified"];
        } else if (!v || !updated.value || Number(updated.value) === 0) {
          updated.stage = "lead";
          updated.probability = STAGE_PROBABILITY["lead"];
        }
      }

      // Auto-probability: when stage changes, update probability to match
      if (k === "stage") {
        const stageVal = v as DealStage;
        if (stageVal in STAGE_PROBABILITY) {
          updated.probability = STAGE_PROBABILITY[stageVal];
        }
      }

      return updated;
    });
  }

  function handlePartnerChange(partnerId: string) {
    set("partner_id", partnerId as Deal["partner_id"]);
    setSelectedPartnerId(partnerId);

    // Auto-fill currency from partner if available
    const partner = partners.find((p) => p.id === partnerId);
    if (partner?.preferred_currency) {
      setForm((f) => ({ ...f, currency: partner.preferred_currency! as Deal["currency"] }));
    }
  }

  async function save() {
    if (!form.title) { toast.error(t("crm-title-required")); return; }
    if (!form.partner_id) { toast.error(t("crm-select-a-partner-toast")); return; }
    setSaving(true);
    try {
      const method = deal ? "PUT" : "POST";
      const url = deal ? api(`/api/deals/${deal.id}`) : api("/api/deals");
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Request failed");
      }
      toast.success(deal ? t("crm-deal-updated") : t("crm-deal-created").replace("${title}", form.title || ""), {
        description: deal ? undefined : t("crm-added-to-pipeline"),
      });
      onSaved();
    } catch (e: any) {
      toast.error(e.message || t("crm-saving-failed-toast"));
    } finally {
      setSaving(false);
    }
  }

  const expectedCloseValue = form.expected_close
    ? new Date(form.expected_close).toISOString().slice(0, 10)
    : "";

  // Get the selected partner for auto-fill display
  const selectedPartner = partners.find((p) => p.id === form.partner_id);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle>{deal ? t("crm-edit-deal") : t("crm-new-deal")}</DialogTitle>
          <DialogDescription>
            {deal ? t("crm-update-deal-details") : t("crm-create-deal-desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
          {/* ===== Essential fields (always visible) ===== */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="md:col-span-2 space-y-1.5">
              <Label>{t("crm-title-required-label")}</Label>
              <Input value={form.title || ""} onChange={(e) => set("title", e.target.value)} placeholder={t("crm-search-by-title")} />
            </div>

            <div className="space-y-1.5">
              <Label>{t("crm-partner-required-label")}</Label>
              <PartnerPicker
                value={form.partner_id || ""}
                fallbackName={selectedPartner?.name}
                placeholder={t("crm-select-a-partner")}
                onSelect={(p) => p?.id && handlePartnerChange(p.id)}
              />
            </div>

            <div className="space-y-1.5">
              <Label>{t("crm-stage")}</Label>
              <Select value={form.stage} onValueChange={(v) => set("stage", v as DealStage)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STAGES.map((s) => <SelectItem key={s} value={s}>{t(STAGE_LABEL_KEYS[s])}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>{t("crm-value")}</Label>
              <Input type="number" min={0} step="0.01" value={form.value ?? 0} onChange={(e) => set("value", Number(e.target.value))} />
              {form.value && Number(form.value) > 0 && form.partner_id && (
                <p className="text-xs text-chart-3 flex items-center gap-1">
                  <CheckCircle2 className="size-3" /> {t("crm-auto-staged-qualified")}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>{t("currency")}</Label>
              <Select value={form.currency} onValueChange={(v) => set("currency", v)}>
                <SelectTrigger><SelectValue placeholder={t("crm-select-currency")} /></SelectTrigger>
                <SelectContent className="max-h-72">
                  {CURRENCIES_LIST.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Auto-fill info card when partner is selected */}
          {selectedPartner && (
            <Card className="border-primary/20 bg-primary/5 shadow-soft rounded-xl">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="size-3.5 text-primary" />
                    <span className="text-xs font-medium text-primary">{t("crm-auto-filled-from-partner")}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs"
                    onClick={() => setShowPartnerContext(!showPartnerContext)}
                  >
                    {showPartnerContext ? t("crm-hide-details") : t("crm-show-details")}
                    {showPartnerContext ? <ChevronUp className="size-3 ml-1" /> : <ChevronDown className="size-3 ml-1" />}
                  </Button>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                  {selectedPartner.address_line && (
                    <div className="flex items-start gap-1.5">
                      <MapPin className="size-3 text-muted-foreground mt-0.5 shrink-0" />
                      <span className="text-muted-foreground truncate">
                        {selectedPartner.city || selectedPartner.country || selectedPartner.address_line}
                      </span>
                    </div>
                  )}
                  {selectedPartner.preferred_currency && (
                    <div className="flex items-center gap-1.5">
                      <DollarSign className="size-3 text-muted-foreground shrink-0" />
                      <span className="text-muted-foreground">{selectedPartner.preferred_currency}</span>
                    </div>
                  )}
                  {selectedPartner.contact_email && (
                    <div className="flex items-center gap-1.5">
                      <Mail className="size-3 text-muted-foreground shrink-0" />
                      <span className="text-muted-foreground truncate">{selectedPartner.contact_email}</span>
                    </div>
                  )}
                  {selectedPartner.contact_phone && (
                    <div className="flex items-center gap-1.5">
                      <Phone className="size-3 text-muted-foreground shrink-0" />
                      <span className="text-muted-foreground">{selectedPartner.contact_phone}</span>
                    </div>
                  )}
                </div>

                {/* Expandable partner context details */}
                {showPartnerContext && (
                  <div className="mt-3 pt-3 border-t border-primary/10 space-y-3">
                    {/* Quick stats */}
                    {ctxLoading ? (
                      <div className="space-y-1">
                        <Skeleton className="h-4 w-24" />
                        <div className="grid grid-cols-3 gap-2">
                          <Skeleton className="h-10 w-full" />
                          <Skeleton className="h-10 w-full" />
                          <Skeleton className="h-10 w-full" />
                        </div>
                      </div>
                    ) : quickStats ? (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1.5">{t("crm-partner-quick-stats")}</p>
                        <div className="grid grid-cols-3 gap-2">
                          <div className="text-center p-1.5 rounded bg-card/80 border border-border/40">
                            <p className="text-[9px] text-muted-foreground">{t("crm-total-value")}</p>
                            <p className="text-xs font-semibold font-mono tabular">{fmtMoney(quickStats.totalDealsValue, quickStats.currency)}</p>
                          </div>
                          <div className="text-center p-1.5 rounded bg-card/80 border border-border/40">
                            <p className="text-[9px] text-muted-foreground">{t("crm-win-rate")}</p>
                            <p className="text-xs font-semibold font-mono tabular">{quickStats.winRate}%</p>
                          </div>
                          <div className="text-center p-1.5 rounded bg-card/80 border border-border/40">
                            <p className="text-[9px] text-muted-foreground">{t("crm-avg-deal")}</p>
                            <p className="text-xs font-semibold font-mono tabular">{fmtMoney(quickStats.avgDealSize, quickStats.currency)}</p>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">{t("crm-no-historical-data-partner")}</p>
                    )}

                    {/* Recent deals */}
                    {partnerCtx && partnerCtx.deals.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1">{t("crm-recent-deals")}</p>
                        <div className="space-y-1 max-h-28 overflow-y-auto custom-scroll">
                          {partnerCtx.deals.slice(0, 5).map((d) => (
                            <div key={d.id} className="flex items-center justify-between text-xs px-2 py-1 rounded bg-muted/40">
                              <span className="truncate max-w-[55%]">{d.title}</span>
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono tabular text-muted-foreground">{fmtMoney(d.value, d.currency)}</span>
                                <Badge className={`${STAGE_BADGE[d.stage]} text-[9px] px-1 py-0`}>
                                  {t(STAGE_LABEL_KEYS[d.stage])}
                                </Badge>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Recent offers */}
                    {partnerCtx && partnerCtx.offers.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1">{t("crm-recent-offers")}</p>
                        <div className="space-y-1 max-h-28 overflow-y-auto custom-scroll">
                          {partnerCtx.offers.slice(0, 5).map((o) => (
                            <div key={o.id} className="flex items-center justify-between text-xs px-2 py-1 rounded bg-muted/40">
                              <span className="truncate max-w-[55%]">{o.number}</span>
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono tabular text-muted-foreground">{fmtMoney(o.total, o.currency)}</span>
                                <Badge variant="outline" className="text-[9px] px-1 py-0">{o.status}</Badge>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* ===== More Details (collapsible) ===== */}
          <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
            <CollapsibleTrigger className="flex items-center gap-2 w-full rounded-lg border border-border/60 bg-muted/30 px-3 py-2 hover:bg-muted/50 transition-colors">
              <FileText className="size-4 text-muted-foreground" />
              <span className="text-sm font-medium flex-1 text-left">{t("crm-more-details")}</span>
              <span className="text-xs text-muted-foreground mr-1">{t("crm-probability-close-date-notes")}</span>
              {detailsOpen ? <ChevronUp className="size-4 text-muted-foreground" /> : <ChevronDown className="size-4 text-muted-foreground" />}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-3">
                <div className="space-y-1.5">
                  <Label>{t("crm-probability")}: {form.probability ?? 0}%</Label>
                  <div className="pt-2.5">
                    <Slider
                      value={[form.probability ?? 0]}
                      min={0}
                      max={100}
                      step={5}
                      onValueChange={(v) => set("probability", v[0])}
                    />
                  </div>
                  {form.stage && STAGE_PROBABILITY[form.stage] !== undefined && (
                    <p className="text-xs text-muted-foreground">
                      {t("crm-suggested-for")} {t(STAGE_LABEL_KEYS[form.stage])}: {STAGE_PROBABILITY[form.stage]}%
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label>{t("crm-expected-close")}</Label>
                  <Input
                    type="date"
                    value={expectedCloseValue}
                    onChange={(e) => set("expected_close", e.target.value ? new Date(e.target.value).toISOString() : (null as any))}
                  />
                </div>
                <div className="md:col-span-2 space-y-1.5">
                  <Label>{t("crm-notes-label")}</Label>
                  <Textarea rows={3} value={form.description || ""} onChange={(e) => set("description", e.target.value)} placeholder={t("crm-additional-notes-placeholder")} />
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* ===== Costs & Pricing (collapsible) ===== */}
          <Collapsible open={lineItemsOpen} onOpenChange={setLineItemsOpen}>
            <CollapsibleTrigger className="flex items-center gap-2 w-full rounded-lg border border-border/60 bg-muted/30 px-3 py-2 hover:bg-muted/50 transition-colors">
              <BarChart3 className="size-4 text-muted-foreground" />
              <span className="text-sm font-medium flex-1 text-left">{t("crm-costs-pricing")}</span>
              <span className="text-xs text-muted-foreground mr-1">{t("crm-costs-pricing-desc")}</span>
              {lineItemsOpen ? <ChevronUp className="size-4 text-muted-foreground" /> : <ChevronDown className="size-4 text-muted-foreground" />}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="space-y-3 pt-3">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="space-y-1.5">
                    <Label>{t("crm-quantity-label")}</Label>
                    <Input type="number" min={0} step={1} value={form.quantity ?? 0} onChange={(e) => set("quantity", Number(e.target.value))} placeholder="0" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t("crm-unit-of-measure")}</Label>
                    <Input value={form.unit || ""} onChange={(e) => set("unit", e.target.value)} placeholder={t("crm-unit-of-measure")} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t("crm-exchange-rate")}</Label>
                    <Input
                      type="number"
                      min={0}
                      step="0.0001"
                      value={form.exchange_rate ?? 1}
                      onChange={(e) => set("exchange_rate", Number(e.target.value) as Deal["exchange_rate"])}
                      placeholder="1.00"
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("crm-exchange-rate-desc")}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>{t("crm-buy-cost-total")}</Label>
                    <Input type="number" min={0} step="0.01" value={form.buy_cost ?? 0} onChange={(e) => set("buy_cost", Number(e.target.value))} placeholder="0.00" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t("crm-purchase-currency")}</Label>
                    <Select value={form.purchase_currency || form.currency || "USD"} onValueChange={(v) => set("purchase_currency", v)}>
                      <SelectTrigger><SelectValue placeholder={t("crm-same-as-deal-currency")} /></SelectTrigger>
                      <SelectContent className="max-h-72">
                        {CURRENCIES_LIST.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t("crm-selling-price-total")}</Label>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={form.selling_price ?? 0}
                      onChange={(e) => set("selling_price", Number(e.target.value) as Deal["selling_price"])}
                      placeholder="0.00"
                    />
                    <p className="text-xs text-muted-foreground">{t("crm-selling-price-desc")}</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t("crm-selling-currency")}</Label>
                    <Select value={form.selling_currency || form.currency || "USD"} onValueChange={(v) => set("selling_currency", v)}>
                      <SelectTrigger><SelectValue placeholder={t("crm-same-as-deal-currency")} /></SelectTrigger>
                      <SelectContent className="max-h-72">
                        {CURRENCIES_LIST.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t("crm-bank-costs")}</Label>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={form.bank_costs ?? 0}
                      onChange={(e) => set("bank_costs", Number(e.target.value) as Deal["bank_costs"])}
                      placeholder="0.00"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t("crm-other-costs")}</Label>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={Array.isArray(form.costs) && form.costs[0]?.amount != null ? Number(form.costs[0].amount) : 0}
                      onChange={(e) => set("costs", [{ label: "Other", amount: Number(e.target.value) }] as Deal["costs"])}
                      placeholder="0.00"
                    />
                  </div>
                </div>

                {/* Profit / margin preview (full cost breakdown) */}
                <Card className="border-border/60 bg-muted/30 shadow-soft rounded-xl">
                  <CardContent className="p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <TrendingUp className="size-3.5 text-primary" />
                      <p className="text-xs font-medium">{t("crm-profit-margin-preview")}</p>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
                      <div>
                        <p className="text-xs text-muted-foreground">{t("crm-buy-cost-total")}</p>
                        <p className="font-mono tabular">{fmtMoney(formCalc.buyCost, form.purchase_currency || form.currency || "USD")}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">{t("crm-selling-price-total")}</p>
                        <p className="font-mono tabular">{fmtMoney(formCalc.sellingPrice, form.selling_currency || form.currency || "USD")}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">{t("crm-bank-costs")}</p>
                        <p className="font-mono tabular">{fmtMoney(formCalc.bankCosts, form.currency || "USD")}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">{t("crm-other-costs")}</p>
                        <p className="font-mono tabular">{fmtMoney(formCalc.otherCosts, form.currency || "USD")}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">{t("crm-commission")}</p>
                        <p className="font-mono tabular">{fmtMoney(formCalc.commission, commissionPreview?.currency || form.currency || "USD")}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">{t("crm-exchange-rate")}</p>
                        <p className="font-mono tabular">{formCalc.exchangeRate}</p>
                      </div>
                      <div className="border-t pt-1">
                        <p className="text-xs text-muted-foreground">{t("crm-total-cost")}</p>
                        <p className="font-mono tabular font-semibold">{fmtMoney(formCalc.totalCost, form.currency || "USD")}</p>
                      </div>
                      <div className="border-t pt-1">
                        <p className="text-xs text-muted-foreground">{t("crm-profit")}</p>
                        <p className={`font-mono tabular font-semibold ${formCalc.profit >= 0 ? "text-chart-1" : "text-destructive"}`}>
                          {fmtMoney(formCalc.profit, form.currency || "USD")}
                        </p>
                      </div>
                      <div className="border-t pt-1">
                        <p className="text-xs text-muted-foreground">{t("crm-margin-label")}</p>
                        <p className={`font-mono tabular font-semibold ${formCalc.marginPct >= 0 ? "text-chart-1" : "text-destructive"}`}>
                          {formCalc.marginPct.toFixed(1)}%
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* ===== Commission (collapsible) ===== */}
          <Collapsible open={commissionOpen} onOpenChange={setCommissionOpen}>
            <CollapsibleTrigger className="flex items-center gap-2 w-full rounded-lg border border-border/60 bg-muted/30 px-3 py-2 hover:bg-muted/50 transition-colors">
              <DollarSign className="size-4 text-muted-foreground" />
              <span className="text-sm font-medium flex-1 text-left">{t("crm-commission-section")}</span>
              <span className="text-xs text-muted-foreground mr-1">{t("crm-commission-section-desc")}</span>
              {commissionOpen ? <ChevronUp className="size-4 text-muted-foreground" /> : <ChevronDown className="size-4 text-muted-foreground" />}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="space-y-3 pt-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>{t("crm-commission-agent")}</Label>
                    <Select value={form.commission_agent_id || "none"} onValueChange={(v) => set("commission_agent_id", v === "none" ? null : (v as any))}>
                      <SelectTrigger><SelectValue placeholder={t("crm-no-commission-agent")} /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">{t("crm-no-commission-agent")}</SelectItem>
                        {commissionAgents.filter(a => a.active).map((a) => {
                          const p = partners.find(p => p.id === a.partner_id);
                          const agentRateLabel =
                            a.commission_type === "profit_percent" ? t("crm-rate-profit-percent").replace("${rate}", String(a.commission_rate))
                            : a.commission_type === "per_unit" ? t("crm-rate-per-unit").replace("${rate}", String(a.commission_per_unit))
                            : a.commission_type === "fixed" ? t("crm-rate-fixed").replace("${rate}", String(a.commission_rate))
                            : a.commission_type === "revenue_percent" ? t("crm-rate-revenue-percent").replace("${rate}", String(a.commission_rate))
                            : t("crm-rate-custom");
                          return (
                            <SelectItem key={a.id} value={a.id}>
                              {p?.name || a.id} ({agentRateLabel})
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Commission preview */}
                {commissionPreview && form.commission_agent_id && (
                  <Card className="border-primary/20 bg-primary/5 shadow-soft rounded-xl">
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <CheckCircle2 className="size-3.5 text-primary" />
                          <span className="text-xs font-medium text-primary">{t("crm-estimated-commission")}</span>
                        </div>
                        <span className="text-lg font-bold font-mono tabular text-primary">
                          {fmtMoney(commissionPreview.calculated_commission, commissionPreview.currency)}
                        </span>
                      </div>
                      <div className="mt-2 text-xs text-muted-foreground space-y-0.5">
                        <p>{t("crm-commission-type-label")} {commissionPreview.breakdown?.formula}</p>
                        <p>{t("crm-commission-deal-value-label")} {fmtMoney(form.value || 0, form.currency || "USD")}</p>
                        <p>{t("crm-commission-deal-profit-label")} {fmtMoney((form.value || 0) - (form.buy_cost || 0), form.currency || "USD")}</p>
                        {commissionPreview.commission_type === "per_unit" && (
                          <p>{t("crm-commission-quantity-label")} {form.quantity || 0} {form.unit || ""}</p>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Lost reason (conditional, always visible when stage is lost) */}
          {(form.stage === "lost" || deal?.stage === "lost") && (
            <div className="space-y-1.5">
              <Label>{t("crm-lost-reason")}</Label>
              <Textarea rows={2} value={form.lost_reason || ""} onChange={(e) => set("lost_reason", e.target.value)} />
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? t("crm-saving-ellipsis") : deal ? t("crm-save-changes") : t("crm-create-deal")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
