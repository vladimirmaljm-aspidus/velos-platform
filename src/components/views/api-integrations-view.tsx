"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Database,
  Truck,
  Newspaper,
  Settings,
  Zap,
  CheckCircle2,
  XCircle,
  Loader2,
  Search,
  Plane,
  Ship,
  Train,
  TruckIcon,
  ArrowRight,
  MapPin,
  Clock,
  Package,
  TrendingUp,
  TrendingDown,
  Minus,
  ExternalLink,
  AlertCircle,
  FileText,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { useI18nStore, useT } from "@/lib/i18n/store";
import { fmtRelative, fmtDateTime } from "@/lib/utils/format";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useDebounced } from "@/lib/hooks/use-debounced";

/* ─── Types ───────────────────────────────────────────────────────────────── */

interface HSCategory {
  code: string;
  description: string;
  dutyRate: string;
  vatRate: string;
  restrictions?: string[];
  region: string;
}

interface CustomsResponse {
  hsCodes: HSCategory[];
  regulations?: CustomsRegulation[];
  totalCodes?: number;
  tariffInfo?: any;
  source?: string;
}

interface CustomsRegulation {
  id: string;
  title: string;
  titleSr: string;
  country: string;
  effectiveDate: string;
  type: "tariff" | "quota" | "sanction" | "preferential" | "documentation";
  impact: "high" | "medium" | "low";
  description: string;
}

interface ShipmentEvent {
  timestamp: string;
  location: string;
  description: string;
  type: "departure" | "arrival" | "customs" | "transit" | "delay";
}

interface Shipment {
  id: string;
  trackingNumber: string;
  status: "in_transit" | "customs" | "delivered" | "loading" | "delayed";
  origin: string;
  destination: string;
  carrier: string;
  mode: "sea" | "air" | "road" | "rail";
  eta: string;
  departureDate: string;
  currentLocation: string;
  progress: number;
  containers: string[];
  weight: string;
  value: string;
  customsStatus: "cleared" | "pending" | "inspection" | "held";
  lastUpdate: string;
  events: ShipmentEvent[];
}

interface LogisticsResponse {
  shipments: Shipment[];
  total: number;
  summary: Record<string, number>;
}

interface MarketArticle {
  id: string;
  title: string;
  summary: string;
  source: string;
  category: "commodities" | "currency" | "regulations" | "logistics" | "macro";
  timestamp: string;
  impact: "positive" | "negative" | "neutral";
  relevantTo: string[];
}

interface CommodityPrice {
  name: string;
  price: number;
  unit: string;
  change: number;
  trend: "up" | "down";
}

interface CurrencyRate {
  from: string;
  to: string;
  rate: number;
  change: number;
}

interface MarketNewsResponse {
  articles?: MarketArticle[];
  commodities: CommodityPrice[];
  currencies: CurrencyRate[];
  lastUpdated: string;
  source: string;
}

/* ─── Integration config ──────────────────────────────────────────────────── */

interface IntegrationInfo {
  id: string;
  icon: React.ReactNode;
  nameKey: string;
  descKey: string;
  endpoint: string;
  connected: boolean;
  lastSync: string;
}

const INTEGRATIONS: IntegrationInfo[] = [
  {
    id: "customs",
    icon: <Database className="size-5" />,
    nameKey: "api-customs",
    descKey: "api-customs-desc",
    endpoint: "/api/customs",
    connected: true,
    lastSync: new Date(Date.now() - 15 * 60000).toISOString(),
  },
  {
    id: "logistics",
    icon: <Truck className="size-5" />,
    nameKey: "api-logistics",
    descKey: "api-logistics-desc",
    endpoint: "/api/logistics",
    connected: true,
    lastSync: new Date(Date.now() - 5 * 60000).toISOString(),
  },
  {
    id: "market-news",
    icon: <Newspaper className="size-5" />,
    nameKey: "api-market-news",
    descKey: "api-market-desc",
    endpoint: "/api/market-news",
    connected: true,
    lastSync: new Date(Date.now() - 30 * 60000).toISOString(),
  },
];

/* ─── Helper functions ────────────────────────────────────────────────────── */

function statusColor(status: Shipment["status"]): string {
  switch (status) {
    case "in_transit":
      return "bg-blue-600 text-white";
    case "customs":
      return "bg-amber-600 text-white";
    case "delivered":
      return "bg-emerald-600 text-white";
    case "loading":
      return "bg-[var(--chart-3)] text-white";
    case "delayed":
      return "bg-destructive text-destructive-foreground";
    default:
      return "bg-secondary text-secondary-foreground";
  }
}

