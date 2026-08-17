"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card, CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
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
import { Separator } from "@/components/ui/separator";
import {
  Plus, Search, Pencil, Trash2, Eye, Handshake, ArrowLeftRight,
  DollarSign, Package, Ship, ShieldCheck, FileText, MapPin, Clock, CreditCard,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { ProductPicker } from "@/components/common/product-picker";
import { PartnerPicker } from "@/components/common/partner-picker";
import { fmtMoney, fmtDate } from "@/lib/utils/format";
import {
  SupplierOffer, SupplierOfferStatus, ProductCatalogEntry, Partner,
} from "@/lib/supabase/types";
import {
  INCOTERMS, CURRENCIES, PAYMENT_TERMS,
  getCurrency, getIncoterm,
} from "@/lib/data/reference";
import { getCountry } from "@/lib/data/geo/countries";
import { CountrySelect } from "@/components/common/country-select";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useDebounced } from "@/lib/hooks/use-debounced";
import { useI18nStore } from "@/lib/i18n/store";
import { t, type Locale } from "@/lib/i18n/dictionaries";

function flagEmoji(countryCode: string | null | undefined): string {
  if (!countryCode || countryCode.length !== 2) return "";
  const cc = countryCode.toUpperCase();
  const codePoints = [...cc].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65));
  return String.fromCodePoint(...codePoints);
}

function statusLabels(locale: Locale): Record<SupplierOfferStatus, string> {
  return {
    active: t(locale, "active"),
    expired: t(locale, "crm-expired"),
    on_hold: t(locale, "crm-on-hold"),
    consumed: t(locale, "crm-consumed"),
  };
}

const STATUS_BADGE: Record<SupplierOfferStatus, string> = {
  active: "bg-chart-1/15 text-chart-1 border-chart-1/30",
  expired: "bg-muted text-muted-foreground border-border",
  on_hold: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  consumed: "bg-secondary text-secondary-foreground border-border",
};

function statusValues(locale: Locale): { code: string; label: string }[] {
  return [
    { code: "active", label: t(locale, "active") },
    { code: "expired", label: t(locale, "crm-expired") },
    { code: "on_hold", label: t(locale, "crm-on-hold") },
    { code: "consumed", label: t(locale, "crm-consumed") },
  ];
}

function incotermLabel(code: string): string {
  const i = getIncoterm(code);
  return i ? `${i.code} — ${i.name}` : code;
}

