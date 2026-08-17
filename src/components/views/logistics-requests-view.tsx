"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog";
import { Ship, Truck, Plane, Train, Package, RefreshCw, Search, Trash2, ShieldAlert, MapPin, ClipboardList, FileText, ArrowRightCircle, History, CheckCircle2, MessageSquare, XCircle, Play, Send, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useDebounced } from "@/lib/hooks/use-debounced";
import { useCan } from "@/lib/store/app-store";
import type { Partner } from "@/lib/supabase/types";
import { fmtDateTime, fmtRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { downloadPdf } from "@/lib/utils/download";
import { useI18nStore } from "@/lib/i18n/store";
import { t } from "@/lib/i18n/dictionaries";

interface LogisticsEvent {
  id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  actor_role: "admin" | "client" | "system";
  message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface LogisticsRequest {
  id: string;
  tenant_id: string;
  partner_id: string;
  portal_access_id: string | null;
  number: string;
  tracking_number?: string | null;
  tracking_url?: string | null;
  carrier?: string | null;
  carrier_reference?: string | null;
  quoted_at?: string | null;
  shipped_at?: string | null;
  delivered_at?: string | null;
  status: "pending" | "quoted" | "accepted" | "rejected" | "cancelled" | "in_progress" | "completed";
  mode: string;
  container_type: string | null;
  incoterm: string | null;
  target_pickup_date: string | null;
  target_delivery_date: string | null;
  urgency: string;
  origin_company: string | null;
  origin_country: string | null;
  origin_city: string | null;
  origin_postal_code: string | null;
  origin_address_line: string | null;
  origin_port: string | null;
  origin_contact_name: string | null;
  origin_contact_phone: string | null;
  origin_contact_email: string | null;
  destination_company: string | null;
  destination_country: string | null;
  destination_city: string | null;
  destination_postal_code: string | null;
  destination_address_line: string | null;
  destination_port: string | null;
  destination_contact_name: string | null;
  destination_contact_phone: string | null;
  destination_contact_email: string | null;
  total_weight_kg: number | null;
  total_volume_cbm: number | null;
  total_packages: number | null;
  cargo_description: string | null;
  hs_codes: string | null;
  is_hazardous: boolean;
  is_temperature_controlled: boolean;
  temperature_range: string | null;
  insurance_required: boolean;
  cargo_value: number | null;
  cargo_currency: string | null;
  special_instructions: string | null;
  packing_list: any[];
  quoted_price: number | null;
  quoted_currency: string | null;
  quoted_transit_days: number | null;
  quoted_notes: string | null;
  admin_notes: string | null;
  created_at: string;
  updated_at: string;
}

const MODE_META: Record<string, { labelKey: string; Icon: any; color: string }> = {
  sea_fcl:    { labelKey: "log-mode-sea-fcl",    Icon: Ship,    color: "text-blue-600" },
  sea_lcl:    { labelKey: "log-mode-sea-lcl",    Icon: Ship,    color: "text-blue-500" },
  road_ftl:   { labelKey: "log-mode-road-ftl",   Icon: Truck,   color: "text-amber-600" },
  road_ltl:   { labelKey: "log-mode-road-ltl",   Icon: Truck,   color: "text-amber-500" },
  air:        { labelKey: "log-mode-air",        Icon: Plane,   color: "text-sky-600" },
  rail:       { labelKey: "log-mode-rail",       Icon: Train,   color: "text-emerald-600" },
  courier:    { labelKey: "log-mode-courier",    Icon: Package, color: "text-purple-600" },
  multimodal: { labelKey: "log-mode-multimodal", Icon: Package, color: "text-gray-600" },
};

const STATUS_STYLE: Record<string, string> = {
  pending:     "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  quoted:      "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30",
  accepted:    "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  rejected:    "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
  cancelled:   "bg-gray-500/15 text-gray-700 dark:text-gray-400 border-gray-500/30",
  in_progress: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-400 border-indigo-500/30",
  completed:   "bg-emerald-600/15 text-emerald-800 dark:text-emerald-300 border-emerald-600/30",
};

function statusLabel(locale: import("@/lib/i18n/dictionaries").Locale, status: string): string {
  const key = `log-status-${status.replace(/_/g, "-")}`;
  const translated = t(locale, key);
  return translated === key ? status.replace("_", " ") : translated;
}

export function LogisticsRequestsView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const qc = useQueryClient();
  const locale = useI18nStore((s) => s.locale);

  const [search, setSearch] = React.useState("");
  const debouncedSearch = useDebounced(search, 300);
  const [statusFilter, setStatusFilter] = React.useState<string>("all");
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [toDelete, setToDelete] = React.useState<LogisticsRequest | null>(null);

  const partnersQ = useQuery({
    queryKey: ["log-partners", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/partners?limit=500"));
      return r.ok ? (r.json() as Promise<{ items: Partner[] }>) : { items: [] };
    },
  });
  const partnerMap = React.useMemo(() => new Map((partnersQ.data?.items || []).map((p) => [p.id, p])), [partnersQ.data]);

  const listQ = useQuery({
    queryKey: ["logistics-requests", tenantKey, statusFilter, debouncedSearch],
    queryFn: async () => {
      const q = new URLSearchParams();
      if (statusFilter !== "all") q.set("status", statusFilter);
      if (debouncedSearch) q.set("search", debouncedSearch);
      q.set("limit", "300");
      const r = await fetch(api(`/api/logistics-requests?${q.toString()}`));
      if (!r.ok) throw new Error("Failed to load logistics requests");
      return r.json() as Promise<{ items: LogisticsRequest[]; total: number }>;
    },
  });

  const items = listQ.data?.items || [];
  const openItem = items.find((i) => i.id === openId) || null;

  const delMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(api(`/api/logistics-requests/${id}`), { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Delete failed");
    },
    onSuccess: () => {
      toast.success(t(locale, "log-deleted-toast"));
      qc.invalidateQueries({ queryKey: ["logistics-requests"] });
      setToDelete(null);
      setOpenId(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const counts = React.useMemo(() => {
    const c: Record<string, number> = { pending: 0, quoted: 0, in_progress: 0, completed: 0 };
    for (const it of items) c[it.status] = (c[it.status] || 0) + 1;
    return c;
  }, [items]);

  return (
    <div className="space-y-4">
      <PageHeader
        title={t(locale, "log-page-title")}
        description={t(locale, "log-page-description")}
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile label={t(locale, "log-stat-pending")} value={counts.pending || 0} />
        <StatTile label={t(locale, "log-stat-quoted")} value={counts.quoted || 0} />
        <StatTile label={t(locale, "log-stat-in-progress")} value={counts.in_progress || 0} />
        <StatTile label={t(locale, "log-stat-completed")} value={counts.completed || 0} />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <CardTitle className="text-base">{t(locale, "log-all-requests")}</CardTitle>
              <CardDescription className="text-xs">{t(locale, "log-all-requests-desc")}</CardDescription>
            </div>
            <Button size="sm" variant="outline" onClick={() => listQ.refetch()}>
              <RefreshCw className={cn("size-3.5 mr-1", listQ.isFetching && "animate-spin")} /> {t(locale, "refresh")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pt-0 space-y-3">
          <div className="flex flex-wrap gap-2 items-center">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input placeholder={t(locale, "log-search-placeholder")} className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t(locale, "log-all-statuses")}</SelectItem>
                <SelectItem value="pending">{t(locale, "log-status-pending")}</SelectItem>
                <SelectItem value="quoted">{t(locale, "log-status-quoted")}</SelectItem>
                <SelectItem value="accepted">{t(locale, "log-status-accepted")}</SelectItem>
                <SelectItem value="rejected">{t(locale, "log-status-rejected")}</SelectItem>
                <SelectItem value="in_progress">{t(locale, "log-status-in-progress")}</SelectItem>
                <SelectItem value="completed">{t(locale, "log-status-completed")}</SelectItem>
                <SelectItem value="cancelled">{t(locale, "log-status-cancelled")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="border rounded-lg overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t(locale, "log-col-number")}</TableHead>
                  <TableHead>{t(locale, "log-col-client")}</TableHead>
                  <TableHead>{t(locale, "log-col-mode")}</TableHead>
                  <TableHead>{t(locale, "log-col-route")}</TableHead>
                  <TableHead>{t(locale, "log-col-cargo")}</TableHead>
                  <TableHead>{t(locale, "status")}</TableHead>
                  <TableHead className="text-right">{t(locale, "log-col-received")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {listQ.isLoading && <TableRow><TableCell colSpan={7} className="text-center py-6 text-muted-foreground">{t(locale, "log-loading")}</TableCell></TableRow>}
                {!listQ.isLoading && items.length === 0 && <TableRow><TableCell colSpan={7} className="text-center py-6 text-muted-foreground">{t(locale, "log-no-requests-yet")}</TableCell></TableRow>}
                {items.map((r) => {
                  const meta = MODE_META[r.mode];
                  const modeLabel = meta ? t(locale, meta.labelKey) : r.mode;
                  const Icon = meta?.Icon || Package;
                  const color = meta?.color || "text-gray-500";
                  const partner = partnerMap.get(r.partner_id);
                  return (
                    <TableRow key={r.id} className="cursor-pointer hover:bg-accent/40" onClick={() => setOpenId(r.id)}>
                      <TableCell className="font-mono text-xs">{r.number}</TableCell>
                      <TableCell className="text-sm">{partner?.name || r.partner_id.slice(0, 8)}</TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-1.5 text-xs">
                          <Icon className={cn("size-4", color)} />
                          {modeLabel}
                          {r.container_type && <span className="text-muted-foreground">· {r.container_type}</span>}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="size-3 text-muted-foreground" />
                          {r.origin_city || r.origin_port || r.origin_country || "?"} → {r.destination_city || r.destination_port || r.destination_country || "?"}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[240px] truncate" title={r.cargo_description || ""}>
                        {r.cargo_description || "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={cn("text-[10px] capitalize", STATUS_STYLE[r.status])}>{statusLabel(locale, r.status)}</Badge>
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground" title={fmtDateTime(r.created_at)}>{fmtRelative(r.created_at)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <RequestDetailSheet
        req={openItem}
        partner={openItem ? partnerMap.get(openItem.partner_id) : undefined}
        onClose={() => setOpenId(null)}
        onDelete={(r) => setToDelete(r)}
      />

      <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2"><ShieldAlert className="size-5 text-destructive" /> {t(locale, "log-delete-confirm-title")}</AlertDialogTitle>
            <AlertDialogDescription>{toDelete?.number} — {t(locale, "log-delete-confirm-desc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(locale, "cancel")}</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => toDelete && delMut.mutate(toDelete.id)}>
              {t(locale, "delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RequestDetailSheet({
  req,
  partner,
  onClose,
  onDelete,
}: {
  req: LogisticsRequest | null;
  partner?: Partner;
  onClose: () => void;
  onDelete: (r: LogisticsRequest) => void;
}) {
  const api = useApiUrl();
  const qc = useQueryClient();
  const locale = useI18nStore((s) => s.locale);
  const canUpdate = useCan("logistics.update");
  const canDelete = useCan("logistics.delete");
  const canConvert = useCan("logistics.convert");
  const [status, setStatus] = React.useState<string>("");
  const [price, setPrice] = React.useState<string>("");
  const [currency, setCurrency] = React.useState<string>("USD");
  const [days, setDays] = React.useState<string>("");
  const [quoteNotes, setQuoteNotes] = React.useState<string>("");
  const [adminNotes, setAdminNotes] = React.useState<string>("");
  const [trackingNumber, setTrackingNumber] = React.useState<string>("");
  const [trackingUrl, setTrackingUrl] = React.useState<string>("");
  const [carrier, setCarrier] = React.useState<string>("");
  const [carrierReference, setCarrierReference] = React.useState<string>("");
  const [downloading, setDownloading] = React.useState(false);

  React.useEffect(() => {
    if (req) {
      setStatus(req.status);
      setPrice(req.quoted_price != null ? String(req.quoted_price) : "");
      setCurrency(req.quoted_currency || req.cargo_currency || "USD");
      setDays(req.quoted_transit_days != null ? String(req.quoted_transit_days) : "");
      setQuoteNotes(req.quoted_notes || "");
      setAdminNotes(req.admin_notes || "");
      setTrackingNumber(req.tracking_number || "");
      setTrackingUrl(req.tracking_url || "");
      setCarrier(req.carrier || "");
      setCarrierReference(req.carrier_reference || "");
    }
  }, [req?.id]);

  const eventsQ = useQuery({
    queryKey: ["logistics-events", req?.id],
    queryFn: async () => {
      if (!req) return { items: [] as LogisticsEvent[] };
      const r = await fetch(api(`/api/logistics-requests/${req.id}/events`));
      if (!r.ok) return { items: [] as LogisticsEvent[] };
      return r.json() as Promise<{ items: LogisticsEvent[] }>;
    },
    enabled: !!req,
    refetchInterval: 15_000,
  });

  const toOfferMut = useMutation({
    mutationFn: async () => {
      if (!req) return;
      const r = await fetch(api(`/api/logistics-requests/${req.id}/to-offer`), { method: "POST" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || t(locale, "log-offer-create-failed"));
      return data;
    },
    onSuccess: (data: any) => {
      toast.success(t(locale, "log-offer-created"));
      qc.invalidateQueries({ queryKey: ["logistics-requests"] });
      qc.invalidateQueries({ queryKey: ["logistics-events"] });
      if (data?.offer_id) toast.info(`${t(locale, "log-offer-id")} ${data.offer_id}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!req) return;
      const patch: Record<string, unknown> = {
        status,
        admin_notes: adminNotes || null,
        quoted_notes: quoteNotes || null,
      };
      if (price) patch.quoted_price = Number(price);
      if (currency) patch.quoted_currency = currency;
      if (days) patch.quoted_transit_days = Number(days);
      patch.tracking_number = trackingNumber || null;
      patch.tracking_url = trackingUrl || null;
      patch.carrier = carrier || null;
      patch.carrier_reference = carrierReference || null;
      const r = await fetch(api(`/api/logistics-requests/${req.id}`), {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || t(locale, "log-save-failed"));
    },
    onSuccess: () => {
      toast.success(t(locale, "log-saved-toast"));
      qc.invalidateQueries({ queryKey: ["logistics-requests"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!req) return null;
  const meta = MODE_META[req.mode];
  const modeLabel = meta ? t(locale, meta.labelKey) : req.mode;
  const ModeIcon = meta?.Icon || Package;

  return (
    <Sheet open={!!req} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <ModeIcon className={cn("size-5", meta?.color)} />
            {req.number}
            <Badge variant="outline" className={cn("text-[10px] capitalize ml-2", STATUS_STYLE[req.status])}>{statusLabel(locale, req.status)}</Badge>
          </SheetTitle>
          <SheetDescription>
            {partner?.name || req.partner_id.slice(0, 8)} · {modeLabel}
            {req.container_type && <> · {req.container_type}</>}
            {req.incoterm && <> · {req.incoterm}</>}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-5 mt-4 pb-6">
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">{t(locale, "log-section-route")}</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <AddressCard title={t(locale, "log-address-origin")} data={{
                company: req.origin_company, address: req.origin_address_line,
                city: req.origin_city, postal: req.origin_postal_code, country: req.origin_country,
                port: req.origin_port, contact_name: req.origin_contact_name,
                contact_phone: req.origin_contact_phone, contact_email: req.origin_contact_email,
              }} locale={locale} />
              <AddressCard title={t(locale, "log-address-destination")} data={{
                company: req.destination_company, address: req.destination_address_line,
                city: req.destination_city, postal: req.destination_postal_code, country: req.destination_country,
                port: req.destination_port, contact_name: req.destination_contact_name,
                contact_phone: req.destination_contact_phone, contact_email: req.destination_contact_email,
              }} locale={locale} />
            </div>
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">{t(locale, "log-section-cargo")}</h3>
            <div className="rounded-lg border p-3 text-sm space-y-1.5">
              <p><span className="text-muted-foreground">{t(locale, "log-field-description")}</span> {req.cargo_description || "—"}</p>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div><span className="text-muted-foreground">{t(locale, "log-field-weight")}</span> {req.total_weight_kg ?? "—"} kg</div>
                <div><span className="text-muted-foreground">{t(locale, "log-field-volume")}</span> {req.total_volume_cbm ?? "—"} CBM</div>
                <div><span className="text-muted-foreground">{t(locale, "log-field-packages")}</span> {req.total_packages ?? "—"}</div>
              </div>
              {req.hs_codes && <p className="text-xs"><span className="text-muted-foreground">{t(locale, "log-field-hs-codes")}</span> {req.hs_codes}</p>}
              {req.cargo_value != null && <p className="text-xs"><span className="text-muted-foreground">{t(locale, "log-field-value")}</span> {req.cargo_value} {req.cargo_currency}</p>}
              <div className="flex flex-wrap gap-1 mt-1">
                {req.is_hazardous && <Badge variant="destructive" className="text-[10px]">{t(locale, "log-badge-hazardous")}</Badge>}
                {req.is_temperature_controlled && <Badge variant="outline" className="text-[10px]">{t(locale, "log-badge-temp-controlled")} {req.temperature_range || t(locale, "log-badge-controlled")}</Badge>}
                {req.insurance_required && <Badge variant="outline" className="text-[10px]">{t(locale, "log-badge-insurance")}</Badge>}
                {req.urgency !== "normal" && <Badge variant="outline" className="text-[10px] capitalize">{req.urgency}</Badge>}
              </div>
            </div>
          </section>

          {req.packing_list && req.packing_list.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
                <ClipboardList className="size-3.5" /> {t(locale, "log-section-packing-list")} ({req.packing_list.length})
              </h3>
              <div className="border rounded-lg overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t(locale, "description")}</TableHead>
                      <TableHead>{t(locale, "log-col-hs")}</TableHead>
                      <TableHead className="text-right">{t(locale, "log-col-pkgs")}</TableHead>
                      <TableHead>{t(locale, "type")}</TableHead>
                      <TableHead className="text-right">{t(locale, "log-col-unit-kg")}</TableHead>
                      <TableHead>{t(locale, "log-col-dims")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {req.packing_list.map((l: any, i: number) => (
                      <TableRow key={i}>
                        <TableCell className="text-xs">{l.description || "—"}</TableCell>
                        <TableCell className="text-xs font-mono">{l.hs_code || "—"}</TableCell>
                        <TableCell className="text-xs text-right tabular">{l.packages ?? "—"}</TableCell>
                        <TableCell className="text-xs">{l.package_type || "—"}</TableCell>
                        <TableCell className="text-xs text-right tabular">{l.unit_weight_kg ?? "—"}</TableCell>
                        <TableCell className="text-xs">{[l.length_cm, l.width_cm, l.height_cm].filter(Boolean).join(" × ") || "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          )}

          {(req.target_pickup_date || req.target_delivery_date) && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">{t(locale, "log-section-timing")}</h3>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div><span className="text-muted-foreground">{t(locale, "log-field-pickup")}</span> {req.target_pickup_date || "—"}</div>
                <div><span className="text-muted-foreground">{t(locale, "log-field-delivery")}</span> {req.target_delivery_date || "—"}</div>
              </div>
            </section>
          )}

          {req.special_instructions && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">{t(locale, "log-section-special-instructions")}</h3>
              <p className="rounded-lg border p-3 text-sm whitespace-pre-wrap">{req.special_instructions}</p>
            </section>
          )}

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
              <History className="size-3.5" /> {t(locale, "log-section-timeline")}
            </h3>
            <TimelineList events={eventsQ.data?.items || []} loading={eventsQ.isLoading} locale={locale} />
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">{t(locale, "log-section-quote-status")}</h3>
            <div className="rounded-lg border p-3 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">{t(locale, "log-field-status")}</Label>
                  <Select value={status} onValueChange={setStatus}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pending">{t(locale, "log-status-pending")}</SelectItem>
                      <SelectItem value="quoted">{t(locale, "log-status-quoted")}</SelectItem>
                      <SelectItem value="accepted">{t(locale, "log-status-accepted")}</SelectItem>
                      <SelectItem value="rejected">{t(locale, "log-status-rejected")}</SelectItem>
                      <SelectItem value="in_progress">{t(locale, "log-status-in-progress")}</SelectItem>
                      <SelectItem value="completed">{t(locale, "log-status-completed")}</SelectItem>
                      <SelectItem value="cancelled">{t(locale, "log-status-cancelled")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">{t(locale, "log-field-transit-days")}</Label>
                  <Input type="number" value={days} onChange={(e) => setDays(e.target.value)} placeholder={t(locale, "log-field-transit-days-placeholder")} />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <Label className="text-xs">{t(locale, "log-field-price")}</Label>
                  <Input type="number" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" />
                </div>
                <div>
                  <Label className="text-xs">{t(locale, "log-field-currency")}</Label>
                  <Select value={currency} onValueChange={setCurrency}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="USD">USD</SelectItem>
                      <SelectItem value="EUR">EUR</SelectItem>
                      <SelectItem value="GBP">GBP</SelectItem>
                      <SelectItem value="RSD">RSD</SelectItem>
                      <SelectItem value="CNY">CNY</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label className="text-xs">{t(locale, "log-field-notes-client")}</Label>
                <Textarea rows={3} value={quoteNotes} onChange={(e) => setQuoteNotes(e.target.value)} placeholder={t(locale, "log-field-notes-client-placeholder")} />
              </div>
              <div>
                <Label className="text-xs">{t(locale, "log-field-notes-internal")}</Label>
                <Textarea rows={2} value={adminNotes} onChange={(e) => setAdminNotes(e.target.value)} placeholder={t(locale, "log-field-notes-internal-placeholder")} />
              </div>

              {/* Tracking + carrier — most useful once the shipment is in progress. */}
              <div className="pt-2 border-t">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">{t(locale, "log-shipment-tracking")}</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">{t(locale, "log-field-carrier")}</Label>
                    <Input value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder={t(locale, "log-field-carrier-placeholder")} />
                  </div>
                  <div>
                    <Label className="text-xs">{t(locale, "log-field-carrier-reference")}</Label>
                    <Input value={carrierReference} onChange={(e) => setCarrierReference(e.target.value)} placeholder={t(locale, "log-field-carrier-reference-placeholder")} />
                  </div>
                  <div>
                    <Label className="text-xs">{t(locale, "log-field-tracking-number")}</Label>
                    <Input value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} placeholder={t(locale, "log-field-tracking-number-placeholder")} />
                  </div>
                  <div>
                    <Label className="text-xs">{t(locale, "log-field-tracking-url")}</Label>
                    <Input value={trackingUrl} onChange={(e) => setTrackingUrl(e.target.value)} placeholder="https://…" />
                  </div>
                </div>
                {(req.quoted_at || req.shipped_at || req.delivered_at) && (
                  <div className="mt-2 text-xs text-muted-foreground flex flex-wrap gap-3">
                    {req.quoted_at && <span>{t(locale, "log-quoted-at")} {fmtRelative(req.quoted_at)}</span>}
                    {req.shipped_at && <span>{t(locale, "log-shipped-at")} {fmtRelative(req.shipped_at)}</span>}
                    {req.delivered_at && <span>{t(locale, "log-delivered-at")} {fmtRelative(req.delivered_at)}</span>}
                  </div>
                )}
              </div>

              <div className="pt-2 border-t">
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  disabled={downloading}
                  onClick={async () => {
                    if (!req) return;
                    try {
                      setDownloading(true);
                      await downloadPdf(
                        api(`/api/logistics-requests/${req.id}/packing-list.pdf`),
                        `PackingList_${req.number || req.id}.pdf`,
                      );
                      toast.success(t(locale, "log-pdf-downloaded"));
                    } catch (e: any) {
                      toast.error(e?.message || t(locale, "log-pdf-download-failed"));
                    } finally {
                      setDownloading(false);
                    }
                  }}
                >
                  {downloading ? (
                    <Loader2 className="size-3.5 mr-1 animate-spin" />
                  ) : (
                    <FileText className="size-3.5 mr-1" />
                  )}
                  {t(locale, "log-download-packing-list")}
                </Button>
              </div>
              <div className="flex items-center justify-between gap-2 pt-2 border-t flex-wrap">
                {canDelete ? (
                  <Button variant="ghost" size="sm" className="text-destructive" onClick={() => onDelete(req)}>
                    <Trash2 className="size-4 mr-1" /> {t(locale, "delete")}
                  </Button>
                ) : <span />}
                <div className="flex items-center gap-2">
                  {canConvert && (
                    <Button size="sm" variant="outline" onClick={() => toOfferMut.mutate()} disabled={toOfferMut.isPending || !price}>
                      <ArrowRightCircle className="size-4 mr-1" /> {toOfferMut.isPending ? t(locale, "log-creating") : t(locale, "log-convert-to-offer")}
                    </Button>
                  )}
                  {canUpdate && (
                    <Button size="sm" onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
                      {saveMut.isPending ? t(locale, "log-saving") : t(locale, "log-save-changes")}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function AddressCard({ title, data, locale }: { title: string; data: any; locale: import("@/lib/i18n/dictionaries").Locale }) {
  const bits = [data.address, data.city, data.postal, data.country].filter(Boolean).join(", ");
  const mapsUrl = bits ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(bits)}` : null;
  return (
    <div className="rounded-lg border p-3 text-sm space-y-1">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{title}</p>
      <p className="font-medium">{data.company || "—"}</p>
      <p className="text-xs text-muted-foreground">{bits || "—"}</p>
      {data.port && <p className="text-xs"><span className="text-muted-foreground">{t(locale, "log-field-port")}</span> {data.port}</p>}
      {(data.contact_name || data.contact_phone || data.contact_email) && (
        <div className="text-xs pt-1 border-t mt-1">
          {data.contact_name && <p>{data.contact_name}</p>}
          {data.contact_phone && <p className="text-muted-foreground">{data.contact_phone}</p>}
          {data.contact_email && <p className="text-muted-foreground">{data.contact_email}</p>}
        </div>
      )}
      {mapsUrl && (
        <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-primary inline-flex items-center gap-1 hover:underline">
          <MapPin className="size-3" /> {t(locale, "log-open-in-maps")}
        </a>
      )}
    </div>
  );
}

function TimelineList({ events, loading, locale }: { events: LogisticsEvent[]; loading: boolean; locale: import("@/lib/i18n/dictionaries").Locale }) {
  if (loading) return <p className="text-xs text-muted-foreground">{t(locale, "log-timeline-loading")}</p>;
  if (!events.length) return <p className="text-xs text-muted-foreground py-2">{t(locale, "log-timeline-empty")}</p>;

  const iconFor = (evtType: string) => {
    switch (evtType) {
      case "created": return { Icon: Send, color: "text-primary" };
      case "quoted": return { Icon: FileText, color: "text-blue-600" };
      case "accepted": return { Icon: CheckCircle2, color: "text-emerald-600" };
      case "rejected": return { Icon: XCircle, color: "text-destructive" };
      case "in_progress": return { Icon: Play, color: "text-indigo-600" };
      case "completed": return { Icon: CheckCircle2, color: "text-emerald-700" };
      case "cancelled": return { Icon: XCircle, color: "text-muted-foreground" };
      case "converted_to_offer": return { Icon: ArrowRightCircle, color: "text-primary" };
      case "note": return { Icon: MessageSquare, color: "text-muted-foreground" };
      default: return { Icon: History, color: "text-muted-foreground" };
    }
  };
  return (
    <ol className="relative border-l border-border/60 ml-2 space-y-3 pl-4">
      {events.map((e) => {
        const { Icon, color } = iconFor(e.event_type);
        return (
          <li key={e.id} className="relative">
            <span className={cn("absolute -left-[22px] top-0 size-4 rounded-full bg-background border border-border flex items-center justify-center", color)}>
              <Icon className="size-2.5" />
            </span>
            <div className="text-xs">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium capitalize">{e.event_type.replace(/_/g, " ")}</span>
                {e.from_status && e.to_status && e.from_status !== e.to_status && (
                  <span className="text-muted-foreground">{e.from_status} → {e.to_status}</span>
                )}
                <Badge variant="outline" className="text-[10px] capitalize">{e.actor_role}</Badge>
                <span className="text-muted-foreground" title={fmtDateTime(e.created_at)}>{fmtRelative(e.created_at)}</span>
              </div>
              {e.message && <p className="text-muted-foreground mt-0.5">{e.message}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border/60 p-3 bg-card">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-xl font-bold tabular mt-0.5">{value.toLocaleString()}</p>
    </div>
  );
}