function customsStatusColor(cs: Shipment["customsStatus"]): string {
  switch (cs) {
    case "cleared":
      return "bg-emerald-600 text-white";
    case "pending":
      return "bg-amber-600 text-white";
    case "inspection":
      return "bg-orange-600 text-white";
    case "held":
      return "bg-destructive text-destructive-foreground";
    default:
      return "bg-secondary text-secondary-foreground";
  }
}

function modeIcon(mode: Shipment["mode"]) {
  switch (mode) {
    case "sea":
      return <Ship className="size-4" />;
    case "air":
      return <Plane className="size-4" />;
    case "road":
      return <TruckIcon className="size-4" />;
    case "rail":
      return <Train className="size-4" />;
  }
}

function impactBadge(impact: "positive" | "negative" | "neutral") {
  switch (impact) {
    case "positive":
      return (
        <Badge className="bg-emerald-600 text-white gap-1">
          <TrendingUp className="size-3" /> Positive
        </Badge>
      );
    case "negative":
      return (
        <Badge className="bg-destructive text-destructive-foreground gap-1">
          <TrendingDown className="size-3" /> Negative
        </Badge>
      );
    case "neutral":
      return (
        <Badge variant="secondary" className="gap-1">
          <Minus className="size-3" /> Neutral
        </Badge>
      );
  }
}

function regulationTypeBadge(type: CustomsRegulation["type"]) {
  const colors: Record<string, string> = {
    tariff: "bg-[var(--chart-1)] text-white",
    quota: "bg-[var(--chart-2)] text-white",
    sanction: "bg-destructive text-destructive-foreground",
    preferential: "bg-emerald-600 text-white",
    documentation: "bg-[var(--chart-3)] text-black",
  };
  return (
    <Badge className={`${colors[type] || "bg-secondary text-secondary-foreground"} text-xs`}>
      {type.charAt(0).toUpperCase() + type.slice(1)}
    </Badge>
  );
}

function impactLevelBadge(impact: "high" | "medium" | "low") {
  switch (impact) {
    case "high":
      return <Badge className="bg-destructive text-destructive-foreground">High</Badge>;
    case "medium":
      return <Badge className="bg-amber-600 text-white">Medium</Badge>;
    case "low":
      return <Badge className="bg-emerald-600 text-white">Low</Badge>;
  }
}

/* ─── Main Component ──────────────────────────────────────────────────────── */

