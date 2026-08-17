"use client";

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card, CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  ArrowUp, ArrowDown, Search, Boxes, Activity, Users, Eye, Layers,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { KpiCard } from "@/components/common/kpi-card";
import { fmtDateTime, fmtNumber } from "@/lib/utils/format";
import { InventoryMovement, Partner, Product } from "@/lib/supabase/types";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useI18nStore } from "@/lib/i18n/store";
import { t } from "@/lib/i18n/dictionaries";
import { PartnerPicker } from "@/components/common/partner-picker";

export function InventoryView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const locale = useI18nStore((s) => s.locale);

  const [partnerFilter, setPartnerFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["inventory", tenantKey, "all", partnerFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (partnerFilter !== "all") params.set("partner_id", partnerFilter);
      const r = await fetch(api(`/api/inventory?${params}`));
      if (!r.ok) throw new Error("Failed to load inventory");
      return r.json() as Promise<{ items: InventoryMovement[]; total: number }>;
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

  const products = useQuery({
    queryKey: ["products", tenantKey, "list", "1000"],
    queryFn: async () => {
      const r = await fetch(api(`/api/products?limit=1000`));
      if (!r.ok) throw new Error("Failed to load products");
      return r.json() as Promise<{ items: Product[]; total: number }>;
    },
  });

  const items = data?.items || [];
  const partnerList = partners.data?.items || [];
  const productList = products.data?.items || [];
  const partnerName = (id: string) => partnerList.find((p) => p.id === id)?.name || "—";
  const productName = (id: string) => productList.find((p) => p.id === id)?.name || "—";

  // Client-side search filter (server doesn't support search param for inventory)
  const filtered = useMemo(() => {
    if (!search.trim()) return items;
    const q = search.toLowerCase();
    return items.filter((m) => {
      return (
        partnerName(m.partner_id).toLowerCase().includes(q) ||
        productName(m.product_id).toLowerCase().includes(q) ||
        (m.reason || "").toLowerCase().includes(q) ||
        (m.reference || "").toLowerCase().includes(q)
      );
    });
  }, [items, search, partnerList, productList]);

  // KPI computations (last 30 days)
  const kpis = useMemo(() => {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    let movements30d = 0;
    let netChange = 0;
    const activePartners = new Set<string>();
    for (const m of items) {
      if (new Date(m.created_at).getTime() >= cutoff) {
        movements30d += 1;
        netChange += Number(m.delta) || 0;
        if (m.partner_id) activePartners.add(m.partner_id);
      }
    }
    return { movements30d, netChange, activePartners: activePartners.size };
  }, [items]);

  const detail = detailId ? items.find((m) => m.id === detailId) : null;

  return (
    <div>
      <PageHeader
        title={t(locale, "inventory")}
        description={t(locale, "crm-inventory-desc")}
      />

      {/* KPI summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <KpiCard
          label={t(locale, "crm-movements-30d")}
          value={fmtNumber(kpis.movements30d)}
          sub={t(locale, "crm-last-30-days")}
          icon={Activity}
        />
        <KpiCard
          label={t(locale, "crm-net-stock-change")}
          value={fmtNumber(kpis.netChange)}
          sub={t(locale, "crm-sum-deltas-30d")}
          icon={Boxes}
          iconClassName={kpis.netChange >= 0 ? "text-success" : "text-destructive"}
        />
        <KpiCard
          label={t(locale, "crm-active-partners")}
          value={fmtNumber(kpis.activePartners)}
          sub={t(locale, "crm-with-movements-30d")}
          icon={Users}
        />
      </div>

      <Card className="mb-4 border-border/60 shadow-soft">
        <CardContent className="p-3 flex flex-col md:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              aria-label={t(locale, "crm-search-inventory")}
              placeholder={t(locale, "crm-search-inventory-placeholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <PartnerPicker
            value={partnerFilter === "all" ? "" : partnerFilter}
            allowClear
            placeholder={t(locale, "crm-partner")}
            onSelect={(p) => setPartnerFilter(p?.id || "all")}
            className="md:w-56"
          />
        </CardContent>
      </Card>

      <Card className="border-border/60 shadow-soft">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<Layers className="size-6" />}
              title={t(locale, "crm-no-inventory-movements")}
              description={t(locale, "crm-inventory-empty-desc")}
            />
          ) : (
            <div className="max-h-[calc(100vh-280px)] overflow-y-auto custom-scroll">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    <TableHead>{t(locale, "date")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t(locale, "crm-partner")}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t(locale, "crm-product")}</TableHead>
                    <TableHead>{t(locale, "crm-delta")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t(locale, "crm-reason")}</TableHead>
                    <TableHead className="hidden xl:table-cell">{t(locale, "crm-reference")}</TableHead>
                    <TableHead className="text-right">{t(locale, "actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((m) => {
                    const delta = Number(m.delta) || 0;
                    const positive = delta > 0;
                    const negative = delta < 0;
                    return (
                      <TableRow
                        key={m.id}
                        className={`cursor-pointer hover:bg-muted/50 ${positive ? "bg-emerald-50/40 dark:bg-emerald-500/5" : ""} ${negative ? "bg-rose-50/40 dark:bg-rose-500/5" : ""}`}
                        onClick={() => setDetailId(m.id)}
                      >
                        <TableCell className="text-xs">{fmtDateTime(m.created_at)}</TableCell>
                        <TableCell className="hidden md:table-cell">{partnerName(m.partner_id)}</TableCell>
                        <TableCell className="hidden lg:table-cell">{productName(m.product_id)}</TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex items-center gap-1 font-medium tabular ${positive ? "text-emerald-600" : negative ? "text-destructive" : "text-muted-foreground"}`}
                          >
                            {positive ? <ArrowUp className="size-3.5" /> : negative ? <ArrowDown className="size-3.5" /> : null}
                            {delta > 0 ? "+" : ""}{fmtNumber(delta)}
                          </span>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <span className="text-sm">{m.reason || "—"}</span>
                        </TableCell>
                        <TableCell className="hidden xl:table-cell font-mono text-xs">{m.reference || "—"}</TableCell>
                        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                          <Button size="icon" variant="ghost" className="size-8" onClick={() => setDetailId(m.id)} title={t(locale, "view")} aria-label={t(locale, "view")}>
                            <Eye className="size-4" />
                          </Button>
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

      {/* Detail sheet */}
      <Sheet open={!!detailId} onOpenChange={(o) => !o && setDetailId(null)}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto custom-scroll">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Layers className="size-5" />
              {t(locale, "crm-movement-details")}
            </SheetTitle>
            <SheetDescription>{detail ? fmtDateTime(detail.created_at) : ""}</SheetDescription>
          </SheetHeader>
          {detail ? (
            <div className="px-4 pb-6">
              <div className="mb-4">
                <span
                  className={`inline-flex items-center gap-1.5 text-2xl font-semibold tabular ${detail.delta > 0 ? "text-emerald-600" : detail.delta < 0 ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {detail.delta > 0 ? <ArrowUp className="size-5" /> : detail.delta < 0 ? <ArrowDown className="size-5" /> : null}
                  {detail.delta > 0 ? "+" : ""}{fmtNumber(detail.delta)}
                </span>
                <p className="text-xs text-muted-foreground mt-1">
                  {detail.delta > 0 ? t(locale, "crm-inbound") : detail.delta < 0 ? t(locale, "crm-outbound") : t(locale, "crm-no-change")}
                </p>
              </div>

              <div className="space-y-2">
                <DetailRow label={t(locale, "crm-partner")} value={partnerName(detail.partner_id)} />
                <DetailRow label={t(locale, "crm-product")} value={productName(detail.product_id)} />
                <DetailRow label={t(locale, "crm-reason")} value={detail.reason || "—"} />
                <DetailRow label={t(locale, "crm-reference")} value={detail.reference || "—"} mono />
                <DetailRow label={t(locale, "date")} value={fmtDateTime(detail.created_at)} />
              </div>

              <div className="mt-4 pt-4 border-t">
                <Badge variant="outline" className="gap-1">
                  <Activity className="size-3" /> {t(locale, "crm-read-only")}
                </Badge>
                <p className="text-xs text-muted-foreground mt-2">
                  {t(locale, "crm-movements-auto-desc")}
                </p>
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ---- Detail row helper ----

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 p-2 rounded-md hover:bg-muted/30">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span className={`text-sm text-right break-words ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
    </div>
  );
}
