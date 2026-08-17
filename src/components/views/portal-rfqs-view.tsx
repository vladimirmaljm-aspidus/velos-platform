"use client";

import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Search, Inbox, Eye, Clock, FileText, Package, CheckCircle2, XCircle,
  ArrowRightLeft, FilePlus2, Save, Loader2, MapPin, Ship, CalendarDays,
  Tag, Hash, DollarSign, Boxes, Building2, StickyNote, FileCheck2,
  Users as UsersIcon, Zap, RefreshCw, Factory, ShieldCheck, Globe2, Wallet, Repeat, User,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { KpiCard } from "@/components/common/kpi-card";
import { fmtMoney, fmtDate, fmtRelative, fmtDateTime, fmtNumber } from "@/lib/utils/format";
import {
  PortalRfq, PortalRfqStatus, Partner,
} from "@/lib/supabase/types";
import {
  COUNTRIES, INCOTERMS, PRODUCT_CATEGORIES, UNITS_OF_MEASURE, getCountry, getIncoterm,
} from "@/lib/data/reference";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useDebounced } from "@/lib/hooks/use-debounced";
import { useT } from "@/lib/i18n/store";
import { PartnerPicker } from "@/components/common/partner-picker";

// ---------- static lookups ----------

const STATUS_LABEL_KEYS: Record<PortalRfqStatus, string> = {
  pending: "portal-rfqs-status-pending",
  quoted: "portal-rfqs-status-quoted",
  accepted: "portal-rfqs-status-accepted",
  declined: "portal-rfqs-status-declined",
  expired: "portal-rfqs-status-expired",
};

function statusBadgeClass(status: PortalRfqStatus): string {
  switch (status) {
    case "pending":
      return "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200";
    case "quoted":
      return "border-transparent bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-200";
    case "accepted":
      return "border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200";
    case "declined":
      return "border-transparent bg-destructive text-white";
    case "expired":
    default:
      return "border-transparent bg-muted text-muted-foreground";
  }
}

function categoryLabel(code: string | null): string {
  if (!code) return "—";
  return PRODUCT_CATEGORIES.find((c) => c.code === code)?.name || code;
}

function unitLabel(code: string): string {
  return UNITS_OF_MEASURE.find((u) => u.code === code)?.name || code;
}

function incotermLabel(code: string | null): string {
  if (!code) return "—";
  return getIncoterm(code)?.name || code;
}

function countryLabel(code: string | null): string {
  if (!code) return "—";
  return getCountry(code)?.name || code;
}

// ---------- main view ----------

