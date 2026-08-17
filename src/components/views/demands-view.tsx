"use client";

import { useState, useEffect, useCallback } from "react";
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
import {
  Collapsible, CollapsibleTrigger, CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  Plus, Search, Inbox, Pencil, Trash2, Eye, X, Calendar, FileInput, ArrowRightLeft,
  Sparkles, Loader2, Building2, MapPin, Hash, Mail, Phone, FileCheck, Import,
  ChevronDown, ChevronRight, Globe, CreditCard, Banknote, Package, Truck, Tag,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { fmtMoney, fmtDate, fmtDateTime } from "@/lib/utils/format";
import { Demand, DemandItem, DemandStatus, Partner, Product, PortalRfq } from "@/lib/supabase/types";
import { CURRENCIES, PAYMENT_TERMS_LOCAL } from "@/lib/data/reference";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { ProductPicker } from "@/components/common/product-picker";
import { PartnerPicker } from "@/components/common/partner-picker";
import { useDebounced } from "@/lib/hooks/use-debounced";
import { usePageSize } from "@/lib/hooks/use-page-size";
import { PageSizeSelector } from "@/components/common/page-size-selector";
import { useT } from "@/lib/i18n/store";

function StatusBadge({ status }: { status: DemandStatus }) {
  const t = useT();
  const label = status === "open" ? t("crm-open") : status === "quoted" ? t("crm-quoted") : t("crm-closed");
  if (status === "open")
    return <Badge className="border-transparent bg-primary text-primary-foreground">{label}</Badge>;
  if (status === "quoted")
    return <Badge className="border-transparent bg-[var(--chart-4)] text-black">{label}</Badge>;
  return <Badge className="border-transparent bg-muted text-muted-foreground">{label}</Badge>;
}

function PriorityBadge({ priority }: { priority: string }) {
  const t = useT();
  const label = priority === "high" ? t("crm-high") : priority === "medium" ? t("crm-medium") : t("crm-low");
  if (priority === "high")
    return <Badge className="border-transparent bg-destructive text-destructive-foreground">{label}</Badge>;
  if (priority === "medium")
    return <Badge className="border-transparent bg-amber-500 text-white">{label}</Badge>;
  return <Badge className="border-transparent bg-muted text-muted-foreground">{label}</Badge>;
}

const UNIT_OPTIONS = ["pcs", "kg", "l", "m", "m²", "m³", "hr", "can", "set", "t"];

// ─── Partner context type ───
interface PartnerContext {
  partner: Partner;
  deals: any[];
  offers: any[];
  invoices: any[];
  proformas: any[];
  productCatalog: any[];
  supplierOffers: any[];
  portalAccess: any;
  kyc: { status: string; submitted_at: string; reviewed_at: string; review_notes: string } | null;
  tradeCalculations: any[];
  inventoryMovements: any[];
}

// ─── Product context type ───
interface ProductContext {
  product: Product;
  catalogEntry: any;
  supplierOffers: any[];
  tradeCalculations: any[];
  inventoryStatus: { stock: number; reorder_level: number; low_stock: boolean; unit: string } | null;
  priceHistory: Array<{ date: string; source: string; source_number: string; unit_price: number; currency: string; quantity: number }>;
}

export function DemandsView() {
  const t = useT();
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search, 300);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [editing, setEditing] = useState<Demand | null>(null);
  const [showForm, setShowForm] = useState(false);
  useNewShortcut(() => { setEditing(null); setShowForm(true); });
  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [showRfqPicker, setShowRfqPicker] = useState(false);
  const [page, setPage] = useState(0);
  const { pageSize, setPageSize, options: pageSizeOptions } = usePageSize("demands", 20);

  // Reset to page 0 when pageSize changes to avoid landing past the last page.
  useEffect(() => { setPage(0); }, [pageSize]);

  const { data, isLoading } = useQuery({
    queryKey: ["demands", tenantKey, debouncedSearch, statusFilter, page, pageSize],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (statusFilter !== "all") params.set("status", statusFilter);
      params.set("limit", String(pageSize));
      params.set("offset", String(page * pageSize));
      const r = await fetch(api(`/api/demands?${params}`));
      if (!r.ok) throw new Error("Failed to load demands");
      return r.json() as Promise<{ items: Demand[]; total: number }>;
    },
  });

  const partners = useQuery({
    queryKey: ["partners", tenantKey, "list", "200"],
    queryFn: async () => {
      const r = await fetch(api(`/api/partners?limit=200`));
      if (!r.ok) throw new Error("Failed to load partners");
      return r.json() as Promise<{ items: Partner[]; total: number }>;
    },
  });

  const detail = useQuery({
    queryKey: ["demand", tenantKey, detailId],
    queryFn: async () => {
      const r = await fetch(api(`/api/demands/${detailId}`));
      if (!r.ok) throw new Error("Failed to load demand");
      return r.json() as Promise<Demand>;
    },
    enabled: !!detailId,
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(api(`/api/demands/${id}`), { method: "DELETE" });
      if (!r.ok) throw new Error("Delete failed");
    },
    onSuccess: () => {
      toast.success(t("crm-demand-deleted"));
      qc.invalidateQueries({ queryKey: ["demands", tenantKey] });
      qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
      setDeleteId(null);
    },
    onError: () => toast.error(t("crm-delete-failed")),
  });

  const items = data?.items || [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const partnerList = partners.data?.items || [];
  const partnerName = (id: string) => partnerList.find((p) => p.id === id)?.name || "—";

  return (
    <div>
      <PageHeader
        title={t("demands")}
        description={t("crm-total-count").replace("${n}", String(total))}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => setShowRfqPicker(true)}>
              <Import className="size-4 mr-1" /> {t("crm-from-portal-rfq")}
            </Button>
            <Button onClick={() => { setEditing(null); setShowForm(true); }}>
              <Plus className="size-4 mr-1" /> {t("crm-new-demand")}
            </Button>
          </div>
        }
      />

      <Card className="mb-4 border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-3 flex flex-col md:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder={t("search")}
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              className="pl-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(0); }}>
            <SelectTrigger className="w-full md:w-44"><SelectValue placeholder={t("status")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("crm-all-statuses")}</SelectItem>
              <SelectItem value="open">{t("crm-open")}</SelectItem>
              <SelectItem value="quoted">{t("crm-quoted")}</SelectItem>
              <SelectItem value="closed">{t("crm-closed")}</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={<Inbox className="size-6" />}
              title={t("crm-no-demands")}
              description={t("crm-no-demands-desc")}
              action={<Button onClick={() => { setEditing(null); setShowForm(true); }}><Plus className="size-4 mr-1" /> {t("crm-new-demand")}</Button>}
            />
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="sticky top-0 bg-card z-10">
                    <TableRow>
                      <TableHead>{t("crm-number")}</TableHead>
                      <TableHead className="hidden md:table-cell">{t("crm-subject")}</TableHead>
                      <TableHead className="hidden lg:table-cell">{t("crm-partner")}</TableHead>
                      <TableHead>{t("crm-priority")}</TableHead>
                      <TableHead>{t("status")}</TableHead>
                      <TableHead className="text-right">{t("crm-items")}</TableHead>
                      <TableHead className="hidden xl:table-cell">{t("crm-date")}</TableHead>
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
                        <TableCell className="font-mono text-xs tabular">{d.number}</TableCell>
                        <TableCell className="hidden md:table-cell">
                          <div className="font-medium truncate max-w-[220px]">{d.subject || "—"}</div>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">{partnerName(d.partner_id)}</TableCell>
                        <TableCell><PriorityBadge priority={(d as any).priority || "medium"} /></TableCell>
                        <TableCell><StatusBadge status={d.status} /></TableCell>
                        <TableCell className="text-right font-mono tabular">{(d.items || []).length}</TableCell>
                        <TableCell className="hidden xl:table-cell">{fmtDate(d.created_at)}</TableCell>
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

              {/* Pagination + Page size */}
              <div className="flex items-center justify-between px-4 py-3 border-t border-border/60 gap-3 flex-wrap">
                <p className="text-sm text-muted-foreground">
                  {total > 0
                    ? <>{t("crm-showing-range").replace("${from}", String(page * pageSize + 1)).replace("${to}", String(Math.min((page + 1) * pageSize, total))).replace("${total}", String(total))}</>
                    : <>{t("crm-no-results")}</>}
                </p>
                <div className="flex items-center gap-3">
                  <PageSizeSelector value={pageSize} onChange={setPageSize} options={pageSizeOptions} />
                  {totalPages > 1 && (
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>
                        {t("crm-previous")}
                      </Button>
                      <span className="text-sm px-2 tabular-nums">{page + 1} / {totalPages}</span>
                      <Button size="sm" variant="outline" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>
                        {t("crm-next")}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Form dialog */}
      <DemandFormDialog
        open={showForm}
        onOpenChange={setShowForm}
        demand={editing}
        partners={partnerList}
        onSaved={() => {
          setShowForm(false);
          qc.invalidateQueries({ queryKey: ["demands", tenantKey] });
          qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
        }}
      />

      {/* Portal RFQ picker dialog */}
      <PortalRfqPickerDialog
        open={showRfqPicker}
        onOpenChange={setShowRfqPicker}
        onCreated={() => {
          setShowRfqPicker(false);
          qc.invalidateQueries({ queryKey: ["demands", tenantKey] });
          qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
        }}
      />

      {/* Detail sheet */}
      <Sheet open={!!detailId} onOpenChange={(o) => !o && setDetailId(null)}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto custom-scroll">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Inbox className="size-5" />
              <span className="font-mono text-base">{detail.data?.number || t("crm-demand")}</span>
            </SheetTitle>
            <SheetDescription>{detail.data?.subject || t("crm-demand-details")}</SheetDescription>
          </SheetHeader>
          {detail.isLoading ? (
            <div className="p-4 space-y-3">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : detail.data ? (
            <DemandDetail
              demand={detail.data}
              partnerName={partnerName(detail.data.partner_id)}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("crm-delete-demand-title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("crm-delete-demand-desc")}
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

// ---- Detail panel ----
function DemandDetail({
  demand, partnerName,
}: {
  demand: Demand;
  partnerName: string;
}) {
  const t = useT();
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  // Check if any trade fields have data
  const hasTradeData = !!(demand.product_id || demand.product_name || demand.target_price != null || demand.is_new_product || demand.source || demand.auto_hints || demand.buyer_bank || demand.destination || demand.needed_by || demand.payment_terms);

  return (
    <div className="px-4 pb-6">
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <StatusBadge status={demand.status} />
        <span className="text-sm text-muted-foreground">{partnerName}</span>
      </div>

      {/* Key dates */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Calendar className="size-3" /> {t("crm-requested-delivery")}</p>
          <p className="text-sm font-medium">{fmtDate(demand.requested_delivery)}</p>
        </div>
        <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><FileInput className="size-3" /> {t("crm-created-label")}</p>
          <p className="text-sm font-medium">{fmtDateTime(demand.created_at)}</p>
        </div>
      </div>

      {/* Trade / Import Details */}
      {hasTradeData && (
        <div className="mb-4">
          <h4 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
            <Truck className="size-4" /> {t("crm-trade-details")}
          </h4>
          <div className="grid grid-cols-2 gap-2">
            {demand.product_name && (
              <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
                <p className="text-xs text-muted-foreground flex items-center gap-1"><Package className="size-3" /> {t("crm-product")}</p>
                <p className="text-sm font-medium">{demand.product_name}</p>
              </div>
            )}
            {demand.target_price != null && (
              <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
                <p className="text-xs text-muted-foreground flex items-center gap-1"><Tag className="size-3" /> {t("crm-target-price-label")}</p>
                <p className="text-sm font-medium">{fmtMoney(demand.target_price, demand.currency)}</p>
              </div>
            )}
            {demand.is_new_product && (
              <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
                <p className="text-xs text-muted-foreground flex items-center gap-1"><Sparkles className="size-3" /> {t("crm-new-product-trade")}</p>
                <p className="text-sm font-medium">{t("crm-yes")}</p>
              </div>
            )}
            {demand.source && (
              <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
                <p className="text-xs text-muted-foreground flex items-center gap-1"><Import className="size-3" /> {t("crm-source")}</p>
                <p className="text-sm font-medium capitalize">{demand.source}</p>
              </div>
            )}
            {demand.payment_terms && (
              <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
                <p className="text-xs text-muted-foreground flex items-center gap-1"><CreditCard className="size-3" /> {t("crm-payment-terms")}</p>
                <p className="text-sm font-medium">{demand.payment_terms}</p>
              </div>
            )}
            {demand.destination && (
              <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
                <p className="text-xs text-muted-foreground flex items-center gap-1"><MapPin className="size-3" /> {t("crm-destination")}</p>
                <p className="text-sm font-medium">{demand.destination}</p>
              </div>
            )}
            {demand.needed_by && (
              <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
                <p className="text-xs text-muted-foreground flex items-center gap-1"><Calendar className="size-3" /> {t("crm-needed-by")}</p>
                <p className="text-sm font-medium">{fmtDate(demand.needed_by)}</p>
              </div>
            )}
            {demand.buyer_bank && (
              <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
                <p className="text-xs text-muted-foreground flex items-center gap-1"><Banknote className="size-3" /> {t("crm-buyer-bank")}</p>
                <p className="text-sm font-medium whitespace-pre-wrap">{demand.buyer_bank}</p>
              </div>
            )}
            {demand.auto_hints && (
              <div className="col-span-2 p-3 rounded-lg bg-muted/40 border border-border/60">
                <p className="text-xs text-muted-foreground flex items-center gap-1"><Sparkles className="size-3" /> {t("crm-auto-hints")}</p>
                <p className="text-sm font-medium whitespace-pre-wrap">{demand.auto_hints}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Items */}
      <div className="rounded-lg border border-border/60 overflow-hidden mb-4">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>{t("crm-product")}</TableHead>
              <TableHead className="text-right">{t("crm-quantity-label")}</TableHead>
              <TableHead className="hidden sm:table-cell">{t("crm-unit")}</TableHead>
              <TableHead className="text-right hidden sm:table-cell">{t("crm-target-price")}</TableHead>
              <TableHead className="hidden md:table-cell">{t("crm-notes-label")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(demand.items || []).length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-6">
                  {t("crm-no-items")}
                </TableCell>
              </TableRow>
            ) : (demand.items || []).map((it, i) => (
              <TableRow key={i}>
                <TableCell className="font-medium">{it.product_name || "—"}</TableCell>
                <TableCell className="text-right font-mono tabular">{it.quantity}</TableCell>
                <TableCell className="hidden sm:table-cell">{it.unit}</TableCell>
                <TableCell className="text-right font-mono tabular hidden sm:table-cell">
                  {it.target_price != null ? fmtMoney(it.target_price, demand.currency) : "—"}
                </TableCell>
                <TableCell className="hidden md:table-cell text-xs text-muted-foreground max-w-[220px] truncate">
                  {it.notes || "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {demand.description && (
        <div className="mb-4">
          <p className="text-xs text-muted-foreground mb-1">{t("description")}</p>
          <p className="text-sm whitespace-pre-wrap p-3 rounded-md bg-muted/40">{demand.description}</p>
        </div>
      )}

      <div className="pt-3 border-t">
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            try {
              // Build an offer directly from the demand — same partner,
              // items, subject, and currency. Skips the deal-based
              // automation which doesn't understand demands.
              // Enrich each line with trade metadata (HS code, brand, spec)
              // from the linked product, same as the manual product picker.
              const productLookups = await Promise.all(
                (demand.items || []).map((it: any) =>
                  it.product_id
                    ? fetch(api(`/api/products/${it.product_id}`)).then((r) => (r.ok ? r.json() : null)).catch(() => null)
                    : Promise.resolve(null)
                )
              );
              const items = (demand.items || []).map((it: any, i: number) => {
                const p = productLookups[i];
                return {
                  product_id: it.product_id || "",
                  product_name: it.product_name || demand.product_name || `Line ${i + 1}`,
                  sku: p?.sku || it.sku || "",
                  unit: it.unit || p?.unit || "pcs",
                  quantity: Number(it.quantity) || 1,
                  unit_price: Number(it.target_price ?? demand.target_price ?? 0) || 0,
                  discount: 0,
                  tax_rate: 20,
                  total: (Number(it.quantity) || 1) * (Number(it.target_price ?? demand.target_price ?? 0) || 0),
                  hs_code: p?.hs_code ?? null,
                  description: p?.description ?? null,
                  detailed_spec: p?.detailed_spec ?? null,
                  brand: p?.brand ?? null,
                };
              });
              const subtotal = items.reduce((s, x) => s + x.total, 0);
              const res = await fetch(api(`/api/offers`), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  partner_id: demand.partner_id,
                  subject: demand.subject || `Offer for demand ${demand.number}`,
                  currency: demand.currency || "USD",
                  status: "draft",
                  items,
                  subtotal,
                  discount_total: 0,
                  tax_total: subtotal * 0.2,
                  total: subtotal * 1.2,
                  notes: demand.description || null,
                }),
              });
              if (!res.ok) throw new Error("Failed to create offer");
              const data = await res.json();
              toast.success(t("crm-offer-created-prefix").replace("${number}", data.number || data.id));
            } catch {
              toast.error(t("crm-failed-convert-demand-offer"));
            }
          }}
        >
          <ArrowRightLeft className="size-4 mr-1" /> {t("crm-convert-to-offer")}
        </Button>
      </div>
    </div>
  );
}

// ---- Portal RFQ Picker Dialog ----
function PortalRfqPickerDialog({
  open, onOpenChange, onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: () => void;
}) {
  const t = useT();
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const [creating, setCreating] = useState<string | null>(null);

  const rfqs = useQuery({
    queryKey: ["portal-rfqs", tenantKey, "pending"],
    queryFn: async () => {
      const r = await fetch(api(`/api/portal-rfqs?status=pending`));
      if (!r.ok) throw new Error("Failed to load portal RFQs");
      return r.json() as Promise<{ items: PortalRfq[]; total: number }>;
    },
    enabled: open,
  });

  const partners = useQuery({
    queryKey: ["partners", tenantKey, "list", "200"],
    queryFn: async () => {
      const r = await fetch(api(`/api/partners?limit=200`));
      if (!r.ok) throw new Error("Failed to load partners");
      return r.json() as Promise<{ items: Partner[]; total: number }>;
    },
    enabled: open,
  });

  const partnerList = partners.data?.items || [];
  const partnerName = (id: string) => partnerList.find((p) => p.id === id)?.name || "—";

  async function createFromRfq(rfq: PortalRfq) {
    setCreating(rfq.id);
    try {
      const r = await fetch(api("/api/automation/create-demand-from-portal-rfq"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rfq_id: rfq.id }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to create demand");
      }
      toast.success(t("crm-demand-created-from-rfq").replace("${number}", rfq.number));
      onCreated();
    } catch (e: any) {
      toast.error(e.message || t("crm-failed-create-demand-from-rfq"));
    } finally {
      setCreating(null);
    }
  }

  const rfqItems = rfqs.data?.items || [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Import className="size-5" />
            {t("crm-create-demand-from-portal-rfq")}
          </DialogTitle>
          <DialogDescription>
            {t("crm-create-demand-from-portal-rfq-desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] overflow-y-auto pr-1">
        {rfqs.isLoading ? (
          <div className="p-4 space-y-2">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}
          </div>
        ) : rfqItems.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <FileCheck className="size-8 mx-auto mb-2 opacity-50" />
            <p>{t("crm-no-pending-portal-rfqs")}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {rfqItems.map((rfq) => (
              <Card key={rfq.id} className="border-border/60 hover:border-foreground/20 transition-colors">
                <CardContent className="p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-mono text-xs">{rfq.number}</span>
                        <Badge variant="outline" className="text-xs">{rfq.status}</Badge>
                      </div>
                      <p className="font-medium text-sm">{rfq.product_name}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {rfq.quantity} {rfq.unit} · {partnerName(rfq.partner_id)}
                        {rfq.target_price != null && ` · ${t("crm-target-prefix")}${fmtMoney(rfq.target_price, rfq.currency)}`}
                      </p>
                      {rfq.notes && (
                        <p className="text-xs text-muted-foreground mt-1 truncate max-w-[400px]">{rfq.notes}</p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      onClick={() => createFromRfq(rfq)}
                      disabled={creating === rfq.id}
                    >
                      {creating === rfq.id ? (
                        <><Loader2 className="size-4 mr-1 animate-spin" /> {t("crm-creating-ellipsis")}</>
                      ) : (
                        <><Plus className="size-4 mr-1" /> {t("crm-create-btn")}</>
                      )}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- Form dialog ----
function DemandFormDialog({
  open, onOpenChange, demand, partners, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  demand: Demand | null;
  partners: Partner[];
  onSaved: () => void;
}) {
  const t = useT();
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const isEditing = !!demand;

  const [moreDetailsOpen, setMoreDetailsOpen] = useState(false);
  const [form, setForm] = useState<Partial<Demand> & { items: DemandItem[] }>({ items: [] });
  const [saving, setSaving] = useState(false);
  const [partnerContext, setPartnerContext] = useState<PartnerContext | null>(null);
  const [loadingPartner, setLoadingPartner] = useState(false);
  const [autoNumber, setAutoNumber] = useState<string | null>(null);

  // NOTE: the product list is no longer fetched here — the shared
  // ProductPicker component fetches its own copy (limit=1000) and calls
  // `onSelect(product)` with the full Product object, which is forwarded
  // to `selectProductForItem` below.

  // Auto-generate demand number when creating new
  useEffect(() => {
    if (open && !demand) {
      const year = new Date().getFullYear();
      const seq = Math.floor(Math.random() * 900) + 100;
      const num = `RFQ-${year}-${seq}`;
      setAutoNumber(num);
    } else {
      setAutoNumber(null);
    }
  }, [open, demand]);

  // ─── Fix: useMemo → useEffect for form initialization ───
  useEffect(() => {
    if (open) {
      if (demand) {
        setForm({
          ...demand,
          items: (demand.items || []).map((i) => ({ ...i })),
        });
        setMoreDetailsOpen(true);
      } else {
        setForm({
          currency: "USD",
          status: "open",
          items: [],
          description: "",
          requested_delivery: null,
        });
        setMoreDetailsOpen(false);
      }
      setPartnerContext(null);
    }
  }, [open, demand]);

  function set<K extends keyof Demand>(k: K, v: Demand[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function setItem(idx: number, patch: Partial<DemandItem>) {
    setForm((f) => {
      const items = [...(f.items || [])];
      items[idx] = { ...items[idx], ...patch };
      return { ...f, items };
    });
  }

  function addItem() {
    setForm((f) => ({
      ...f,
      items: [...(f.items || []), {
        product_id: null, product_name: "", quantity: 1, unit: "pcs", target_price: null, notes: "",
      }],
    }));
  }

  function removeItem(idx: number) {
    setForm((f) => ({
      ...f,
      items: (f.items || []).filter((_, i) => i !== idx),
    }));
  }

  // ─── Partner auto-fill ───
  const fetchPartnerContext = useCallback(async (partnerId: string) => {
    if (!partnerId) {
      setPartnerContext(null);
      return;
    }
    setLoadingPartner(true);
    try {
      const r = await fetch(api(`/api/automation/partner-context?partner_id=${partnerId}`));
      if (!r.ok) throw new Error("Failed to load partner context");
      const ctx: PartnerContext = await r.json();
      setPartnerContext(ctx);

      const p = ctx.partner;
      setForm((f) => ({
        ...f,
        partner_id: partnerId,
        currency: p.preferred_currency || f.currency || "USD",
      }));

      toast.success(t("crm-partner-data-loaded").replace("${name}", p.name), { description: t("crm-currency-prefs-auto-filled") });
    } catch {
      toast.error(t("crm-failed-load-partner-context"));
      setPartnerContext(null);
    } finally {
      setLoadingPartner(false);
    }
  }, []);

  // ─── Product auto-fill ───
  const selectProductForItem = useCallback(async (idx: number, p: Product) => {
    setItem(idx, {
      product_id: p.id,
      product_name: p.name,
      unit: p.unit,
      target_price: p.price || null,
    });

    try {
      const r = await fetch(api(`/api/automation/product-context?product_id=${p.id}`));
      if (!r.ok) throw new Error("Failed to load product context");
      const ctx: ProductContext = await r.json();

      if (ctx.product?.price) {
        setItem(idx, { target_price: ctx.product.price });
      }

      toast.success(t("crm-product-data-loaded").replace("${name}", p.name), { description: t("crm-price-unit-currency-auto-filled") });
    } catch {
      // Basic fill already done, no need to show error
    }
  }, []);

  const selectedPartner = form.partner_id ? partners.find((p) => p.id === form.partner_id) : undefined;

  async function save() {
    if (!form.partner_id) { toast.error(t("crm-select-a-partner-toast")); return; }
    setSaving(true);
    try {
      const method = demand ? "PUT" : "POST";
      const url = demand ? api(`/api/demands/${demand.id}`) : api("/api/demands");
      const body = {
        ...form,
        number: form.number || autoNumber || undefined,
        items: form.items || [],
        status: form.status || "open",
      };
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Request failed");
      }
      if (demand) {
        toast.success(t("crm-demand-updated"), { description: form.subject });
      } else {
        toast.success(t("crm-demand-created"), { description: form.subject || t("crm-demand-new-lower") });
      }
      onSaved();
    } catch (e: any) {
      toast.error(e.message || t("crm-saving-failed-toast"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-amber-500" />
            {demand ? t("crm-edit-demand") : t("crm-new-demand")}
          </DialogTitle>
          <DialogDescription>
            {demand
              ? t("crm-update-demand-details")
              : t("crm-create-demand-desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] overflow-y-auto pr-1">
        <div className="space-y-4 py-2">
          {/* ─── Essential Section (always visible) ─── */}
          <div className="space-y-3">
            {/* Auto-number badge */}
            {!demand && autoNumber && (
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="font-mono text-xs">
                  <Sparkles className="size-3 text-amber-500 mr-1" />
                  {autoNumber}
                </Badge>
                <span className="text-xs text-muted-foreground">{t("crm-auto-generated-number")}</span>
              </div>
            )}

            {/* Partner + Product row */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {/* Partner select */}
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  {t("crm-partner-required-label")}
                  {loadingPartner && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
                  {partnerContext && !loadingPartner && (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 gap-0.5">
                      <Sparkles className="size-2.5 text-amber-500" /> {t("crm-auto-filled")}
                    </Badge>
                  )}
                </Label>
                <PartnerPicker
                  value={form.partner_id || ""}
                  fallbackName={selectedPartner?.name}
                  placeholder={t("crm-select-a-partner")}
                  onSelect={(p) => {
                    const id = p?.id || "";
                    set("partner_id", id);
                    if (id) fetchPartnerContext(id);
                  }}
                />
              </div>

              {/* Product (top-level) */}
              <div className="space-y-1.5">
                <Label>{t("crm-product")}</Label>
                <ProductPicker
                  value={form.product_id || ""}
                  fallbackName={form.product_name || ""}
                  placeholder={t("crm-select-product-item")}
                  onSelect={(p) => {
                    if (p) {
                      set("product_id", p.id);
                      set("product_name", p.name);
                      if (p.price) set("target_price", p.price);
                    } else {
                      set("product_id", null);
                      set("product_name", null);
                    }
                  }}
                />
              </div>
            </div>

            {/* Partner context panel */}
            {selectedPartner && partnerContext && (
              <div className="rounded-lg border border-amber-500/20 bg-amber-50/50 dark:bg-amber-950/10 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <Building2 className="size-4 text-amber-600" />
                  <span className="text-sm font-medium">{selectedPartner.name}</span>
                  <Badge variant="outline" className="text-xs">{selectedPartner.type}</Badge>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-xs">
                  {selectedPartner.address_line && (
                    <div className="flex items-start gap-1.5">
                      <MapPin className="size-3 text-muted-foreground mt-0.5 shrink-0" />
                      <span className="text-muted-foreground">{[selectedPartner.address_line, selectedPartner.city, selectedPartner.country].filter(Boolean).join(", ")}</span>
                    </div>
                  )}
                  {selectedPartner.vat_number && (
                    <div className="flex items-center gap-1.5">
                      <Hash className="size-3 text-muted-foreground shrink-0" />
                      <span className="text-muted-foreground">{t("crm-vat-prefix").replace("${value}", selectedPartner.vat_number)}</span>
                    </div>
                  )}
                  {selectedPartner.email && (
                    <div className="flex items-center gap-1.5">
                      <Mail className="size-3 text-muted-foreground shrink-0" />
                      <span className="text-muted-foreground">{selectedPartner.email}</span>
                    </div>
                  )}
                  {selectedPartner.preferred_currency && (
                    <div className="flex items-center gap-1.5">
                      <Globe className="size-3 text-muted-foreground shrink-0" />
                      <span className="text-muted-foreground">{t("crm-currency-prefix").replace("${value}", selectedPartner.preferred_currency)}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Quantity + Target Price row */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t("crm-quantity-label")}</Label>
                <Input
                  type="number"
                  value={form.items?.[0]?.quantity ?? 1}
                  onChange={(e) => {
                    const qty = Number(e.target.value);
                    if ((form.items || []).length === 0) {
                      setForm((f) => ({ ...f, items: [{ product_id: null, product_name: "", quantity: qty, unit: "pcs", target_price: null, notes: "" }] }));
                    } else {
                      setItem(0, { quantity: qty });
                    }
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("crm-target-price-label")}</Label>
                <Input
                  type="number"
                  value={form.target_price ?? form.items?.[0]?.target_price ?? ""}
                  onChange={(e) => {
                    const price = e.target.value === "" ? null : Number(e.target.value);
                    set("target_price", price);
                    if ((form.items || []).length > 0) {
                      setItem(0, { target_price: price });
                    }
                  }}
                  placeholder="0.00"
                />
              </div>
            </div>
          </div>

          {/* ─── More Details Section (collapsible) ─── */}
          <Collapsible open={moreDetailsOpen} onOpenChange={setMoreDetailsOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-2 w-full rounded-lg border border-border/60 bg-muted/30 px-4 py-2.5 text-left hover:bg-muted/50 transition-colors"
              >
                {moreDetailsOpen ? (
                  <ChevronDown className="size-4 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronRight className="size-4 text-muted-foreground shrink-0" />
                )}
                <span className="text-sm font-medium">{t("crm-more-details")}</span>
                <span className="text-xs text-muted-foreground">{t("crm-subject-currency-etc")}</span>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="pt-3 space-y-4">
                {/* Subject + Currency */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>{t("crm-subject")}</Label>
                    <Input
                      value={form.subject || ""}
                      onChange={(e) => set("subject", e.target.value)}
                      placeholder={t("crm-equipment-inquiry-ph")}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t("currency")}</Label>
                    <Select value={form.currency || "USD"} onValueChange={(v) => set("currency", v)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {CURRENCIES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Status + Payment Terms */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>{t("status")}</Label>
                    <Select value={form.status || "open"} onValueChange={(v) => set("status", v as DemandStatus)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="open">{t("crm-open")}</SelectItem>
                        <SelectItem value="quoted">{t("crm-quoted")}</SelectItem>
                        <SelectItem value="closed">{t("crm-closed")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t("crm-priority")}</Label>
                    <Select value={(form as any).priority || "medium"} onValueChange={(v) => set("priority" as any, v)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="low">{t("crm-low")}</SelectItem>
                        <SelectItem value="medium">{t("crm-medium")}</SelectItem>
                        <SelectItem value="high">{t("crm-high")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t("crm-payment-terms")}</Label>
                    <Select value={form.payment_terms || "__none__"} onValueChange={(v) => set("payment_terms", v === "__none__" ? null : v)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">{t("crm-none-option")}</SelectItem>
                        {PAYMENT_TERMS_LOCAL.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Trade fields */}
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                  <div className="space-y-1.5">
                    <Label>{t("crm-destination")}</Label>
                    <Input value={form.destination || ""} onChange={(e) => set("destination", e.target.value)} placeholder={t("crm-delivery-city-country")} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t("crm-requested-delivery-label")}</Label>
                    <Input
                      type="date"
                      value={form.requested_delivery ? form.requested_delivery.slice(0, 10) : ""}
                      onChange={(e) => set("requested_delivery", e.target.value ? new Date(e.target.value).toISOString() : null)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t("crm-needed-by")}</Label>
                    <Input
                      type="date"
                      value={form.needed_by ? form.needed_by.slice(0, 10) : ""}
                      onChange={(e) => set("needed_by", e.target.value ? new Date(e.target.value).toISOString() : null)}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>{t("crm-buyer-bank")}</Label>
                    <Input value={form.buyer_bank || ""} onChange={(e) => set("buyer_bank", e.target.value)} placeholder={t("crm-bank-name-iban")} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t("crm-source")}</Label>
                    <Select value={form.source || "__none__"} onValueChange={(v) => set("source", v === "__none__" ? null : v)}>
                      <SelectTrigger><SelectValue placeholder={t("crm-source")} /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">{t("crm-none-option")}</SelectItem>
                        <SelectItem value="portal">{t("crm-source-portal-rfq")}</SelectItem>
                        <SelectItem value="manual">{t("crm-source-manual")}</SelectItem>
                        <SelectItem value="import">{t("crm-source-import")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Description */}
                <div className="space-y-1.5">
                  <Label>{t("crm-notes-description")}</Label>
                  <Textarea
                    rows={2}
                    value={form.description || ""}
                    onChange={(e) => set("description", e.target.value)}
                    placeholder={t("crm-additional-notes-placeholder")}
                  />
                </div>

                {/* Items list (for multi-item demands) */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">{t("crm-line-items")}</Label>
                    <Button type="button" size="sm" variant="outline" onClick={addItem}>
                      <Plus className="size-4 mr-1" /> {t("crm-add-item")}
                    </Button>
                  </div>
                  {(form.items || []).length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4 border rounded-md border-dashed">
                      {t("crm-no-items-yet")}
                    </p>
                  ) : (
                    <div className="space-y-2 max-h-72 overflow-y-auto custom-scroll pr-1">
                      {(form.items || []).map((it, idx) => (
                        <div key={idx} className="rounded-md border border-border/60 p-2 grid grid-cols-12 gap-1.5 items-end">
                          <div className="col-span-12 sm:col-span-4 space-y-1">
                            <Label className="text-xs">{t("crm-product")}</Label>
                            <ProductPicker
                              value={it.product_id || ""}
                              fallbackName={it.product_name || ""}
                              placeholder={t("crm-select-product-item")}
                              className="h-8"
                              onSelect={(p) => {
                                if (p) {
                                  selectProductForItem(idx, p);
                                } else {
                                  setItem(idx, { product_id: null });
                                }
                              }}
                              onAddCustom={() => {
                                // "Add custom product" — clear the product_id
                                // but keep the current product_name so the
                                // user can keep typing a manual entry.
                                setItem(idx, { product_id: null });
                              }}
                            />
                            <Input
                              className="h-8 text-xs"
                              value={it.product_name || ""}
                              onChange={(e) => setItem(idx, { product_name: e.target.value })}
                              placeholder={t("crm-product-name-ph")}
                            />
                          </div>
                          <div className="col-span-3 sm:col-span-2 space-y-1">
                            <Label className="text-xs">{t("crm-qty")}</Label>
                            <Input
                              type="number"
                              className="h-8 text-xs"
                              value={it.quantity}
                              onChange={(e) => setItem(idx, { quantity: Number(e.target.value) })}
                            />
                          </div>
                          <div className="col-span-3 sm:col-span-2 space-y-1">
                            <Label className="text-xs">{t("crm-unit")}</Label>
                            <Select value={it.unit} onValueChange={(v) => setItem(idx, { unit: v })}>
                              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {UNIT_OPTIONS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="col-span-3 sm:col-span-2 space-y-1">
                            <Label className="text-xs">{t("crm-target-price")}</Label>
                            <Input
                              type="number"
                              className="h-8 text-xs"
                              value={it.target_price ?? ""}
                              onChange={(e) => setItem(idx, { target_price: e.target.value === "" ? null : Number(e.target.value) })}
                            />
                          </div>
                          <div className="col-span-1 flex justify-end">
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="size-8 text-destructive"
                              onClick={() => removeItem(idx)}
                              title={t("remove")}
                            >
                              <X className="size-4" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="size-4 mr-1 animate-spin" />
                {t("crm-saving-ellipsis")}
              </>
            ) : demand ? (
              t("crm-save-changes")
            ) : (
              <>
                <Plus className="size-4 mr-1" />
                {t("crm-create-demand")}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
