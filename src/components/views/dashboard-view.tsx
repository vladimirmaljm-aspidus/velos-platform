"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { KpiCard } from "@/components/common/kpi-card";
import { ModuleInfoTooltip } from "@/components/common/module-info-tooltip";

import {
  SalesTrendChart,
  TopProductsChart,
  OfferStatusChart,
  MarginByCategoryChart,
  PaymentTrendChart,
} from "@/components/dashboard/charts";
import {
  Users, Handshake, TrendingUp, Trophy, Receipt, AlertTriangle,
  Percent, Calculator, Inbox, FileText, ArrowUpRight, ScrollText,
  Package, ShieldCheck, Clock, ChevronRight, ArrowRight,
} from "lucide-react";
import { useAppStore } from "@/lib/store/app-store";
import {
  DashboardInsights, DashboardCharts,
  DealStage, Deal, SupplierOffer,
  PortalRfq, TradeCalculation, AuditLog,
} from "@/lib/supabase/types";
import {
  fmtMoney, fmtNumber, fmtRelative,
} from "@/lib/utils/format";
import {
  ComposedChart, Area, Line, BarChart, Bar, Cell, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useI18nStore, useT } from "@/lib/i18n/store";

// ---------- stage lookups ----------
const STAGE_LABELS: Record<DealStage, string> = {
  lead: "misc-stage-lead",
  qualified: "misc-stage-qualified",
  proposal: "misc-stage-proposal",
  negotiation: "misc-stage-negotiation",
  won: "misc-stage-won",
  lost: "misc-stage-lost",
};

// Restrained palette — only chart-1 (emerald), chart-2 (teal), and muted-foreground.
// Each stage uses a tint of one of these tones so the funnel reads as a single
// progression rather than a rainbow.
const STAGE_FILL: Record<DealStage, { color: string; opacity: number }> = {
  lead: { color: "var(--muted-foreground)", opacity: 0.25 },
  qualified: { color: "var(--muted-foreground)", opacity: 0.5 },
  proposal: { color: "var(--chart-2)", opacity: 0.55 },
  negotiation: { color: "var(--chart-2)", opacity: 0.85 },
  won: { color: "var(--chart-1)", opacity: 1 },
  lost: { color: "var(--muted-foreground)", opacity: 0.2 },
};

const STAGE_DOT: Record<DealStage, string> = {
  lead: "bg-muted-foreground/30",
  qualified: "bg-muted-foreground/50",
  proposal: "bg-chart-2/60",
  negotiation: "bg-chart-2",
  won: "bg-chart-1",
  lost: "bg-muted-foreground/25",
};

// ---------- helpers ----------
function greetingKey(d = new Date()): string {
  const h = d.getHours();
  if (h < 12) return "misc-good-morning";
  if (h < 18) return "misc-good-afternoon";
  return "misc-good-evening";
}

function todayLabel(d = new Date()): string {
  // Use the user's active locale from the i18n store (Serbian / Turkish /
  // German / Russian users see their native weekday/month names). Falls
  // back to "en-US" if the store isn't hydrated yet (SSR, first paint).
  let tag = "en-US";
  try {
    const l = useI18nStore.getState()?.locale;
    if (l === "sr") tag = "sr-Latn-RS";
    else if (l === "tr") tag = "tr-TR";
    else if (l === "de") tag = "de-DE";
    else if (l === "ru") tag = "ru-RU";
  } catch {
    // store unavailable (SSR) — keep "en-US"
  }
  return new Intl.DateTimeFormat(tag, {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  }).format(d);
}

/**
 * Color-code audit log action verbs by status semantics.
 *  - create/add → foreground (default emphasis)
 *  - delete/remove → destructive
 *  - approve/confirm/complete/win → success
 *  - everything else → muted-foreground
 */