export function ApiIntegrationsView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const { locale } = useI18nStore();
  const t = useT();

  const [testingId, setTestingId] = useState<string | null>(null);
  const [configIntg, setConfigIntg] = useState<IntegrationInfo | null>(null);
  const [apiKey, setApiKey] = useState("");

  // ── Data Queries ────────────────────────────────────────────────────────
  const customsQuery = useQuery<CustomsResponse>({
    queryKey: ["customs", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/customs"));
      if (!r.ok) throw new Error("Failed to fetch customs data");
      return r.json();
    },
  });

  const logisticsQuery = useQuery<LogisticsResponse>({
    queryKey: ["logistics", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/logistics"));
      if (!r.ok) throw new Error("Failed to fetch logistics data");
      return r.json();
    },
  });

  const marketQuery = useQuery<MarketNewsResponse>({
    queryKey: ["market-news", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/market-news"));
      if (!r.ok) throw new Error("Failed to fetch market news");
      return r.json();
    },
  });

  // ── Test Connection ─────────────────────────────────────────────────────
  const testConnection = async (integration: IntegrationInfo) => {
    setTestingId(integration.id);
    try {
      const start = Date.now();
      const r = await fetch(integration.endpoint);
      const latency = Date.now() - start;
      if (r.ok) {
        toast.success(
          `${t(integration.nameKey)}: Connection successful (${latency}ms)`,
          { description: `Endpoint: ${integration.endpoint}` }
        );
      } else {
        toast.error(`${t(integration.nameKey)}: Connection failed`, {
          description: `HTTP ${r.status}`,
        });
      }
    } catch {
      toast.error(`${t(integration.nameKey)}: Connection failed`, {
        description: "Network error",
      });
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div className="animate-fade-in">
      <PageHeader
        title={t("api-integrations")}
        description="Manage external API connections for customs, logistics, and market data"
      />

      {/* ── Integration Status Cards ──────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {INTEGRATIONS.map((intg) => (
          <Card
            key={intg.id}
            className="border-border/60 shadow-soft hover:shadow-soft-md transition-shadow"
          >
            <CardContent className="p-6">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="flex items-center justify-center size-10 rounded-lg bg-primary/10 text-primary">
                    {intg.icon}
                  </div>
                  <div>
                    <p className="font-semibold text-sm">{t(intg.nameKey)}</p>
                    <div className="flex items-center gap-1.5 mt-1">
                      {intg.connected ? (
                        <Badge className="bg-emerald-600 text-white gap-1 text-xs">
                          <CheckCircle2 className="size-3" />
                          {t("api-connected")}
                        </Badge>
                      ) : (
                        <Badge variant="destructive" className="gap-1 text-xs">
                          <XCircle className="size-3" />
                          {t("api-disconnected")}
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <p className="text-xs text-muted-foreground leading-relaxed mb-4">
                {t(intg.descKey)}
              </p>

              <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-4">
                <Clock className="size-3" />
                <span>{t("api-last-sync")}:</span>
                <span className="text-foreground">{fmtRelative(intg.lastSync)}</span>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  onClick={() => { setConfigIntg(intg); setApiKey(""); }}
                >
                  <Settings className="size-3.5 mr-1" />
                  {t("api-configure")}
                </Button>
                <Button
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => testConnection(intg)}
                  disabled={testingId === intg.id}
                >
                  {testingId === intg.id ? (
                    <Loader2 className="size-3.5 mr-1 animate-spin" />
                  ) : (
                    <Zap className="size-3.5 mr-1" />
                  )}
                  {t("api-test")}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Tabbed Content Area ───────────────────────────────────────────── */}
      <Tabs defaultValue="customs" className="space-y-4">
        <TabsList>
          <TabsTrigger value="customs" className="gap-1.5">
            <Database className="size-4" />
            <span className="hidden sm:inline">{t("api-customs")}</span>
          </TabsTrigger>
          <TabsTrigger value="logistics" className="gap-1.5">
            <Truck className="size-4" />
            <span className="hidden sm:inline">{t("api-logistics")}</span>
          </TabsTrigger>
          <TabsTrigger value="market-news" className="gap-1.5">
            <Newspaper className="size-4" />
            <span className="hidden sm:inline">{t("api-market-news")}</span>
          </TabsTrigger>
        </TabsList>

        {/* ── Customs Tab ─────────────────────────────────────────────────── */}
        <TabsContent value="customs">
          <CustomsTab query={customsQuery} locale={locale} />
        </TabsContent>

        {/* ── Logistics Tab ───────────────────────────────────────────────── */}
        <TabsContent value="logistics">
          <LogisticsTab query={logisticsQuery} />
        </TabsContent>

        {/* ── Market News Tab ─────────────────────────────────────────────── */}
        <TabsContent value="market-news">
          <MarketNewsTab query={marketQuery} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ─── Customs Tab ──────────────────────────────────────────────────────────── */

function CustomsTab({
  query,
  locale,
}: {
  query: ReturnType<typeof useQuery<CustomsResponse>>;
  locale: string;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search, 300);
  const [regionFilter, setRegionFilter] = useState<string>("all");

  const { data, isLoading, error, refetch } = useQuery<CustomsResponse>({
    queryKey: ["customs", tenantKey, debouncedSearch, regionFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("q", debouncedSearch);
      if (regionFilter !== "all") params.set("region", regionFilter);
      params.set("type", "hs");
      const r = await fetch(api(`/api/customs?${params.toString()}`));
      if (!r.ok) throw new Error("Failed to fetch customs data");
      return r.json();
    },
  });

  const regulationsQuery = useQuery<CustomsResponse>({
    queryKey: ["customs-regulations", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/customs?type=regulations"));
      if (!r.ok) throw new Error("Failed to fetch regulations");
      return r.json();
    },
  });

  if (error) {
    return (
      <Card className="border-border/60 shadow-soft">
        <CardContent className="p-6 text-center">
          <AlertCircle className="size-8 text-destructive mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">Failed to load customs data</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const hsCodes = data?.hsCodes || [];
  const regulations = regulationsQuery.data?.regulations || [];

  // Extract unique regions
  const allHsCodes = query.data?.hsCodes || [];
  const regions = [...new Set(allHsCodes.map((h) => h.region))];

  return (
    <div className="space-y-4">
      {/* HS Codes Section */}
      <Card className="border-border/60 shadow-soft">
        <CardHeader className="pb-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="size-4 text-primary" />
                HS Code Database
              </CardTitle>
              <CardDescription className="text-xs mt-1">
                {hsCodes.length} HS code{hsCodes.length !== 1 ? "s" : ""} found
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search HS code or description..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-8 pl-8 text-xs w-[220px]"
                />
              </div>
              <Select value={regionFilter} onValueChange={setRegionFilter}>
                <SelectTrigger className="h-8 text-xs w-[120px]">
                  <SelectValue placeholder="Region" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Regions</SelectItem>
                  {regions.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <ScrollArea className="max-h-[460px]">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    <TableHead className="text-xs">Code</TableHead>
                    <TableHead className="text-xs">Description</TableHead>
                    <TableHead className="text-xs text-center">Duty Rate</TableHead>
                    <TableHead className="text-xs text-center">VAT</TableHead>
                    <TableHead className="text-xs hidden md:table-cell">Restrictions</TableHead>
                    <TableHead className="text-xs text-center">Region</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {hsCodes.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground text-xs py-8">
                        No HS codes found matching your search
                      </TableCell>
                    </TableRow>
                  ) : (
                    hsCodes.map((hs) => (
                      <TableRow key={hs.code}>
                        <TableCell className="font-mono text-xs font-medium">
                          {hs.code}
                        </TableCell>
                        <TableCell className="text-xs max-w-[260px]">
                          {hs.description}
                        </TableCell>
                        <TableCell className="text-xs text-center tabular">
                          <Badge variant="outline" className="font-mono text-xs">
                            {hs.dutyRate}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-center tabular">
                          <Badge variant="outline" className="font-mono text-xs">
                            {hs.vatRate}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs hidden md:table-cell">
                          <div className="flex flex-wrap gap-1 max-w-[220px]">
                            {(hs.restrictions || []).map((r, i) => (
                              <Badge
                                key={i}
                                variant="secondary"
                                className="text-xs leading-tight"
                              >
                                {r}
                              </Badge>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-center">
                          <Badge className="bg-[var(--chart-1)] text-white text-xs">
                            {hs.region}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* Regulations Section */}
      <Card className="border-border/60 shadow-soft">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="size-4 text-primary" />
            Active Regulations
          </CardTitle>
          <CardDescription className="text-xs">
            {regulations.length} regulation{regulations.length !== 1 ? "s" : ""} tracked
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {regulationsQuery.isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : (
            <ScrollArea className="max-h-[320px]">
              <div className="divide-y divide-border/60">
                {regulations.map((reg) => (
                  <div key={reg.id} className="p-4 hover:bg-muted/30 transition-colors">
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">
                          {reg.title}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                          {reg.description}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {regulationTypeBadge(reg.type)}
                        {impactLevelBadge(reg.impact)}
                      </div>
                    </div>
                    <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                      <span>{reg.country}</span>
                      <span>Effective: {fmtDateTime(reg.effectiveDate)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ─── Logistics Tab ────────────────────────────────────────────────────────── */

function LogisticsTab({
  query,
}: {
  query: ReturnType<typeof useQuery<LogisticsResponse>>;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const [statusFilter, setStatusFilter] = useState<string>("all");

  const { data, isLoading, refetch } = useQuery<LogisticsResponse>({
    queryKey: ["logistics", tenantKey, statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      const r = await fetch(api(`/api/logistics?${params.toString()}`));
      if (!r.ok) throw new Error("Failed to fetch logistics data");
      return r.json();
    },
  });

  const shipments = data?.shipments || [];
  const summary = data?.summary || {};

  return (
    <div className="space-y-4">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: "In Transit", value: summary.in_transit || 0, color: "bg-blue-600" },
          { label: "Customs", value: summary.customs || 0, color: "bg-amber-600" },
          { label: "Delivered", value: summary.delivered || 0, color: "bg-emerald-600" },
          { label: "Loading", value: summary.loading || 0, color: "bg-[var(--chart-3)]" },
          { label: "Delayed", value: summary.delayed || 0, color: "bg-destructive" },
        ].map((s) => (
          <Card key={s.label} className="border-border/60 shadow-soft">
            <CardContent className="p-3 text-center">
              <div className={`inline-flex items-center justify-center size-7 rounded-full ${s.color} text-white text-xs font-bold mb-1`}>
                {s.value}
              </div>
              <p className="text-xs text-muted-foreground">{s.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filter */}
      <div className="flex items-center gap-2">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-8 text-xs w-[150px]">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="in_transit">In Transit</SelectItem>
            <SelectItem value="customs">Customs</SelectItem>
            <SelectItem value="delivered">Delivered</SelectItem>
            <SelectItem value="loading">Loading</SelectItem>
            <SelectItem value="delayed">Delayed</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-xs"
          onClick={() => refetch()}
        >
          Refresh
        </Button>
      </div>

      {/* Shipment Cards */}
      {isLoading ? (
        <div className="grid gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-52 w-full" />
          ))}
        </div>
      ) : shipments.length === 0 ? (
        <Card className="border-border/60 shadow-soft">
          <CardContent className="p-8 text-center">
            <Package className="size-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No shipments found</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 max-h-[calc(100vh-420px)] overflow-y-auto custom-scroll pr-1">
          {shipments.map((sh) => (
            <ShipmentCard key={sh.id} shipment={sh} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Shipment Card ────────────────────────────────────────────────────────── */

function ShipmentCard({ shipment }: { shipment: Shipment }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card className="border-border/60 shadow-soft hover:shadow-soft-md transition-shadow">
      <CardContent className="p-4">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center size-8 rounded-md bg-primary/10 text-primary">
              {modeIcon(shipment.mode)}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <p className="font-semibold text-sm font-mono">{shipment.trackingNumber}</p>
                <Badge className={`${statusColor(shipment.status)} text-xs`}>
                  {shipment.status.replace("_", " ")}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">{shipment.carrier}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge className={`${customsStatusColor(shipment.customsStatus)} text-xs`}>
              Customs: {shipment.customsStatus}
            </Badge>
          </div>
        </div>

        {/* Route */}
        <div className="flex items-center gap-2 mb-3 text-sm">
          <span className="font-medium truncate max-w-[140px]" title={shipment.origin}>
            {shipment.origin}
          </span>
          <ArrowRight className="size-4 text-muted-foreground shrink-0" />
          <span className="font-medium truncate max-w-[140px]" title={shipment.destination}>
            {shipment.destination}
          </span>
        </div>

        {/* Progress */}
        <div className="mb-3">
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
            <span>Progress</span>
            <span className="tabular">{shipment.progress}%</span>
          </div>
          <Progress value={shipment.progress} className="h-2" />
        </div>

        {/* Details */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground mb-3">
          <div className="flex items-center gap-1.5">
            <MapPin className="size-3" />
            <span>{shipment.currentLocation}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Clock className="size-3" />
            <span>ETA: {fmtDateTime(shipment.eta)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Package className="size-3" />
            <span>{shipment.weight}</span>
          </div>
          <span className="font-medium text-foreground">{shipment.value}</span>
        </div>

        {/* Containers */}
        {shipment.containers.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-3">
            {shipment.containers.map((c) => (
              <Badge key={c} variant="outline" className="text-xs font-mono">
                {c}
              </Badge>
            ))}
          </div>
        )}

        {/* Timeline toggle */}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs w-full"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Hide" : "Show"} Timeline ({shipment.events.length} events)
        </Button>

        {/* Timeline */}
        {expanded && (
          <div className="mt-3 pt-3 border-t border-border/60 space-y-2">
            {shipment.events.map((ev, idx) => (
              <div key={idx} className="flex items-start gap-3 text-xs">
                <div className="flex flex-col items-center">
                  <div
                    className={`size-2 rounded-full mt-1 shrink-0 ${
                      ev.type === "delay"
                        ? "bg-destructive"
                        : ev.type === "customs"
                        ? "bg-amber-600"
                        : ev.type === "arrival"
                        ? "bg-emerald-600"
                        : "bg-primary"
                    }`}
                  />
                  {idx < shipment.events.length - 1 && (
                    <div className="w-px h-4 bg-border/60" />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-foreground">{ev.description}</p>
                  <p className="text-muted-foreground">
                    {ev.location} &middot; {fmtRelative(ev.timestamp)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ─── Market News Tab ──────────────────────────────────────────────────────── */

function MarketNewsTab({
  query,
}: {
  query: ReturnType<typeof useQuery<MarketNewsResponse>>;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const { data, isLoading, error, refetch } = query;

  if (error) {
    return (
      <Card className="border-border/60 shadow-soft">
        <CardContent className="p-6 text-center">
          <AlertCircle className="size-8 text-destructive mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">Failed to load market data</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const commodities = data?.commodities || [];
  const currencies = data?.currencies || [];
  const articles = data?.articles || [];

  return (
    <div className="space-y-4">
      {/* Commodity Prices + Currency Rates */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Commodity Prices */}
        <Card className="border-border/60 shadow-soft">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="size-4 text-primary" />
              Commodity Prices
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : (
              <ScrollArea className="max-h-[300px]">
                <Table>
                  <TableHeader className="sticky top-0 bg-card z-10">
                    <TableRow>
                      <TableHead className="text-xs">Commodity</TableHead>
                      <TableHead className="text-xs text-right">Price</TableHead>
                      <TableHead className="text-xs text-right">Change</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {commodities.map((c) => (
                      <TableRow key={c.name}>
                        <TableCell className="text-xs font-medium">{c.name}</TableCell>
                        <TableCell className="text-xs text-right tabular">
                          {c.price.toLocaleString("en-US", {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}{" "}
                          <span className="text-muted-foreground">{c.unit}</span>
                        </TableCell>
                        <TableCell className="text-xs text-right tabular">
                          <span
                            className={`flex items-center justify-end gap-1 ${
                              c.change > 0
                                ? "text-emerald-600 dark:text-emerald-400"
                                : c.change < 0
                                ? "text-destructive"
                                : "text-muted-foreground"
                            }`}
                          >
                            {c.trend === "up" ? (
                              <TrendingUp className="size-3" />
                            ) : (
                              <TrendingDown className="size-3" />
                            )}
                            {c.change > 0 ? "+" : ""}
                            {c.change}%
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
            )}
          </CardContent>
        </Card>

        {/* Currency Rates */}
        <Card className="border-border/60 shadow-soft">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <ArrowRight className="size-4 text-primary" />
              Currency Rates
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : (
              <ScrollArea className="max-h-[300px]">
                <Table>
                  <TableHeader className="sticky top-0 bg-card z-10">
                    <TableRow>
                      <TableHead className="text-xs">Pair</TableHead>
                      <TableHead className="text-xs text-right">Rate</TableHead>
                      <TableHead className="text-xs text-right">Change</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {currencies.map((c) => (
                      <TableRow key={`${c.from}-${c.to}`}>
                        <TableCell className="text-xs font-medium">
                          <span className="font-mono">{c.from}</span>
                          <span className="text-muted-foreground mx-1">/</span>
                          <span className="font-mono">{c.to}</span>
                        </TableCell>
                        <TableCell className="text-xs text-right tabular font-mono">
                          {c.rate.toLocaleString("en-US", {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 4,
                          })}
                        </TableCell>
                        <TableCell className="text-xs text-right tabular">
                          <span
                            className={
                              c.change > 0
                                ? "text-emerald-600 dark:text-emerald-400"
                                : c.change < 0
                                ? "text-destructive"
                                : "text-muted-foreground"
                            }
                          >
                            {c.change > 0 ? "+" : ""}
                            {c.change.toFixed(2)}%
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>

      {/* News Articles */}
      <Card className="border-border/60 shadow-soft">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Newspaper className="size-4 text-primary" />
                Trade News & Analysis
              </CardTitle>
              <CardDescription className="text-xs mt-1">
                {articles.length} article{articles.length !== 1 ? "s" : ""} &middot; Last
                updated: {data?.lastUpdated ? fmtRelative(data.lastUpdated) : "—"}
              </CardDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              onClick={() => refetch()}
            >
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : articles.length > 0 ? (
            <ScrollArea className="max-h-[400px]">
              <div className="divide-y divide-border/60">
                {articles.map((article) => (
                  <div
                    key={article.id}
                    className="p-4 hover:bg-muted/30 transition-colors"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <Badge
                            variant="outline"
                            className="text-xs capitalize shrink-0"
                          >
                            {article.category}
                          </Badge>
                          {impactBadge(article.impact)}
                        </div>
                        <p className="text-sm font-medium leading-snug">
                          {article.title}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                          {article.summary}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <ExternalLink className="size-3" />
                        {article.source}
                      </span>
                      <span>{fmtRelative(article.timestamp)}</span>
                      <div className="flex gap-1">
                        {article.relevantTo.slice(0, 3).map((tag) => (
                          <Badge
                            key={tag}
                            variant="secondary"
                            className="text-xs"
                          >
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          ) : (
            <div className="p-8 text-center">
              <Newspaper className="size-8 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">No news articles available.</p>
              <p className="text-xs text-muted-foreground mt-1">Commodity prices and currency rates are shown above.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