export function SupplierOffersView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const locale = useI18nStore((s) => s.locale);
  const STATUS_LABELS = statusLabels(locale);
  const STATUS_VALUES = statusValues(locale);

  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search, 300);
  const [productFilter, setProductFilter] = useState<string>("all");
  const [supplierFilter, setSupplierFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [editing, setEditing] = useState<SupplierOffer | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["supplier-offers", tenantKey, debouncedSearch, productFilter, supplierFilter, statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (productFilter !== "all") params.set("product_id", productFilter);
      if (supplierFilter !== "all") params.set("supplier_id", supplierFilter);
      if (statusFilter !== "all") params.set("status", statusFilter);
      const r = await fetch(api(`/api/supplier-offers?${params}`));
      if (!r.ok) throw new Error("Failed to load supplier offers");
      return r.json() as Promise<{ items: SupplierOffer[]; total: number }>;
    },
  });

  // Products & partners for dropdowns + lookups
  // FIX: use /api/products instead of /api/product-catalog (which is empty —
  // products were merged into the products table via show_in_catalog flag).
  const catalog = useQuery({
    queryKey: ["products", tenantKey, "supplier-offers-all"],
    queryFn: async () => {
      const r = await fetch(api("/api/products?limit=1000"));
      if (!r.ok) throw new Error("Failed to load products");
      return r.json() as Promise<{ items: any[] }>;
    },
  });
  const partners = useQuery({
    queryKey: ["partners", tenantKey, "all"],
    queryFn: async () => {
      const r = await fetch(api("/api/partners?limit=500"));
      if (!r.ok) throw new Error("Failed to load partners");
      return r.json() as Promise<{ items: Partner[] }>;
    },
  });

  const catalogMap = new Map((catalog.data?.items || []).map((p) => [p.id, p]));
  const partnerMap = new Map((partners.data?.items || []).map((p) => [p.id, p]));
  // Suppliers = partners whose type is supplier or both
  const supplierPartners = (partners.data?.items || []).filter((p) => p.type === "supplier" || p.type === "both");

  const detail = useQuery({
    queryKey: ["supplier-offer", tenantKey, detailId],
    queryFn: async () => {
      const r = await fetch(api(`/api/supplier-offers/${detailId}`));
      if (!r.ok) throw new Error("Failed to load offer");
      return r.json() as Promise<SupplierOffer>;
    },
    enabled: !!detailId,
  });

  // Other offers for the same product (for comparison)
  const comparison = useQuery({
    queryKey: ["supplier-offers", tenantKey, "compare", detail.data?.product_id],
    queryFn: async () => {
      const r = await fetch(api(`/api/supplier-offers?product_id=${detail.data?.product_id}`));
      if (!r.ok) throw new Error("Failed to load comparison offers");
      return r.json() as Promise<{ items: SupplierOffer[] }>;
    },
    enabled: !!detail.data?.product_id,
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(api(`/api/supplier-offers/${id}`), { method: "DELETE" });
      if (!r.ok) throw new Error("Delete failed");
    },
    onSuccess: () => {
      toast.success(t(locale, "crm-offer-deleted"));
      qc.invalidateQueries({ queryKey: ["supplier-offers", tenantKey] });
      setDeleteId(null);
    },
    onError: () => toast.error(t(locale, "crm-delete-failed")),
  });

  const items = data?.items || [];

  return (
    <div>
      <PageHeader
        title={t(locale, "supplier-offers")}
        description={`${data?.total ?? 0} ${t(locale, "offers").toLowerCase()}`}
        actions={
          <Button onClick={() => { setEditing(null); setShowForm(true); }}>
            <Plus className="size-4 mr-1" /> {t(locale, "crm-new-offer")}
          </Button>
        }
      />

      <Card className="mb-4 border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-3 flex flex-col md:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder={t(locale, "crm-search-offer-packaging")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          {/* Product filter — use a simple Input for search instead of a 500+
              item dropdown that's impossible to navigate. */}
          <Input
            placeholder={t(locale, "crm-product")}
            value={productFilter === "all" ? "" : (catalogMap.get(productFilter)?.name || productFilter)}
            onChange={(e) => {
              const val = e.target.value.toLowerCase();
              if (!val) { setProductFilter("all"); return; }
              const match = (catalog.data?.items || []).find((p) =>
                p.name?.toLowerCase().includes(val) || p.sku?.toLowerCase().includes(val)
              );
              setProductFilter(match ? match.id : "all");
            }}
            className="w-full md:w-56"
          />
          <PartnerPicker
            value={supplierFilter === "all" ? "" : supplierFilter}
            filterType="supplier"
            allowClear
            placeholder={t(locale, "crm-supplier")}
            onSelect={(p) => setSupplierFilter(p?.id || "all")}
            className="md:w-48"
          />
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full md:w-40"><SelectValue placeholder={t(locale, "status")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t(locale, "crm-all-statuses")}</SelectItem>
              {STATUS_VALUES.map((s) => (
                <SelectItem key={s.code} value={s.code}>{s.label}</SelectItem>
              ))}
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
              icon={<Handshake className="size-6" />}
              title={t(locale, "crm-no-supplier-offers")}
              description={t(locale, "crm-no-supplier-offers-desc")}
              action={<Button onClick={() => { setEditing(null); setShowForm(true); }}><Plus className="size-4 mr-1" /> {t(locale, "crm-new-offer")}</Button>}
            />
          ) : (
            <div className="max-h-[calc(100vh-280px)] overflow-y-auto custom-scroll">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    <TableHead>{t(locale, "crm-offer-number")}</TableHead>
                    <TableHead>{t(locale, "crm-product")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t(locale, "crm-supplier")}</TableHead>
                    <TableHead className="text-right">{t(locale, "crm-unit-price")}</TableHead>
                    <TableHead className="hidden lg:table-cell text-right">{t(locale, "crm-min-order")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t(locale, "crm-incoterm")}</TableHead>
                    <TableHead className="hidden xl:table-cell">{t(locale, "crm-origin")}</TableHead>
                    <TableHead className="hidden xl:table-cell text-right">{t(locale, "crm-lead")}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t(locale, "crm-valid-until")}</TableHead>
                    <TableHead>{t(locale, "status")}</TableHead>
                    <TableHead className="text-right">{t(locale, "actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((o) => {
                    const product = catalogMap.get(o.product_id);
                    const supplier = partnerMap.get(o.supplier_id);
                    return (
                      <TableRow
                        key={o.id}
                        className="cursor-pointer hover:bg-muted/50 transition-colors"
                        onClick={() => setDetailId(o.id)}
                      >
                        <TableCell>
                          <span className="font-mono text-xs tabular">{o.offer_number || "—"}</span>
                        </TableCell>
                        <TableCell>
                          <div className="font-medium text-sm truncate max-w-[200px]">{product?.name || t(locale, "crm-unknown-product")}</div>
                          <div className="text-xs text-muted-foreground md:hidden">{supplier?.name || "—"}</div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-sm">{supplier?.name || "—"}</TableCell>
                        <TableCell className="text-right tabular text-sm font-medium">
                          {fmtMoney(o.unit_price, o.currency)}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell text-right tabular text-sm">
                          {o.min_order_qty ? o.min_order_qty.toLocaleString() : "—"}
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <Badge variant="outline" className="font-mono">{o.incoterm}</Badge>
                        </TableCell>
                        <TableCell className="hidden xl:table-cell text-sm">
                          <span className="mr-1">{flagEmoji(o.origin_country)}</span>
                          <span className="text-muted-foreground">{o.origin_country ? getCountry(o.origin_country)?.code : "—"}</span>
                        </TableCell>
                        <TableCell className="hidden xl:table-cell text-right tabular text-sm">
                          {o.lead_time_days ? `${o.lead_time_days}d` : "—"}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell text-sm tabular text-muted-foreground">
                          {fmtDate(o.price_valid_until)}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={STATUS_BADGE[o.status]}>{STATUS_LABELS[o.status]}</Badge>
                        </TableCell>
                        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            <Button size="icon" variant="ghost" className="size-8" onClick={() => setDetailId(o.id)} title={t(locale, "view")}>
                              <Eye className="size-4" />
                            </Button>
                            <Button size="icon" variant="ghost" className="size-8" onClick={() => { setEditing(o); setShowForm(true); }} title={t(locale, "edit")}>
                              <Pencil className="size-4" />
                            </Button>
                            <Button size="icon" variant="ghost" className="size-8 text-destructive" onClick={() => setDeleteId(o.id)} title={t(locale, "delete")}>
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <OfferFormDialog
        open={showForm}
        onOpenChange={setShowForm}
        offer={editing}
        catalog={catalog.data?.items || []}
        supplierPartners={supplierPartners}
        onSaved={() => {
          setShowForm(false);
          qc.invalidateQueries({ queryKey: ["supplier-offers", tenantKey] });
        }}
      />

      <Sheet open={!!detailId} onOpenChange={(o) => !o && setDetailId(null)}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto custom-scroll">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Handshake className="size-5" />
              {detail.data?.offer_number || t(locale, "crm-supplier-offer")}
            </SheetTitle>
            <SheetDescription>{t(locale, "crm-offer-details-comparison")}</SheetDescription>
          </SheetHeader>
          {detail.isLoading ? (
            <div className="p-4 space-y-3">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : detail.data ? (
            <OfferDetail
              offer={detail.data}
              product={catalogMap.get(detail.data.product_id)}
              supplier={partnerMap.get(detail.data.supplier_id)}
              comparison={comparison.data?.items || []}
              partnerMap={partnerMap}
              currentId={detail.data.id}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(locale, "crm-delete-offer-title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(locale, "crm-delete-offer-desc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(locale, "cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteId && deleteMut.mutate(deleteId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t(locale, "delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---- Detail panel ----
function OfferSection({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1.5">
        <Icon className="size-3.5" /> {title}
      </p>
      <div className="border border-border/60 rounded-md divide-y divide-border/60 bg-card">
        {children}
      </div>
    </div>
  );
}

function OfferRow({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between p-2.5 gap-3 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={`text-right font-medium ${mono ? "font-mono tabular" : ""}`}>{value || "—"}</span>
    </div>
  );
}

function OfferDetail({
  offer, product, supplier, comparison, partnerMap, currentId,
}: {
  offer: SupplierOffer;
  product?: ProductCatalogEntry;
  supplier?: Partner;
  comparison: SupplierOffer[];
  partnerMap: Map<string, Partner>;
  currentId: string;
}) {
  const locale = useI18nStore((s) => s.locale);
  const STATUS_LABELS = statusLabels(locale);
  const otherOffers = comparison.filter((o) => o.id !== currentId);
  const cur = getCurrency(offer.currency);
  const incoterm = getIncoterm(offer.incoterm);

  return (
    <div className="px-4 pb-6 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={STATUS_BADGE[offer.status]}>{STATUS_LABELS[offer.status]}</Badge>
        <Badge variant="outline" className="font-mono">{offer.incoterm}</Badge>
        {offer.origin_country && (
          <Badge variant="outline">
            <span className="mr-1">{flagEmoji(offer.origin_country)}</span>{getCountry(offer.origin_country)?.name}
          </Badge>
        )}
        <Badge variant="secondary">{cur?.code || offer.currency}</Badge>
      </div>

      {/* Heading summary */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-4 space-y-1">
          <p className="text-xs text-muted-foreground">{t(locale, "crm-product")}</p>
          <p className="font-medium">{product?.name || t(locale, "crm-unknown-product")}</p>
          <p className="text-xs text-muted-foreground mt-2">{t(locale, "crm-supplier")}</p>
          <p className="font-medium">{supplier?.name || t(locale, "crm-unknown-supplier")}</p>
        </CardContent>
      </Card>

      <OfferSection icon={DollarSign} title={t(locale, "crm-pricing")}>
        <OfferRow label={t(locale, "crm-unit-price")} value={`${fmtMoney(offer.unit_price, offer.currency)} / ${product?.base_unit || (product as any)?.unit || t(locale, "crm-unit")}`} mono />
        <OfferRow label={t(locale, "currency")} value={`${cur?.code} — ${cur?.name}`} />
        <OfferRow label={t(locale, "crm-min-order-qty")} value={offer.min_order_qty ? offer.min_order_qty.toLocaleString() : null} mono />
        <OfferRow label={t(locale, "crm-price-valid-until")} value={fmtDate(offer.price_valid_until)} mono />
      </OfferSection>

      <OfferSection icon={Package} title={t(locale, "crm-packaging-loadability")}>
        <OfferRow label={t(locale, "crm-packaging")} value={offer.packaging} />
        <OfferRow label={t(locale, "crm-packing-details")} value={offer.packing_details} />
        <OfferRow label={t(locale, "crm-loadability")} value={offer.loadability} />
        <OfferRow label={t(locale, "crm-specification-notes")} value={offer.specification_notes} />
      </OfferSection>

      <OfferSection icon={Ship} title={t(locale, "crm-trade-terms")}>
        <OfferRow label={t(locale, "crm-incoterm")} value={incoterm ? `${incoterm.code} — ${incoterm.name}` : offer.incoterm} />
        <OfferRow label={t(locale, "crm-loading-port")} value={<span className="flex items-center gap-1"><MapPin className="size-3 text-muted-foreground" />{offer.loading_port}</span>} />
        <OfferRow label={t(locale, "crm-delivery-port")} value={<span className="flex items-center gap-1"><MapPin className="size-3 text-muted-foreground" />{offer.delivery_port}</span>} />
        <OfferRow label={t(locale, "crm-lead-time")} value={<span className="flex items-center gap-1"><Clock className="size-3 text-muted-foreground" />{offer.lead_time_days ? `${offer.lead_time_days} ${t(locale, "crm-days")}` : null}</span>} />
        <OfferRow label={t(locale, "crm-payment-terms")} value={<span className="flex items-center gap-1"><CreditCard className="size-3 text-muted-foreground" />{PAYMENT_TERMS.find((p) => p.code === offer.payment_terms)?.name || offer.payment_terms}</span>} />
      </OfferSection>

      <OfferSection icon={ShieldCheck} title={t(locale, "crm-quality")}>
        <OfferRow label={t(locale, "crm-inspection")} value={offer.inspection} />
        <OfferRow label={t(locale, "crm-certificate")} value={offer.certificate} />
      </OfferSection>

      {offer.notes && (
        <div>
          <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1.5"><FileText className="size-3.5" /> {t(locale, "crm-notes")}</p>
          <p className="text-sm whitespace-pre-wrap p-3 rounded-md bg-muted/50 border border-border/60">{offer.notes}</p>
        </div>
      )}

      <Separator />

      {/* Compare with other suppliers */}
      <div>
        <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1.5">
          <ArrowLeftRight className="size-3.5" /> {t(locale, "crm-compare-with-other-suppliers")} ({otherOffers.length})
        </p>
        {otherOffers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t(locale, "crm-no-other-offers")}</p>
        ) : (
          <div className="border border-border/60 rounded-md overflow-hidden">
            <Table>
              <TableHeader className="bg-muted/40">
                <TableRow>
                  <TableHead className="h-8 text-xs">{t(locale, "crm-supplier")}</TableHead>
                  <TableHead className="h-8 text-xs text-right">{t(locale, "crm-unit-price")}</TableHead>
                  <TableHead className="h-8 text-xs">{t(locale, "crm-incoterm")}</TableHead>
                  <TableHead className="h-8 text-xs hidden sm:table-cell">{t(locale, "crm-origin")}</TableHead>
                  <TableHead className="h-8 text-xs">{t(locale, "status")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {otherOffers.map((o) => {
                  const sup = partnerMap.get(o.supplier_id);
                  return (
                    <TableRow key={o.id} className="text-xs">
                      <TableCell className="font-medium">{sup?.name || "—"}</TableCell>
                      <TableCell className="text-right tabular">{fmtMoney(o.unit_price, o.currency)}</TableCell>
                      <TableCell><Badge variant="outline" className="font-mono">{o.incoterm}</Badge></TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <span className="mr-1">{flagEmoji(o.origin_country)}</span>
                        <span className="text-muted-foreground">{o.origin_country ? getCountry(o.origin_country)?.code : "—"}</span>
                      </TableCell>
                      <TableCell><Badge variant="outline" className={STATUS_BADGE[o.status]}>{STATUS_LABELS[o.status]}</Badge></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <div className="pt-3 border-t">
        <p className="text-xs text-muted-foreground">{t(locale, "crm-created")} {fmtDate(offer.created_at)}</p>
      </div>
    </div>
  );
}

// ---- Form dialog ----
function OfferFormDialog({
  open, onOpenChange, offer, catalog, supplierPartners, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  offer: SupplierOffer | null;
  catalog: any[];
  supplierPartners: Partner[];
  onSaved: () => void;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const locale = useI18nStore((s) => s.locale);
  const STATUS_VALUES = statusValues(locale);
  const catalogMap = new Map(catalog.map((p) => [p.id, p]));

  const [form, setForm] = useState<Partial<SupplierOffer>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(offer
        ? { ...offer }
        : ({
            status: "active", unit_price: 0, currency: "USD", min_order_qty: null,
            price_valid_until: null, packaging: "", packing_details: "", loadability: "",
            specification_notes: "", origin_country: null, incoterm: "FOB",
            loading_port: "", delivery_port: "", lead_time_days: null, payment_terms: null,
            inspection: "", certificate: "", notes: "", offer_number: "",
          } as Partial<SupplierOffer>));
    }
  }, [open, offer]);

  function set<K extends keyof SupplierOffer>(k: K, v: SupplierOffer[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function save() {
    if (!form.product_id) { toast.error(t(locale, "crm-product-required")); return; }
    if (!form.supplier_id) { toast.error(t(locale, "crm-supplier-required")); return; }
    setSaving(true);
    try {
      const method = offer ? "PUT" : "POST";
      const url = offer ? api(`/api/supplier-offers/${offer.id}`) : api("/api/supplier-offers");
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || t(locale, "crm-request-failed"));
      }
      toast.success(offer ? t(locale, "crm-offer-updated") : t(locale, "crm-offer-created"));
      onSaved();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : t(locale, "crm-saving-failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{offer ? t(locale, "crm-edit-offer") : t(locale, "crm-new-offer")}</DialogTitle>
          <DialogDescription>{t(locale, "crm-per-supplier-pricing-desc")}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] overflow-y-auto pr-1">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 py-2">
          <div className="space-y-1.5">
            <Label>{t(locale, "crm-product-required-label")}</Label>
            {/* FIX: use ProductPicker (searchable combobox) instead of flat Select
                with 500+ items that was impossible to navigate. */}
            <ProductPicker
              value={form.product_id || ""}
              onSelect={(p) => {
                if (p) {
                  set("product_id", p.id);
                  // Auto-fill unit price and currency from product if empty
                  if (!form.unit_price && p.price) set("unit_price", p.price);
                  if (!form.currency && p.currency) set("currency", p.currency);
                } else {
                  set("product_id", "");
                }
              }}
              fallbackName={form.product_id ? (catalogMap.get(form.product_id) as any)?.name : undefined}
              placeholder={t(locale, "crm-select-product")}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t(locale, "crm-supplier-required-label")}</Label>
            <PartnerPicker
              value={form.supplier_id || ""}
              filterType="supplier"
              placeholder={t(locale, "crm-select-supplier")}
              onSelect={(p) => set("supplier_id", p?.id || "")}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t(locale, "crm-offer-number")}</Label>
            <Input value={form.offer_number || ""} onChange={(e) => set("offer_number", e.target.value)} placeholder={t(locale, "crm-suppliers-reference-optional")} className="font-mono" />
          </div>
          <div className="space-y-1.5">
            <Label>{t(locale, "status")}</Label>
            <Select value={form.status || "active"} onValueChange={(v) => set("status", v as SupplierOfferStatus)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {STATUS_VALUES.map((s) => (
                  <SelectItem key={s.code} value={s.code}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="md:col-span-2"><Separator className="my-1" /><p className="text-xs text-muted-foreground">{t(locale, "crm-pricing")}</p></div>
          <div className="space-y-1.5">
            <Label>{t(locale, "crm-unit-price-required")}</Label>
            <Input type="number" min={0} step="0.01" value={form.unit_price ?? 0} onChange={(e) => set("unit_price", Number(e.target.value))} className="tabular" />
          </div>
          <div className="space-y-1.5">
            <Label>{t(locale, "currency")}</Label>
            <Select value={form.currency || "USD"} onValueChange={(v) => set("currency", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72">
                {CURRENCIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    <span className="font-mono mr-2">{c.value}</span> {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t(locale, "crm-min-order-qty")}</Label>
            <Input type="number" min={0} value={form.min_order_qty ?? ""} onChange={(e) => set("min_order_qty", e.target.value ? Number(e.target.value) : null)} className="tabular" />
          </div>
          <div className="space-y-1.5">
            <Label>{t(locale, "crm-price-valid-until")}</Label>
            <Input type="date" value={form.price_valid_until ? form.price_valid_until.slice(0, 10) : ""} onChange={(e) => set("price_valid_until", e.target.value ? new Date(e.target.value).toISOString() : null)} className="tabular" />
          </div>

          <div className="md:col-span-2"><Separator className="my-1" /><p className="text-xs text-muted-foreground">{t(locale, "crm-packaging-loadability")}</p></div>
          <div className="md:col-span-2 space-y-1.5">
            <Label>{t(locale, "crm-packaging")}</Label>
            <Input value={form.packaging || ""} onChange={(e) => set("packaging", e.target.value)} placeholder={t(locale, "crm-packaging-placeholder")} />
          </div>
          <div className="md:col-span-2 space-y-1.5">
            <Label>{t(locale, "crm-packing-details")}</Label>
            <Textarea rows={2} value={form.packing_details || ""} onChange={(e) => set("packing_details", e.target.value)} placeholder={t(locale, "crm-packing-details-placeholder")} />
          </div>
          <div className="md:col-span-2 space-y-1.5">
            <Label>{t(locale, "crm-loadability")}</Label>
            <Input value={form.loadability || ""} onChange={(e) => set("loadability", e.target.value)} placeholder='e.g. "28 MT per 40&apos; HC container"' />
          </div>
          <div className="md:col-span-2 space-y-1.5">
            <Label>{t(locale, "crm-specification-notes")}</Label>
            <Textarea rows={2} value={form.specification_notes || ""} onChange={(e) => set("specification_notes", e.target.value)} placeholder={t(locale, "crm-spec-notes-placeholder")} />
          </div>
          <div className="space-y-1.5">
            <Label>{t(locale, "crm-origin-country")}</Label>
            <CountrySelect
              value={form.origin_country}
              onChange={(v) => set("origin_country", v)}
              placeholder={t(locale, "crm-not-specified")}
            />
          </div>

          <div className="md:col-span-2"><Separator className="my-1" /><p className="text-xs text-muted-foreground">{t(locale, "crm-trade-terms")}</p></div>
          <div className="space-y-1.5">
            <Label>{t(locale, "crm-incoterm")}</Label>
            <Select value={form.incoterm || "FOB"} onValueChange={(v) => set("incoterm", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72">
                {INCOTERMS.map((i) => (
                  <SelectItem key={i.code} value={i.code}>
                    <span className="font-mono mr-2">{i.code}</span> {i.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t(locale, "crm-payment-terms")}</Label>
            <Select value={form.payment_terms || "__none__"} onValueChange={(v) => set("payment_terms", v === "__none__" ? null : v)}>
              <SelectTrigger><SelectValue placeholder={t(locale, "crm-not-specified")} /></SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value="__none__">{t(locale, "crm-not-specified")}</SelectItem>
                {PAYMENT_TERMS.map((p) => (
                  <SelectItem key={p.code} value={p.code}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t(locale, "crm-loading-port")}</Label>
            <Input value={form.loading_port || ""} onChange={(e) => set("loading_port", e.target.value)} placeholder="e.g. Santos" />
          </div>
          <div className="space-y-1.5">
            <Label>{t(locale, "crm-delivery-port")}</Label>
            <Input value={form.delivery_port || ""} onChange={(e) => set("delivery_port", e.target.value)} placeholder="e.g. Bar" />
          </div>
          <div className="space-y-1.5">
            <Label>{t(locale, "crm-lead-time-days")}</Label>
            <Input type="number" min={0} value={form.lead_time_days ?? ""} onChange={(e) => set("lead_time_days", e.target.value ? Number(e.target.value) : null)} className="tabular" />
          </div>

          <div className="md:col-span-2"><Separator className="my-1" /><p className="text-xs text-muted-foreground">{t(locale, "crm-quality")}</p></div>
          <div className="space-y-1.5">
            <Label>{t(locale, "crm-inspection")}</Label>
            <Input value={form.inspection || ""} onChange={(e) => set("inspection", e.target.value)} placeholder="e.g. SGS" />
          </div>
          <div className="space-y-1.5">
            <Label>{t(locale, "crm-certificate")}</Label>
            <Input value={form.certificate || ""} onChange={(e) => set("certificate", e.target.value)} placeholder="e.g. ISO 22000, Halal" />
          </div>

          <div className="md:col-span-2 space-y-1.5">
            <Label>{t(locale, "crm-notes")}</Label>
            <Textarea rows={2} value={form.notes || ""} onChange={(e) => set("notes", e.target.value)} />
          </div>
        </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t(locale, "cancel")}</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? t(locale, "crm-saving") : t(locale, "save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