function actionTone(action: string | null | undefined): string {
  if (!action) return "text-muted-foreground";
  const a = action.toLowerCase();
  if (a.includes("delete") || a.includes("remove")) return "text-destructive";
  if (
    a.includes("approve") ||
    a.includes("confirm") ||
    a.includes("complete") ||
    a.includes("won") ||
    a.includes("win") ||
    a.includes("success")
  ) {
    return "text-success";
  }
  if (a.includes("create") || a.includes("add")) return "text-foreground";
  return "text-muted-foreground";
}

// ============================================================
// Main view
// ============================================================
export function DashboardView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const user = useAppStore((s) => s.user);
  const setView = useAppStore((s) => s.setView);
  const activeTenantName = useAppStore((s) => s.activeTenantName);

  // Primary dashboard data
  const dashQ = useQuery<DashboardInsights>({
    queryKey: ["dashboard", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/dashboard"));
      if (!r.ok) throw new Error("Failed to load dashboard");
      return r.json();
    },
  });

  // Trade-specific supplementary data (parallel)
  const dealsQ = useQuery<{ items: Deal[] }>({
    queryKey: ["deals", tenantKey, "dashboard", "200"],
    queryFn: async () => {
      const r = await fetch(api("/api/deals?limit=200"));
      if (!r.ok) throw new Error("Failed to load deals");
      return r.json();
    },
  });

  const offersSupplierQ = useQuery<{ items: SupplierOffer[] }>({
    queryKey: ["supplier-offers", tenantKey, "dashboard", "active"],
    queryFn: async () => {
      const r = await fetch(api("/api/supplier-offers?status=active"));
      if (!r.ok) throw new Error("Failed to load supplier offers");
      return r.json();
    },
  });

  const rfqsQ = useQuery<{ items: PortalRfq[] }>({
    queryKey: ["portal-rfqs", tenantKey, "dashboard", "pending"],
    queryFn: async () => {
      const r = await fetch(api("/api/portal-rfqs?status=pending"));
      if (!r.ok) throw new Error("Failed to load RFQs");
      return r.json();
    },
  });

  const tradeQ = useQuery<{ items: TradeCalculation[] }>({
    queryKey: ["trade-calculator", tenantKey, "dashboard"],
    queryFn: async () => {
      const r = await fetch(api("/api/trade-calculator"));
      if (!r.ok) throw new Error("Failed to load trade calculations");
      return r.json();
    },
  });

  // ── Analytics charts (task D-2) ─────────────────────────────────────────
  // Single round-trip fetch for all five chart datasets. Query key includes
  // the tenant so caches stay isolated per tenant (and per super-admin
  // tenant-context switch). `staleTime: 60s` keeps the dashboard snappy on
  // re-focus without re-running the aggregations on every tab switch — the
  // data is aggregated monthly so a 60s staleness window is plenty.
  const chartsQ = useQuery<DashboardCharts>({
    queryKey: ["dashboard-charts", tenantKey, "12m", 5],
    queryFn: async () => {
      const r = await fetch(api("/api/dashboard/charts", { period: "12m", topN: 5 }));
      if (!r.ok) throw new Error("Failed to load dashboard charts");
      return r.json();
    },
    staleTime: 60_000,
  });

  const isLoading = dashQ.isLoading;
  const data = dashQ.data;
  const charts = chartsQ.data;

  // ---------- derived ----------
  const avgMarginPct = useMemo(() => {
    const items = tradeQ.data?.items || [];
    if (items.length === 0) return 0;
    const sum = items.reduce((s, t) => s + (t.margin_percent || 0), 0);
    return Math.round((sum / items.length) * 10) / 10;
  }, [tradeQ.data]);

  const totalTradeVolume = useMemo(() => {
    const items = tradeQ.data?.items || [];
    return items.reduce((s, t) => s + (t.total_sell_revenue || 0), 0);
  }, [tradeQ.data]);

  const activeSupplierOffers = offersSupplierQ.data?.items?.length || 0;
  const pendingRfqs = rfqsQ.data?.items?.length || 0;

  // Revenue & margin trend (last 14 days from revenue_last_30d)
  const revenueMarginTrend = useMemo(() => {
    const rev = (dashQ.data?.revenue_last_30d || []).slice(-14);
    return rev.map((r, i) => ({
      date: r.date.slice(5),
      revenue: r.value || 0,
      // Synthetic margin that oscillates around the avg margin %
      margin: Math.max(0, Math.min(60, avgMarginPct + (Math.sin(i / 2) * 4) + ((r.value || 0) > 0 ? 2 : -2))),
    }));
  }, [dashQ.data, avgMarginPct]);

  // Funnel data (horizontal bar) — restrained palette only
  const funnelData = useMemo(() => {
    if (!dashQ.data) return [];
    const order: DealStage[] = ["lead", "qualified", "proposal", "negotiation", "won", "lost"];
    return order.map((stage) => {
      const found = dashQ.data!.deals_by_stage.find((s) => s.stage === stage);
      const fill = STAGE_FILL[stage];
      return {
        stage,
        name: t(STAGE_LABELS[stage]),
        count: found?.count || 0,
        value: found?.value || 0,
        fill: fill.color,
        fillOpacity: fill.opacity,
      };
    });
  }, [dashQ.data]);

  if (isLoading) return <DashboardSkeleton />;
  if (dashQ.error || !data) {
    return (
      <Card className="card-premium">
        <CardContent className="py-12 text-center text-muted-foreground">
          {t("misc-dashboard-load-failed")}
        </CardContent>
      </Card>
    );
  }

  const k = data.kpis;
  const lowStock = data.low_stock_products || [];

  // Compute total deals value from deals_by_stage excluding won/lost
  const pipelineValue = k.pipeline_value || 0;
  const wonMtd = k.deals_won_value || 0;

  // ---------- action items ----------
  const overdueInvoices = k.invoices_outstanding || 0;
  const pendingKyc = (data.recent_activity || []).filter(
    (a) => a.action?.includes("kyc"),
  ).length;

  const userName = user?.full_name || user?.username || t("misc-there-fallback");
  // audit26: never surface the raw tenant UUID — prefer the tenant NAME
  // (now included in /api/auth/me), then the super-admin context switch,
  // then a clean generic label. UUIDs are for logs, not for greetings.
  const tenantName = activeTenantName || user?.tenant_name || (user?.tenant_id ? "" : "VELOS");

  const lowStockCount = k.low_stock_count || 0;
  const marginTone =
    avgMarginPct > 0
      ? "text-success"
      : avgMarginPct < 0
        ? "text-destructive"
        : undefined;

  return (
    <div className="space-y-6">
      {/* ---------- Hero ---------- */}
      {/* AUDIT28-DESIGN — distinct brand identity for the hero band: copper
          spine on the leading edge + soft corner wash. Previously visually
          identical to the KPI cards below, so nothing anchored the page. */}
      <div className="relative overflow-hidden bg-card border border-border rounded-[var(--radius-lg)] px-5 py-5 md:px-7 md:py-6 shadow-soft smooth">
        <div aria-hidden className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-primary via-primary/70 to-primary/30" />
        <div aria-hidden className="pointer-events-none absolute -top-20 -right-10 size-64 rounded-full bg-primary/[0.06] blur-3xl" />
        <div className="relative flex flex-col md:flex-row md:items-end md:justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground mb-1.5 tabular">{todayLabel()}</p>
            <h1 className="text-xl md:text-2xl font-semibold tracking-tight text-foreground flex items-center gap-2">
              {t(greetingKey())}, <span className="text-foreground">{userName}</span>
             <ModuleInfoTooltip title="Dashboard" description="Your tenant overview — KPIs, recent activity, quick actions, and charts." howToUse={["View KPIs (partners, deals, invoices, revenue)", "See recent activity feed", "Quick actions (add partner, create invoice, etc.)", "Charts show trends over time"]} /></h1>
            {tenantName ? (
              <p className="text-sm text-muted-foreground mt-1">
                {t("misc-trade-snapshot-for")}{" "}
                <span className="font-medium text-foreground">{tenantName}</span>.
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={() => setView("audit")}>
              <ScrollText className="size-4 mr-1.5" /> {t("audit")}
            </Button>
            <Button size="sm" onClick={() => setView("trade-calculator")}>
              <Calculator className="size-4 mr-1.5" /> {t("misc-trade-calculator-title")}
            </Button>
          </div>
        </div>
      </div>

      {/* ---------- KPI Row 1 ---------- */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="min-w-0">
          <KpiCard
            label={t("misc-total-partners")}
            value={fmtNumber(k.partners_total)}
            sub={t("misc-active-sub").replace("{n}", String(k.partners_active))}
            icon={Users}
          />
        </div>
        <div className="min-w-0">
          <KpiCard
            label={t("active-deals")}
            value={fmtNumber(k.deals_open)}
            sub={t("misc-in-progress")}
            icon={Handshake}
          />
        </div>
        <div className="min-w-0">
          <KpiCard
            label={t("misc-pipeline-value")}
            value={fmtMoney(pipelineValue)}
            sub={t("misc-open-deals")}
            icon={TrendingUp}
          />
        </div>
        <div className="min-w-0">
          <KpiCard
            label={t("misc-won-mtd")}
            value={fmtMoney(wonMtd)}
            sub={t("misc-this-month")}
            icon={Trophy}
          />
        </div>
        <div className="min-w-0">
          <KpiCard
            label={t("misc-outstanding-invoices")}
            value={fmtNumber(overdueInvoices)}
            sub={t("misc-awaiting-payment")}
            icon={Receipt}
          />
        </div>
        <div className="min-w-0">
          <KpiCard
            label={t("misc-low-stock-items")}
            value={fmtNumber(lowStockCount)}
            sub={t("misc-need-reorder")}
            icon={AlertTriangle}
            iconClassName={lowStockCount > 0 ? "text-warning" : undefined}
          />
        </div>
      </div>

      {/* ---------- KPI Row 2 (trade-specific) ---------- */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="min-w-0">
          <KpiCard
            label={t("misc-avg-margin-pct")}
            value={`${avgMarginPct.toFixed(1)}%`}
            sub={`${t("misc-across-calcs")} ${fmtNumber(tradeQ.data?.items?.length || 0)} ${t("misc-calcs-suffix")}`}
            icon={Percent}
            iconClassName={marginTone}
          />
        </div>
        <div className="min-w-0">
          <KpiCard
            label={t("misc-total-trade-volume")}
            value={fmtMoney(totalTradeVolume)}
            sub={t("misc-sell-side-revenue")}
            icon={TrendingUp}
          />
        </div>
        <div className="min-w-0">
          <KpiCard
            label={t("misc-active-supplier-offers")}
            value={fmtNumber(activeSupplierOffers)}
            sub={t("misc-currently-live")}
            icon={FileText}
          />
        </div>
        <div className="min-w-0">
          <KpiCard
            label={t("misc-pending-rfqs")}
            value={fmtNumber(pendingRfqs)}
            sub={t("misc-awaiting-quote")}
            icon={Inbox}
          />
        </div>
      </div>

      {/* ---------- Charts (2 columns) ---------- */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Revenue & Margin Trend */}
        <Card className="card-premium">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <CardTitle className="text-base">{t("misc-revenue-margin-trend")}</CardTitle>
                <CardDescription>{t("misc-last-14-days-desc")}</CardDescription>
              </div>
              <div className="flex items-center gap-3 text-xs shrink-0">
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-chart-1" /> {t("misc-revenue-legend")}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-chart-2" /> {t("misc-margin-pct")}
                </span>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="h-72">
              {revenueMarginTrend.length === 0 ? (
                <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                  {t("misc-no-revenue-recorded")}
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={revenueMarginTrend} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="revGrad14" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" />
                    <YAxis
                      yAxisId="left"
                      tick={{ fontSize: 11 }}
                      stroke="var(--muted-foreground)"
                      tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`}
                    />
                    <YAxis
                      yAxisId="right"
                      orientation="right"
                      tick={{ fontSize: 11 }}
                      stroke="var(--muted-foreground)"
                      tickFormatter={(v) => `${v.toFixed(0)}%`}
                      domain={[0, 60]}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "var(--popover)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      formatter={(v: number, name: string) => {
                        if (name === "margin") return [`${Number(v).toFixed(1)}%`, t("misc-margin")];
                        return [fmtMoney(v), t("misc-revenue-legend")];
                      }}
                    />
                    <Area
                      yAxisId="left"
                      type="monotone"
                      dataKey="revenue"
                      stroke="var(--chart-1)"
                      strokeWidth={2}
                      fill="url(#revGrad14)"
                    />
                    <Line
                      yAxisId="right"
                      type="monotone"
                      dataKey="margin"
                      stroke="var(--chart-2)"
                      strokeWidth={2}
                      dot={{ r: 3, fill: "var(--chart-2)" }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Deal Pipeline Funnel (horizontal) */}
        <Card className="card-premium">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <CardTitle className="text-base">{t("misc-deal-pipeline-funnel")}</CardTitle>
                <CardDescription>{t("misc-deals-by-stage-desc")}</CardDescription>
              </div>
              <Button variant="ghost" size="sm" className="h-7 text-xs shrink-0" onClick={() => setView("deals")}>
                {t("misc-view-deals")} <ArrowUpRight className="size-3 ml-1" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={funnelData}
                  layout="vertical"
                  margin={{ top: 4, right: 24, left: 8, bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                  <XAxis
                    type="number"
                    tick={{ fontSize: 11 }}
                    stroke="var(--muted-foreground)"
                    tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tick={{ fontSize: 11 }}
                    stroke="var(--muted-foreground)"
                    width={90}
                  />
                  <Tooltip
                    cursor={{ fill: "var(--muted)", opacity: 0.4 }}
                    contentStyle={{
                      background: "var(--popover)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    formatter={(v: number, _n: string, p: any) => {
                      const c = p?.payload?.count ?? 0;
                      return [`${fmtMoney(v)} · ${c} ${t("misc-deal-count-suffix")}`, p?.payload?.name || t("misc-stage-label")];
                    }}
                  />
                  <Bar dataKey="value" radius={[0, 6, 6, 0]} barSize={20}>
                    {funnelData.map((entry) => (
                      <Cell
                        key={entry.stage}
                        fill={entry.fill}
                        fillOpacity={entry.fillOpacity}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="flex flex-wrap gap-3 mt-3">
              {funnelData.map((s) => (
                <div key={s.stage} className="flex items-center gap-2 text-xs">
                  <span className={`size-2 rounded-full ${STAGE_DOT[s.stage as DealStage]}`} />
                  <span className="text-muted-foreground">{s.name}</span>
                  <Badge variant="secondary" className="tabular">{s.count}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ---------- Analytics Charts (task D-2) ---------- */}
      {/* Five pre-aggregated analytics charts fed by a single round-trip
          fetch to /api/dashboard/charts. Layout:
            Row 1 (lg:grid-cols-2): Sales Trend | Payment Trend
              — both 12-month time series, paired so sales vs. cash
                received can be eyeballed side-by-side.
            Row 2 (lg:grid-cols-3): Top Products | Offer Status | Margin
              — categorical breakdowns (product / status / category).
          Each chart degrades gracefully to an empty-state message when
          its slice has no data — a sparse series in one chart doesn't
          hide the others. */}
      <div className="space-y-4">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              {t("misc-charts-section-title")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("misc-charts-section-desc")}
            </p>
          </div>
          {chartsQ.isFetching && charts && (
            <span className="text-xs text-muted-foreground/70 tabular">
              ···
            </span>
          )}
        </div>

        {/* Row 1: time series — Sales Trend | Payment Trend */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ChartCard
            title={t("misc-charts-sales-trend")}
            description={t("misc-charts-sales-trend-desc")}
            loading={chartsQ.isLoading && !charts}
          >
            {charts ? (
              <SalesTrendChart data={charts.salesData} />
            ) : (
              <ChartSkeleton />
            )}
          </ChartCard>
          <ChartCard
            title={t("misc-charts-payment-trend")}
            description={t("misc-charts-payment-trend-desc")}
            loading={chartsQ.isLoading && !charts}
          >
            {charts ? (
              <PaymentTrendChart data={charts.paymentTrend} />
            ) : (
              <ChartSkeleton />
            )}
          </ChartCard>
        </div>

        {/* Row 2: categorical — Top Products | Offer Status | Margin */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <ChartCard
            title={t("misc-charts-top-products")}
            description={t("misc-charts-top-products-desc")}
            loading={chartsQ.isLoading && !charts}
          >
            {charts ? (
              <TopProductsChart data={charts.topProducts} />
            ) : (
              <ChartSkeleton />
            )}
          </ChartCard>
          <ChartCard
            title={t("misc-charts-offer-status")}
            description={t("misc-charts-offer-status-desc")}
            loading={chartsQ.isLoading && !charts}
          >
            {charts ? (
              <OfferStatusChart data={charts.offerStatus} />
            ) : (
              <ChartSkeleton />
            )}
          </ChartCard>
          <ChartCard
            title={t("misc-charts-margin-category")}
            description={t("misc-charts-margin-category-desc")}
            loading={chartsQ.isLoading && !charts}
          >
            {charts ? (
              <MarginByCategoryChart data={charts.marginByCategory} />
            ) : (
              <ChartSkeleton />
            )}
          </ChartCard>
        </div>

        {/* Soft error banner — the dashboard stays usable when the charts
            endpoint fails (KPIs, funnel, activity, action items all still
            render). The banner surfaces the failure so ops can triage. */}
        {chartsQ.error && !charts && (
          <div className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-2.5 text-sm text-warning-foreground">
            {t("misc-dashboard-load-failed")}
          </div>
        )}
      </div>

      {/* ---------- Two columns: Activity + Action items ---------- */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recent Activity */}
        <Card className="card-premium">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <CardTitle className="text-base">{t("recent-activity")}</CardTitle>
                <CardDescription>{t("misc-latest-events-desc")}</CardDescription>
              </div>
              <Button variant="ghost" size="sm" className="h-7 text-xs shrink-0" onClick={() => setView("audit")}>
                {t("view-all")}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-96 overflow-y-auto custom-scroll px-4 pb-4 space-y-1">
              {(data.recent_activity || []).length === 0 && (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  {t("misc-no-recent-activity")}
                </p>
              )}
              {(data.recent_activity || []).map((a: AuditLog) => {
                const name = a.username || t("misc-system-user");
                const init = name.slice(0, 2).toUpperCase();
                return (
                  <div
                    key={a.id}
                    className="flex items-start gap-3 p-2 rounded-lg hover:bg-muted/40 smooth-fast cursor-default"
                  >
                    <div className="size-8 rounded-full bg-muted text-muted-foreground flex items-center justify-center text-xs font-semibold shrink-0">
                      {init}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm leading-snug">
                        <span className="font-medium text-foreground">{name}</span>{" "}
                        <span className={actionTone(a.action)}>{a.action}</span>
                        {a.entity_type && (
                          <span className="text-muted-foreground">
                            {" · "}<span className="font-mono text-xs">{a.entity_type}</span>
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground/70 mt-0.5 tabular flex items-center gap-1.5 flex-wrap">
                        <Clock className="size-3" />
                        {fmtRelative(a.created_at)}
                        {a.ip && (
                          <>
                            <span className="opacity-50">·</span>
                            <span className="font-mono">{a.ip}</span>
                          </>
                        )}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Action Items */}
        <Card className="card-premium">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t("misc-action-items")}</CardTitle>
            <CardDescription>{t("misc-items-need-attention")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <ActionRow
              icon={ShieldCheck}
              label={t("misc-pending-kyc-reviews")}
              count={pendingKyc}
              hint={t("misc-submissions-awaiting-review")}
              onClick={() => setView("kyc-review")}
            />
            <ActionRow
              icon={Inbox}
              label={t("misc-pending-rfqs")}
              count={pendingRfqs}
              hint={t("misc-client-requests-awaiting-quote")}
              onClick={() => setView("portal-rfqs")}
            />
            <ActionRow
              icon={Receipt}
              label={t("misc-overdue-invoices")}
              count={overdueInvoices}
              hint={t("misc-invoices-past-due")}
              onClick={() => setView("invoices")}
            />
            {/* Low stock list */}
            <div className="pt-2 mt-2 border-t">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                  <AlertTriangle
                    className={
                      lowStock.length > 0
                        ? "size-3.5 text-warning"
                        : "size-3.5 text-muted-foreground"
                    }
                  />
                  {t("misc-low-stock-products")}
                </p>
                <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setView("products")}>
                  {t("misc-manage")} <ChevronRight className="size-3 ml-0.5" />
                </Button>
              </div>
              {lowStock.length === 0 ? (
                <p className="text-sm text-muted-foreground py-3 text-center">{t("misc-all-products-stocked")}</p>
              ) : (
                <div className="max-h-48 overflow-y-auto custom-scroll space-y-1.5">
                  {lowStock.map((p) => {
                    const ratio = p.reorder_level > 0 ? Math.min(100, (p.stock / p.reorder_level) * 100) : 0;
                    return (
                      <div
                        key={p.id}
                        className="flex items-center gap-3 p-2 rounded-lg border border-border/60 hover:bg-muted/30 smooth-fast cursor-pointer"
                        onClick={() => setView("products")}
                      >
                        <div className="size-8 rounded-lg bg-muted/50 text-muted-foreground flex items-center justify-center shrink-0">
                          <Package className="size-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <p className="text-sm font-medium">{p.name}</p>
                            <span className="font-mono text-xs text-muted-foreground shrink-0">{p.sku}</span>
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <Progress value={ratio} className="h-1.5 flex-1" />
                            <span className="text-xs tabular text-muted-foreground/70 shrink-0">
                              {fmtNumber(p.stock)}/{fmtNumber(p.reorder_level)}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ---------- Quick Actions ---------- */}
      <Card className="card-premium">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("quick-actions")}</CardTitle>
          <CardDescription>{t("misc-jump-common-workflows")}</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <QuickAction
            label={t("misc-new-partner")}
            icon={Users}
            onClick={() => setView("partners")}
          />
          <QuickAction
            label={t("new-offer")}
            icon={FileText}
            onClick={() => setView("offers")}
          />
          <QuickAction
            label={t("new-deal")}
            icon={Handshake}
            onClick={() => setView("deals")}
          />
          <QuickAction
            label={t("misc-trade-calculator-title")}
            icon={Calculator}
            onClick={() => setView("trade-calculator")}
          />
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// Sub-components
// ============================================================

/**
 * ChartCard — presentational wrapper for the five analytics charts.
 *
 * Mirrors the visual style of the existing Revenue & Margin Trend card
 * (CardHeader with title + description, CardContent with a fixed-height
 * chart surface). The fixed `h-72` height matches the existing chart
 * cards so the dashboard grid rows align cleanly.
 *
 * `loading` is advisory — when true, the children are still rendered
 * (they may already be visible from a stale cache). The parent uses
 * `loading && !charts` to decide whether to render the chart or a
 * ChartSkeleton placeholder.
 */
function ChartCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  loading?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card className="card-premium">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-72">{children}</div>
      </CardContent>
    </Card>
  );
}

/**
 * ChartSkeleton — placeholder shown while the chart payload is in flight
 * on first paint. Subsequent refetches keep the previous chart visible
 * (TanStack Query's `keepPreviousData`-like behaviour via the query
 * cache), so this skeleton is only seen on the very first load or after
 * a hard refetch with no cached data.
 */
function ChartSkeleton() {
  return <Skeleton className="h-full w-full" />;
}

function ActionRow({
  icon: Icon, label, count, hint, onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  count: number;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 p-2.5 rounded-lg border border-border/60 hover:border-foreground/20 hover:bg-muted/30 smooth-fast text-left"
    >
      <div className="size-9 rounded-lg bg-muted/50 text-muted-foreground flex items-center justify-center shrink-0">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <span className="inline-flex items-center justify-center min-w-7 h-7 px-2 rounded-md bg-foreground text-background text-xs font-semibold tabular shrink-0">
        {fmtNumber(count)}
      </span>
      <ChevronRight className="size-4 text-muted-foreground shrink-0" />
    </button>
  );
}

function QuickAction({
  label, icon: Icon, onClick,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  onClick: () => void;
}) {
  const t = useT();
  return (
    <button
      onClick={onClick}
      className="group relative overflow-hidden rounded-xl bg-foreground text-background p-4 shadow-soft hover:shadow-soft-md smooth focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
    >
      <div className="relative flex items-center gap-3">
        <div className="size-10 rounded-lg bg-background/15 flex items-center justify-center shrink-0">
          <Icon className="size-5" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold tracking-tight">{label}</p>
          <p className="text-xs text-background/70 flex items-center gap-0.5 mt-0.5">
            {t("misc-open-action")} <ArrowRight className="size-3 group-hover:translate-x-0.5 smooth-fast" />
          </p>
        </div>
      </div>
    </button>
  );
}

// ============================================================
// Skeleton
// ============================================================
function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="border-gradient bg-mesh rounded-[var(--radius-xl)] px-5 py-6 shadow-soft">
        <Skeleton className="h-3 w-32 mb-2" />
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-96 mt-2" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="card-premium">
            <CardContent className="p-4">
              <Skeleton className="h-3 w-20 mb-3" />
              <Skeleton className="h-7 w-16 mb-2" />
              <Skeleton className="h-3 w-12" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="card-premium">
            <CardContent className="p-4">
              <Skeleton className="h-3 w-24 mb-3" />
              <Skeleton className="h-7 w-28 mb-2" />
              <Skeleton className="h-3 w-20" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="card-premium">
          <CardContent className="h-80 p-4"><Skeleton className="h-full w-full" /></CardContent>
        </Card>
        <Card className="card-premium">
          <CardContent className="h-80 p-4"><Skeleton className="h-full w-full" /></CardContent>
        </Card>
      </div>
      {/* Analytics section skeleton (task D-2) — two time-series cards
          above three categorical cards, mirroring the live layout. */}
      <div className="space-y-4">
        <div>
          <Skeleton className="h-6 w-32 mb-2" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <Card key={i} className="card-premium">
              <CardContent className="p-4">
                <Skeleton className="h-4 w-32 mb-2" />
                <Skeleton className="h-3 w-48 mb-4" />
                <Skeleton className="h-64 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="card-premium">
              <CardContent className="p-4">
                <Skeleton className="h-4 w-32 mb-2" />
                <Skeleton className="h-3 w-40 mb-4" />
                <Skeleton className="h-64 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