export function PortalRfqsView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search, 300);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [partnerFilter, setPartnerFilter] = useState<string>("all");
  const [detailId, setDetailId] = useState<string | null>(null);

  // RFQ list
  const { data, isLoading } = useQuery({
    queryKey: ["portal-rfqs", tenantKey, debouncedSearch, statusFilter, partnerFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (partnerFilter !== "all") params.set("partner_id", partnerFilter);
      const r = await fetch(api(`/api/portal-rfqs?${params}`));
      if (!r.ok) throw new Error("Failed to load client requests");
      return r.json() as Promise<{ items: PortalRfq[]; total: number }>;
    },
  });

  // Partners lookup
  const partnersQ = useQuery({
    queryKey: ["partners", tenantKey, "lookup", "rfqs"],
    queryFn: async () => {
      const r = await fetch(api(`/api/partners?limit=500`));
      if (!r.ok) throw new Error("Failed to load partners");
      return r.json() as Promise<{ items: Partner[]; total: number }>;
    },
  });

  const partnerMap = useMemo(() => {
    const m = new Map<string, Partner>();
    partnersQ.data?.items.forEach((p) => m.set(p.id, p));
    return m;
  }, [partnersQ.data]);

  const items = data?.items || [];

  const kpis = useMemo(() => {
    return {
      pending: items.filter((r) => r.status === "pending").length,
      quoted: items.filter((r) => r.status === "quoted").length,
      accepted: items.filter((r) => r.status === "accepted").length,
      declined: items.filter((r) => r.status === "declined").length,
    };
  }, [items]);

  function resolvePartnerName(rfq: PortalRfq): string {
    return partnerMap.get(rfq.partner_id)?.name || t("portal-rfqs-unknown-partner");
  }

  return (
    <div>
      <PageHeader
        title={t("portal-rfqs-title")}
        description={t("portal-rfqs-desc")}
      />

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <KpiCard
          label={t("portal-rfqs-kpi-pending")}
          value={kpis.pending}
          sub={t("portal-rfqs-kpi-pending-sub")}
          icon={Clock}
          iconClassName={kpis.pending > 0 ? "text-warning" : undefined}
        />
        <KpiCard
          label={t("portal-rfqs-kpi-quoted")}
          value={kpis.quoted}
          sub={t("portal-rfqs-kpi-quoted-sub")}
          icon={FileText}
        />
        <KpiCard
          label={t("portal-rfqs-kpi-accepted")}
          value={kpis.accepted}
          sub={t("portal-rfqs-kpi-accepted-sub")}
          icon={CheckCircle2}
          iconClassName="text-success"
        />
        <KpiCard
          label={t("portal-rfqs-kpi-declined")}
          value={kpis.declined}
          sub={t("portal-rfqs-kpi-declined-sub")}
          icon={XCircle}
          iconClassName="text-destructive"
        />
      </div>

      {/* Filters */}
      <Card className="mb-4 border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-3 flex flex-col md:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder={t("portal-rfqs-search-placeholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full md:w-44">
              <SelectValue placeholder={t("status")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("portal-rfqs-all-statuses")}</SelectItem>
              <SelectItem value="pending">{t("portal-rfqs-status-pending")}</SelectItem>
              <SelectItem value="quoted">{t("portal-rfqs-status-quoted")}</SelectItem>
              <SelectItem value="accepted">{t("portal-rfqs-status-accepted")}</SelectItem>
              <SelectItem value="declined">{t("portal-rfqs-status-declined")}</SelectItem>
              <SelectItem value="expired">{t("portal-rfqs-status-expired")}</SelectItem>
            </SelectContent>
          </Select>
          <PartnerPicker
            value={partnerFilter === "all" ? "" : partnerFilter}
            allowClear
            placeholder={t("portal-rfqs-col-partner")}
            onSelect={(p) => setPartnerFilter(p?.id || "all")}
            className="md:w-52"
          />
        </CardContent>
      </Card>

      {/* List */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={<Inbox className="size-6" />}
              title={t("portal-rfqs-empty-title")}
              description={t("portal-rfqs-empty-desc")}
            />
          ) : (
            <div className="max-h-[calc(100vh-380px)] overflow-y-auto custom-scroll">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    <TableHead>{t("portal-rfqs-col-number")}</TableHead>
                    <TableHead>{t("portal-rfqs-col-product")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("portal-rfqs-col-partner")}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t("portal-rfqs-col-category")}</TableHead>
                    <TableHead className="text-right">{t("portal-rfqs-col-qty")}</TableHead>
                    <TableHead className="hidden sm:table-cell text-right">{t("portal-rfqs-col-target")}</TableHead>
                    <TableHead>{t("status")}</TableHead>
                    <TableHead className="hidden xl:table-cell">{t("portal-rfqs-col-created")}</TableHead>
                    <TableHead className="text-right">{t("actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((rfq) => (
                    <TableRow
                      key={rfq.id}
                      className="cursor-pointer hover:bg-muted/50 transition-colors"
                      onClick={() => setDetailId(rfq.id)}
                    >
                      <TableCell>
                        <span className="font-mono text-xs tabular text-foreground/80">{rfq.number}</span>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium truncate max-w-[220px]">{rfq.product_name}</div>
                        {rfq.product_description && (
                          <div className="text-xs text-muted-foreground truncate max-w-[220px]">
                            {rfq.product_description}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <div className="flex items-center gap-1.5 text-sm">
                          <Building2 className="size-3.5 text-muted-foreground shrink-0" />
                          <span className="truncate max-w-[160px]">{resolvePartnerName(rfq)}</span>
                        </div>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <Badge variant="outline" className="text-[11px]">
                          {categoryLabel(rfq.category)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular text-sm">
                        {fmtNumber(rfq.quantity)} <span className="text-muted-foreground text-xs">{rfq.unit}</span>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-right tabular text-sm">
                        {rfq.target_price ? (
                          <span>{fmtMoney(rfq.target_price, rfq.currency)}</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge className={statusBadgeClass(rfq.status)}>{t(STATUS_LABEL_KEYS[rfq.status])}</Badge>
                      </TableCell>
                      <TableCell className="hidden xl:table-cell text-xs text-muted-foreground tabular">
                        {fmtRelative(rfq.created_at)}
                      </TableCell>
                      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8"
                          onClick={() => setDetailId(rfq.id)}
                        >
                          <Eye className="size-3.5 mr-1" />
                          {t("view")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Detail sheet */}
      <RfqDetailSheet
        id={detailId}
        open={!!detailId}
        onOpenChange={(o) => !o && setDetailId(null)}
        partnerMap={partnerMap}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ["portal-rfqs", tenantKey] });
        }}
      />
    </div>
  );
}

// ---------- detail sheet ----------

function RfqDetailSheet({
  id, open, onOpenChange, partnerMap, onSaved,
}: {
  id: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  partnerMap: Map<string, Partner>;
  onSaved: () => void;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [status, setStatus] = useState<PortalRfqStatus | "">("");
  const [adminNotes, setAdminNotes] = useState("");
  const [linkedOfferId, setLinkedOfferId] = useState("");
  const [dirty, setDirty] = useState(false);
  // Track the entity we've initialised the form for, so we can re-sync when it changes
  // (React 19 pattern: store info from previous render to derive state without useEffect).
  const [lastInitId, setLastInitId] = useState<string | null>(null);

  // Load full RFQ
  const q = useQuery({
    queryKey: ["portal-rfq", tenantKey, id],
    queryFn: async () => {
      // The list route already returns full records; refetch for safety / freshness
      const r = await fetch(api(`/api/portal-rfqs?search=&status=&partner_id=`));
      if (!r.ok) throw new Error("Failed to load");
      const data = await r.json() as { items: PortalRfq[] };
      return data.items.find((x) => x.id === id) || null;
    },
    enabled: !!id,
  });

  // For lookup simplicity, also try fetching via the PUT (only endpoint on [id]).
  // We use the list approach since no GET /api/portal-rfqs/[id] exists.

  if (open && id && id !== lastInitId && q.data) {
    setLastInitId(id);
    setStatus(q.data.status);
    setAdminNotes(q.data.admin_notes || "");
    setLinkedOfferId(q.data.linked_offer_id || "");
    setDirty(false);
  }
  if (!open && lastInitId !== null) {
    setLastInitId(null);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(api(`/api/portal-rfqs/${id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: status || undefined,
          admin_notes: adminNotes,
          linked_offer_id: linkedOfferId || null,
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Save failed");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("portal-rfqs-toast-updated"));
      setDirty(false);
      onSaved();
    },
    onError: (e: any) => toast.error(e.message || t("portal-rfqs-toast-save-failed")),
  });

  const rfq = q.data;
  const partner = rfq ? partnerMap.get(rfq.partner_id) : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto custom-scroll p-0">
        <SheetHeader className="px-6 pt-6 pb-4 border-b border-border/60 sticky top-0 bg-card z-20">
          <SheetTitle className="flex items-center gap-2 pr-8">
            <Inbox className="size-5 text-primary" />
            <span className="truncate">{rfq?.product_name || t("portal-rfqs-detail-default-title")}</span>
          </SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-2 mt-1">
            {rfq && (
              <>
                <span className="font-mono tabular text-xs">{rfq.number}</span>
                <Badge className={statusBadgeClass(rfq.status)}>{t(STATUS_LABEL_KEYS[rfq.status])}</Badge>
                <span className="text-xs text-muted-foreground">{t("portal-rfqs-created-prefix")} {fmtRelative(rfq.created_at)}</span>
              </>
            )}
          </SheetDescription>
        </SheetHeader>

        {q.isLoading ? (
          <div className="p-6 space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : !rfq ? (
          <div className="p-6">
            <EmptyState title={t("portal-rfqs-not-found-title")} description={t("portal-rfqs-not-found-desc")} />
          </div>
        ) : (
          <div className="px-6 py-5 space-y-5">
            {/* Product summary */}
            <Card className="border-border/60 shadow-soft">
              <CardHeader className="pb-2 pt-4">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Package className="size-4 text-primary" />
                  {t("portal-rfqs-card-product")}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0 space-y-3">
                <div>
                  <p className="text-base font-medium">{rfq.product_name}</p>
                  {rfq.product_description && (
                    <p className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap">{rfq.product_description}</p>
                  )}
                </div>
                <Separator />
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <InfoRow icon={Tag} label={t("portal-rfqs-label-category")} value={categoryLabel(rfq.category)} />
                  <InfoRow icon={Boxes} label={t("portal-rfqs-label-quantity")} value={`${fmtNumber(rfq.quantity)} ${unitLabel(rfq.unit)}`} />
                  <InfoRow
                    icon={DollarSign}
                    label={t("portal-rfqs-label-target-price")}
                    value={rfq.target_price ? `${fmtMoney(rfq.target_price, rfq.currency)} / ${rfq.unit}` : "—"}
                  />
                  <InfoRow icon={Hash} label={t("portal-rfqs-label-currency")} value={rfq.currency} />
                </div>
                {rfq.specifications && (
                  <>
                    <Separator />
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1">{t("portal-rfqs-label-specifications")}</p>
                      <p className="text-sm whitespace-pre-wrap">{rfq.specifications}</p>
                    </div>
                  </>
                )}
                {rfq.notes && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">{t("portal-rfqs-label-client-notes")}</p>
                    <p className="text-sm whitespace-pre-wrap p-2.5 rounded-md bg-muted/40 border border-border/40">
                      {rfq.notes}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Delivery + Partner */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Card className="border-border/60 shadow-soft">
                <CardHeader className="pb-2 pt-4">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Ship className="size-4 text-primary" />
                    {t("portal-rfqs-card-delivery")}
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0 space-y-2">
                  <InfoRow icon={MapPin} label={t("portal-rfqs-label-country")} value={countryLabel(rfq.delivery_country)} />
                  <InfoRow icon={Ship} label={t("portal-rfqs-label-port")} value={rfq.delivery_port || "—"} />
                  <InfoRow icon={CalendarDays} label={t("portal-rfqs-label-date")} value={rfq.delivery_date ? fmtDate(rfq.delivery_date) : "—"} />
                  <InfoRow icon={ArrowRightLeft} label={t("portal-rfqs-label-incoterm")} value={incotermLabel(rfq.incoterm)} />
                </CardContent>
              </Card>

              <Card className="border-border/60 shadow-soft">
                <CardHeader className="pb-2 pt-4">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Building2 className="size-4 text-primary" />
                    {t("portal-rfqs-card-partner")}
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  {partner ? (
                    <div className="space-y-2">
                      <div>
                        <p className="text-base font-medium">{partner.name}</p>
                        <p className="text-xs text-muted-foreground">{partner.email || "—"}</p>
                      </div>
                      <div className="grid grid-cols-1 gap-1.5 text-xs">
                        <PartnerRow label={t("portal-rfqs-label-type")} value={partner.type} />
                        <PartnerRow label={t("portal-rfqs-label-contact")} value={partner.contact_name || partner.contact_email || "—"} />
                        <PartnerRow label={t("portal-rfqs-label-country")} value={countryLabel(partner.country)} />
                        <PartnerRow label={t("portal-rfqs-label-phone")} value={partner.contact_phone || partner.phone || "—"} />
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t("portal-rfqs-partner-not-found")}</p>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Commercial terms + delivery schedule */}
            {(rfq.payment_method || rfq.payment_terms || rfq.urgency || rfq.delivery_schedule) && (
              <Card className="border-border/60 shadow-soft">
                <CardHeader className="pb-2 pt-4">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Wallet className="size-4 text-primary" />
                    {t("portal-rfqs-card-commercial")}
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <InfoRow icon={DollarSign} label={t("portal-rfqs-label-payment-method")} value={rfq.payment_method ? rfq.payment_method.toUpperCase() : "—"} />
                    <InfoRow icon={Wallet} label={t("portal-rfqs-label-payment-terms")} value={rfq.payment_terms || "—"} />
                    <InfoRow icon={Zap} label={t("portal-rfqs-label-urgency")} value={rfq.urgency || "—"} />
                    <InfoRow icon={Repeat} label={t("portal-rfqs-label-schedule")} value={rfq.delivery_schedule || "—"} />
                    {rfq.delivery_schedule && rfq.delivery_schedule !== "one_time" && (
                      <>
                        <InfoRow icon={Boxes} label={t("portal-rfqs-label-qty-per-shipment")} value={rfq.per_shipment_qty != null ? `${fmtNumber(rfq.per_shipment_qty)} ${unitLabel(rfq.unit)}` : "—"} />
                        <InfoRow icon={RefreshCw} label={t("portal-rfqs-label-shipments-period")} value={rfq.shipments_per_period != null ? String(rfq.shipments_per_period) : "—"} />
                        <InfoRow icon={CalendarDays} label={t("portal-rfqs-label-contract-duration")} value={rfq.contract_duration_months != null ? `${rfq.contract_duration_months} ${t("portal-rfqs-months-suffix")}` : "—"} />
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Use case + certifications */}
            {(rfq.target_market || rfq.end_use || rfq.quality_standard || rfq.certifications_required || rfq.packaging_requirements) && (
              <Card className="border-border/60 shadow-soft">
                <CardHeader className="pb-2 pt-4">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Factory className="size-4 text-primary" />
                    {t("portal-rfqs-card-use-case")}
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0 space-y-3">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <InfoRow icon={Factory} label={t("portal-rfqs-label-target-market")} value={rfq.target_market || "—"} />
                    <InfoRow icon={ShieldCheck} label={t("portal-rfqs-label-quality-standard")} value={rfq.quality_standard || "—"} />
                  </div>
                  {rfq.end_use && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1">{t("portal-rfqs-label-end-use")}</p>
                      <p className="text-sm whitespace-pre-wrap p-2.5 rounded-md bg-muted/40 border border-border/40">{rfq.end_use}</p>
                    </div>
                  )}
                  {rfq.certifications_required && (
                    <InfoRow icon={ShieldCheck} label={t("portal-rfqs-label-certifications")} value={rfq.certifications_required} />
                  )}
                  {rfq.packaging_requirements && (
                    <InfoRow icon={Package} label={t("portal-rfqs-label-packaging")} value={rfq.packaging_requirements} />
                  )}
                </CardContent>
              </Card>
            )}

            {/* Buyer identity */}
            {rfq.buyer_type && (
              <Card className={`border-shadow-soft ${rfq.buyer_type === "third_party" ? "border-amber-500/40 bg-amber-500/[0.03]" : "border-border/60"}`}>
                <CardHeader className="pb-2 pt-4">
                  <CardTitle className="text-sm flex items-center gap-2">
                    {rfq.buyer_type === "third_party" ? <UsersIcon className="size-4 text-amber-600" /> : <User className="size-4 text-primary" />}
                    {rfq.buyer_type === "third_party" ? t("portal-rfqs-buyer-third-party") : t("portal-rfqs-buyer-client")}
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  {rfq.buyer_type === "third_party" ? (
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                      <InfoRow icon={Building2} label={t("portal-rfqs-label-company")} value={rfq.third_party_company_name || "—"} />
                      <InfoRow icon={Factory} label={t("portal-rfqs-label-business-type")} value={rfq.third_party_business_type || "—"} />
                      <InfoRow icon={Globe2} label={t("portal-rfqs-label-country")} value={countryLabel(rfq.third_party_country)} />
                      <InfoRow icon={Hash} label={t("portal-rfqs-label-tax-id")} value={rfq.third_party_tax_id || "—"} />
                      <InfoRow icon={FileText} label={t("portal-rfqs-label-email")} value={rfq.third_party_contact_email || "—"} />
                      <InfoRow icon={FileText} label={t("portal-rfqs-label-phone")} value={rfq.third_party_contact_phone || "—"} />
                      {rfq.third_party_website && (
                        <div className="col-span-2 text-sm"><span className="text-xs text-muted-foreground">{t("portal-rfqs-label-website")}</span> <a href={rfq.third_party_website} target="_blank" rel="noopener noreferrer" className="ml-1 text-primary hover:underline">{rfq.third_party_website}</a></div>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t("portal-rfqs-buyer-third-party-desc")}</p>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Admin response */}
            <Card className="border-border/60 shadow-soft">
              <CardHeader className="pb-2 pt-4">
                <CardTitle className="text-sm flex items-center gap-2">
                  <FileCheck2 className="size-4 text-primary" />
                  {t("portal-rfqs-card-admin")}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t("portal-rfqs-label-status")}</Label>
                    <Select
                      value={status}
                      onValueChange={(v) => { setStatus(v as PortalRfqStatus); setDirty(true); }}
                    >
                      <SelectTrigger><SelectValue placeholder={t("portal-rfqs-placeholder-status")} /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="pending">{t("portal-rfqs-status-pending")}</SelectItem>
                        <SelectItem value="quoted">{t("portal-rfqs-status-quoted")}</SelectItem>
                        <SelectItem value="accepted">{t("portal-rfqs-status-accepted")}</SelectItem>
                        <SelectItem value="declined">{t("portal-rfqs-status-declined")}</SelectItem>
                        <SelectItem value="expired">{t("portal-rfqs-status-expired")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t("portal-rfqs-label-linked-offer")}</Label>
                    <Input
                      placeholder={t("portal-rfqs-placeholder-linked-offer")}
                      value={linkedOfferId}
                      onChange={(e) => { setLinkedOfferId(e.target.value); setDirty(true); }}
                      className="font-mono text-sm"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs flex items-center gap-1.5">
                    <StickyNote className="size-3.5" />
                    {t("portal-rfqs-label-admin-notes")}
                  </Label>
                  <Textarea
                    placeholder={t("portal-rfqs-placeholder-admin-notes")}
                    rows={4}
                    value={adminNotes}
                    onChange={(e) => { setAdminNotes(e.target.value); setDirty(true); }}
                  />
                </div>

                <Separator />

                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        try {
                          const res = await fetch(api(`/api/automation/create-demand-from-portal-rfq`), {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ portalRfqId: rfq?.id }),
                          });
                          if (!res.ok) throw new Error("Failed to create demand");
                          const data = await res.json();
                          toast.success(t("portal-rfqs-toast-demand-created").replace("{number}", data.demand?.demand_number || data.id));
                        } catch {
                          toast.error(t("portal-rfqs-toast-demand-failed"));
                        }
                      }}
                    >
                      <ArrowRightLeft className="size-3.5 mr-1" />
                      {t("portal-rfqs-convert-to-demand")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        try {
                          const res = await fetch(api(`/api/automation/create-offer-from-deal`), {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ dealId: rfq?.linked_demand_id ?? rfq?.id }),
                          });
                          if (!res.ok) throw new Error("Failed to create offer");
                          const data = await res.json();
                          toast.success(t("portal-rfqs-toast-offer-created").replace("{number}", data.offer?.offer_number || data.id));
                        } catch {
                          toast.error(t("portal-rfqs-toast-offer-failed"));
                        }
                      }}
                    >
                      <FilePlus2 className="size-3.5 mr-1" />
                      {t("portal-rfqs-create-offer")}
                    </Button>
                  </div>
                  <Button
                    size="sm"
                    className="bg-emerald-600 hover:bg-emerald-700 text-white"
                    disabled={!dirty || saveMut.isPending}
                    onClick={() => saveMut.mutate()}
                  >
                    {saveMut.isPending ? (
                      <Loader2 className="size-3.5 mr-1 animate-spin" />
                    ) : (
                      <Save className="size-3.5 mr-1" />
                    )}
                    {t("portal-rfqs-save-changes")}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {rfq.linked_offer_id && !dirty && (
              <div className="text-xs text-muted-foreground">
                {t("portal-rfqs-label-linked-offer-prefix")} <span className="font-mono tabular">{rfq.linked_offer_id}</span>
              </div>
            )}

            <div className="pt-3 border-t border-border/60">
              <p className="text-xs text-muted-foreground">
                {t("portal-rfqs-label-last-updated")} {fmtDateTime(rfq.updated_at)}
              </p>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ---------- helpers ----------

function InfoRow({
  icon: Icon, label, value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="size-3.5 text-muted-foreground mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] text-muted-foreground">{label}</p>
        <p className="text-sm break-words">{value}</p>
      </div>
    </div>
  );
}

function PartnerRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium truncate max-w-[60%] text-right">{value}</span>
    </div>
  );
}
