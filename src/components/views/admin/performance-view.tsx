"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Performance dashboard (task D-8 APM)
//
// Super-admin-only view that surfaces the in-memory APM buffer maintained
// by `src/lib/monitoring/apm.ts`. Renders:
//
//   • 4 KPI cards         — Total / Avg response time / Slow / Error rate
//   • 2 process tiles     — Memory (RSS) + Heap used
//   • Alert banner        — populated from `checkAlerts()` server-side
//   • 3 recharts charts   — Response time line / Volume bar / Errors pie
//   • 2 tables            — Slowest routes (by maxMs) + Most active (by count)
//
// Auto-refreshes every 15s (faster than platform-health's 30s because the
// signals here are more time-sensitive — a slow-request spike should be
// visible within a minute). Manual "Refresh" and "Reset metrics" buttons
// also exposed.
//
// The component is purely a renderer — all aggregation happens server-side
// in `getMetricsSummary()` / `checkAlerts()`. The client just lays out
// the JSON it gets back.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Activity, AlertTriangle, CheckCircle2, Clock, Cpu, Database,
  Gauge, RefreshCw, Server, Trash2, TrendingUp, Zap, ShieldAlert,
} from "lucide-react";
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  type TooltipProps,
} from "recharts";
import { useT } from "@/lib/i18n/store";
import { fmtDateTime } from "@/lib/utils/format";
import { toast } from "sonner";
import { useAppStore, isSuperAdmin } from "@/lib/store/app-store";
import { PageHeader } from "@/components/common/page-header";
import { ModuleInfoTooltip } from "@/components/common/module-info-tooltip";


// ── Types (mirror the API response shape) ───────────────────────────────────

interface RouteStats {
  count: number;
  avgMs: number;
  maxMs: number;
  errors: number;
  totalMs: number;
  slow: number;
}

interface Metric {
  route: string;
  method: string;
  status: number;
  durationMs: number;
  timestamp: number;
  error?: string;
}

interface MetricsSummary {
  totalRequests: number;
  avgResponseTime: number;
  slowRequests: number;
  errorRate: number;
  byRoute: Record<string, RouteStats>;
}

interface PerformanceResponse {
  summary: MetricsSummary;
  alerts: string[];
  metrics: Metric[];
  memory: {
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
    externalMb: number;
  };
  uptimeSeconds: number;
  timestamp: string;
  slowThresholdMs: number;
  bufferCapacity: number;
}

// ── VELOS copper palette (matches dashboard/charts.tsx) ─────────────────────

const COPPER = {
  primary: "#B45309",
  secondary: "#D97706",
  tertiary: "#F59E0B",
  quaternary: "#92400E",
  light: "#FEF3C7",
} as const;

// Status-class palette for the error-distribution pie. Greens for success,
// cool blue for redirects (rare, neutral), amber for client errors (the
// user did something wrong, not the server), red for 5xx (server fault —
// the slice that matters most for SLO).
const STATUS_CLASS_FILL: Record<string, string> = {
  "2xx": "#16a34a",
  "3xx": "#0ea5e9",
  "4xx": "#F59E0B",
  "5xx": "#dc2626",
};

const TOOLTIP_STYLE = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--popover-foreground)",
} as const;

const AXIS_TICK_STYLE = { fontSize: 11, fill: "var(--muted-foreground)" } as const;
const GRID_STROKE = "var(--border)";

// ── Component ───────────────────────────────────────────────────────────────

export function PerformanceView() {
  const t = useT();
  const qc = useQueryClient();
  const userObj = useAppStore((s) => s.user);
  const isSuper = isSuperAdmin(userObj);

  const perfQ = useQuery({
    queryKey: ["admin-performance"],
    queryFn: async () => {
      const r = await fetch("/api/admin/performance");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<PerformanceResponse>;
    },
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    enabled: isSuper,
  });

  const resetMut = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/admin/performance", { method: "DELETE" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-performance"] });
      toast.success(t("pf-apm-reset-done"));
    },
    onError: () => toast.error(t("pf-apm-reset-failed")),
  });

  // Defense-in-depth: super-admin-only APM dashboard. The sidebar item
  // carries `permission: "platform.health.read"` (super-admin only after
  // the canUser fix), and /api/admin/performance uses requireSuperAdmin,
  // but a non-super-admin who reaches this view via state manipulation
  // should see a clear denial instead of firing 403 fetches every 15s.
  // NOTE: the access-denied card is rendered AFTER the useMemo hooks below
  // to comply with the rules-of-hooks rule (no conditional hook calls).

  const data = perfQ.data;
  const s = data?.summary;
  const generated = data?.timestamp ? fmtDateTime(data.timestamp) : "";

  // ── Derived chart datasets ───────────────────────────────────────────────
  //
  // Response-time-over-time: take the most recent 100 metrics (or all if
  // fewer) and plot duration vs. index. We don't plot timestamps on the
  // X-axis because the buffer covers a wide time range and absolute time
  // would be unreadable; the relative "request N" index is more useful
  // for spotting a trend (e.g. "the last 20 requests are all slow").
  const responseTimeSeries = React.useMemo(() => {
    if (!data?.metrics) return [];
    const slice = data.metrics.slice(-100);
    return slice.map((m, i) => ({
      idx: i + 1,
      ms: m.durationMs,
      route: `${m.method} ${m.route}`,
      status: m.status,
    }));
  }, [data]);

  // Volume-by-route: top 10 routes by request count, sorted desc.
  const volumeSeries = React.useMemo(() => {
    if (!s) return [];
    return Object.entries(s.byRoute)
      .map(([route, stats]) => ({ route, count: stats.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }, [s]);

  // Error distribution: bucket every metric by status class (2xx/3xx/4xx/5xx)
  // and count. The pie renders share-of-total. We exclude empty buckets so
  // the pie doesn't waste a slice on "0 redirects".
  const errorSeries = React.useMemo(() => {
    if (!data?.metrics) return [];
    const buckets: Record<string, number> = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
    for (const m of data.metrics) {
      const cls = m.status < 300 ? "2xx" : m.status < 400 ? "3xx" : m.status < 500 ? "4xx" : "5xx";
      buckets[cls]++;
    }
    return Object.entries(buckets)
      .filter(([, v]) => v > 0)
      .map(([name, value]) => ({ name, value }));
  }, [data]);

  // Total for the error-distribution pie — captured in the tooltip closure
  // so it can render "share: N%" without recharts exposing sibling data.
  const errorTotal = errorSeries.reduce((s, e) => s + e.value, 0);

  // Top 10 slowest routes: sort by maxMs desc.
  const slowestRoutes = React.useMemo(() => {
    if (!s) return [];
    return Object.entries(s.byRoute)
      .map(([route, stats]) => ({ route, ...stats }))
      .sort((a, b) => b.maxMs - a.maxMs)
      .slice(0, 10);
  }, [s]);

  // Top 10 most active routes: sort by count desc.
  const activeRoutes = React.useMemo(() => {
    if (!s) return [];
    return Object.entries(s.byRoute)
      .map(([route, stats]) => ({ route, ...stats }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }, [s]);

  // ── Render helpers ───────────────────────────────────────────────────────

  const slowThreshold = data?.slowThresholdMs ?? 2000;
  const hasData = !!s && s.totalRequests > 0;

  // Defense-in-depth: deny non-super-admins before rendering the dashboard.
  // Placed AFTER all hook calls to comply with react-hooks/rules-of-hooks.
  if (!isSuper) {
    return (
      <div>
        <PageHeader title={t("pf-apm-title")} description={t("pf-apm-desc")} />
        <Card className="border-amber-500/30 bg-amber-50/40 dark:bg-amber-500/5">
          <CardContent className="p-6 flex items-start gap-3">
            <div className="size-10 rounded-xl bg-amber-500/15 text-amber-600 flex items-center justify-center shrink-0">
              <ShieldAlert className="size-5" />
            </div>
            <div>
              <p className="font-medium">Platform admin access required.</p>
              <p className="text-sm text-muted-foreground mt-1">
                This area is restricted to platform super-administrators. Contact your platform operator if you believe this is an error.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  function fmtUptime(seconds: number): string {
    if (!seconds) return "—";
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  return (
    <div className="space-y-4">
      {/* ── Header card ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Gauge className="size-4 text-primary" />
                {t("pf-apm-title")}
               <ModuleInfoTooltip title="Performance" description="Application performance metrics — memory usage, response times, slow queries, and APM traces." howToUse={["View memory and CPU usage", "Monitor response times", "Identify slow queries", "View APM traces for slow requests"]} /></CardTitle>
              <CardDescription className="text-xs">{t("pf-apm-desc")}</CardDescription>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {generated && <span>{t("pf-apm-updated").replace("{when}", generated)}</span>}
              {data?.uptimeSeconds != null && (
                <Badge variant="outline" className="font-mono">
                  <Clock className="size-3 mr-1" />
                  {t("pf-apm-uptime")}: {fmtUptime(data.uptimeSeconds)}
                </Badge>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => perfQ.refetch()}
                disabled={perfQ.isFetching}
              >
                <RefreshCw className={`size-3.5 mr-1 ${perfQ.isFetching ? "animate-spin" : ""}`} />
                {t("refresh")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (typeof window !== "undefined" && window.confirm(t("pf-apm-reset-confirm"))) {
                    resetMut.mutate();
                  }
                }}
                disabled={resetMut.isPending || !hasData}
              >
                <Trash2 className="size-3.5 mr-1" />
                {t("pf-apm-reset")}
              </Button>
            </div>
          </div>
          {data && data.summary.totalRequests > 0 && (
            <p className="text-xs text-muted-foreground mt-2">
              {t("pf-apm-buffer-note")
                .replace("{n}", String(data.summary.totalRequests))
                .replace("{cap}", String(data.bufferCapacity))}
            </p>
          )}
        </CardHeader>
      </Card>

      {/* ── Loading / error states ───────────────────────────────────────── */}
      {perfQ.isLoading && (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">{t("pf-apm-loading")}</CardContent>
        </Card>
      )}
      {perfQ.error && (
        <Card>
          <CardContent className="p-6 text-sm text-destructive">{t("pf-apm-load-failed")}</CardContent>
        </Card>
      )}

      {/* ── Empty state ──────────────────────────────────────────────────── */}
      {data && !hasData && (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">{t("pf-apm-no-data")}</CardContent>
        </Card>
      )}

      {/* ── Main dashboard ───────────────────────────────────────────────── */}
      {data && hasData && s && (
        <>
          {/* ── Alerts banner ─────────────────────────────────────────────── */}
          <Card className={data.alerts.length > 0 ? "border-amber-500/40 bg-amber-500/5" : "border-emerald-500/30 bg-emerald-500/5"}>
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                {data.alerts.length > 0 ? (
                  <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                ) : (
                  <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                )}
                <div className="space-y-1 flex-1 min-w-0">
                  <p className="text-sm font-medium">{t("pf-apm-alerts-title")}</p>
                  {data.alerts.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("pf-apm-no-alerts")}</p>
                  ) : (
                    <ul className="text-xs space-y-1">
                      {data.alerts.map((a, i) => (
                        <li key={i} className="text-amber-700 dark:text-amber-400 font-mono">
                          • {a}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* ── KPI tiles ─────────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
            <Tile
              icon={Activity}
              label={t("pf-apm-kpi-total")}
              value={s.totalRequests.toLocaleString()}
              tone="info"
            />
            <Tile
              icon={Clock}
              label={t("pf-apm-kpi-avg")}
              value={`${s.avgResponseTime}ms`}
              tone={s.avgResponseTime > slowThreshold ? "warn" : "ok"}
            />
            <Tile
              icon={Zap}
              label={t("pf-apm-kpi-slow")}
              value={s.slowRequests}
              tone={s.slowRequests > 0 ? "warn" : "ok"}
              hint={t("pf-apm-kpi-slow-hint").replace("{ms}", String(slowThreshold))}
            />
            <Tile
              icon={AlertTriangle}
              label={t("pf-apm-kpi-errors")}
              value={`${(s.errorRate * 100).toFixed(2)}%`}
              tone={s.errorRate > 0.05 ? "critical" : "ok"}
            />
            <Tile
              icon={Server}
              label={t("pf-apm-kpi-memory")}
              value={`${data.memory.rssMb}MB`}
              tone="info"
              hint={t("pf-apm-kpi-memory-hint")}
            />
            <Tile
              icon={Cpu}
              label={t("pf-apm-kpi-heap")}
              value={`${data.memory.heapUsedMb}MB`}
              tone="info"
              hint={t("pf-apm-kpi-heap-hint")
                .replace("{used}", String(data.memory.heapUsedMb))
                .replace("{total}", String(data.memory.heapTotalMb))}
            />
          </div>

          {/* ── Charts row ────────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Response time over time */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <TrendingUp className="size-4 text-primary" />
                  {t("pf-apm-chart-response-time")}
                </CardTitle>
                <CardDescription className="text-xs">
                  {t("pf-apm-chart-response-time-desc").replace("{n}", String(responseTimeSeries.length))}
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="h-[260px]">
                  {responseTimeSeries.length === 0 ? (
                    <ChartEmpty message={t("pf-apm-empty-chart")} />
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={responseTimeSeries} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
                        <XAxis dataKey="idx" tick={AXIS_TICK_STYLE} stroke={GRID_STROKE} />
                        <YAxis tick={AXIS_TICK_STYLE} stroke={GRID_STROKE} unit="ms" width={60} />
                        <Tooltip content={<ResponseTimeTooltip />} />
                        <Line
                          type="monotone"
                          dataKey="ms"
                          stroke={COPPER.primary}
                          strokeWidth={1.5}
                          dot={false}
                          activeDot={{ r: 3, fill: COPPER.secondary }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Error distribution */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <AlertTriangle className="size-4 text-primary" />
                  {t("pf-apm-chart-errors")}
                </CardTitle>
                <CardDescription className="text-xs">{t("pf-apm-chart-errors-desc")}</CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="h-[260px]">
                  {errorSeries.length === 0 ? (
                    <ChartEmpty message={t("pf-apm-empty-chart")} />
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={errorSeries}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          outerRadius={85}
                          innerRadius={45}
                          paddingAngle={2}
                        >
                          {errorSeries.map((entry) => (
                            <Cell
                              key={entry.name}
                              fill={STATUS_CLASS_FILL[entry.name] ?? "#94a3b8"}
                            />
                          ))}
                        </Pie>
                        <Tooltip content={<StatusTooltip total={errorTotal} />} />
                      </PieChart>
                    </ResponsiveContainer>
                  )}
                </div>
                {errorSeries.length > 0 && (
                  <div className="flex flex-wrap gap-3 justify-center mt-2 text-xs">
                    {errorSeries.map((e) => (
                      <span key={e.name} className="flex items-center gap-1.5">
                        <span
                          className="size-2.5 rounded-sm"
                          style={{ background: STATUS_CLASS_FILL[e.name] ?? "#94a3b8" }}
                        />
                        <span className="text-muted-foreground">{t(`pf-apm-status-${e.name}`)}</span>
                        <span className="font-mono font-medium">{e.value}</span>
                      </span>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* ── Volume bar chart (full width) ─────────────────────────────── */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Database className="size-4 text-primary" />
                {t("pf-apm-chart-volume")}
              </CardTitle>
              <CardDescription className="text-xs">{t("pf-apm-chart-volume-desc")}</CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="h-[280px]">
                {volumeSeries.length === 0 ? (
                  <ChartEmpty message={t("pf-apm-empty-chart")} />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={volumeSeries}
                      layout="vertical"
                      margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} horizontal={false} />
                      <XAxis type="number" tick={AXIS_TICK_STYLE} stroke={GRID_STROKE} allowDecimals={false} />
                      <YAxis
                        type="category"
                        dataKey="route"
                        tick={AXIS_TICK_STYLE}
                        stroke={GRID_STROKE}
                        width={160}
                        tickFormatter={(v: string) => (v.length > 26 ? v.slice(0, 25) + "…" : v)}
                      />
                      <Tooltip content={<VolumeTooltip />} />
                      <Bar dataKey="count" fill={COPPER.secondary} radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </CardContent>
          </Card>

          {/* ── Route tables ──────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <RouteTable
              title={t("pf-apm-tab-slowest")}
              rows={slowestRoutes}
              highlight="max"
            />
            <RouteTable
              title={t("pf-apm-tab-active")}
              rows={activeRoutes}
              highlight="count"
            />
          </div>
        </>
      )}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

const TONE = {
  ok: "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400",
  info: "border-primary/30 bg-primary/5",
  warn: "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400",
  critical: "border-destructive/30 bg-destructive/5 text-destructive",
} as const;
type Tone = keyof typeof TONE;

function Tile({
  icon: Icon,
  label,
  value,
  tone,
  hint,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | string;
  tone: Tone;
  hint?: string;
}) {
  return (
    <Card className={`rounded-xl ${TONE[tone]}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs uppercase tracking-wider">{label}</p>
            <p className="text-2xl font-bold tabular mt-1">{value}</p>
          </div>
          <Icon className="size-4 opacity-60" />
        </div>
        {hint && <p className="text-xs opacity-70 mt-1">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function ChartEmpty({ message }: { message: string }) {
  return (
    <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

interface RouteRow extends RouteStats {
  route: string;
}

function RouteTable({
  title,
  rows,
  highlight,
}: {
  title: string;
  rows: RouteRow[];
  highlight: "max" | "count";
}) {
  const t = useT();
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">—</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground border-b">
                  <th className="py-1.5 pr-2 font-medium">{t("pf-apm-col-route")}</th>
                  <th className="py-1.5 px-2 font-medium text-right">{t("pf-apm-col-count")}</th>
                  <th className="py-1.5 px-2 font-medium text-right">{t("pf-apm-col-avg")}</th>
                  <th className="py-1.5 px-2 font-medium text-right">{t("pf-apm-col-max")}</th>
                  <th className="py-1.5 px-2 font-medium text-right">{t("pf-apm-col-errors")}</th>
                  <th className="py-1.5 pl-2 font-medium text-right">{t("pf-apm-col-slow")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.route} className="border-b last:border-0 hover:bg-muted/40">
                    <td className="py-1.5 pr-2 font-mono text-xs max-w-[260px] truncate" title={r.route}>
                      {r.route}
                    </td>
                    <td className={`py-1.5 px-2 text-right tabular ${highlight === "count" ? "font-semibold text-primary" : ""}`}>
                      {r.count}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular">{r.avgMs}</td>
                    <td className={`py-1.5 px-2 text-right tabular ${highlight === "max" ? "font-semibold text-primary" : ""} ${r.maxMs > 2000 ? "text-amber-600 dark:text-amber-400" : ""}`}>
                      {r.maxMs}
                    </td>
                    <td className={`py-1.5 px-2 text-right tabular ${r.errors > 0 ? "text-destructive font-medium" : "text-muted-foreground"}`}>
                      {r.errors}
                    </td>
                    <td className={`py-1.5 pl-2 text-right tabular ${r.slow > 0 ? "text-amber-600 dark:text-amber-400 font-medium" : "text-muted-foreground"}`}>
                      {r.slow}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Custom chart tooltips ───────────────────────────────────────────────────

function ResponseTimeTooltip(props: TooltipProps<number, string>) {
  const { active, payload } = props;
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload as { idx: number; ms: number; route: string; status: number };
  return (
    <div style={TOOLTIP_STYLE} className="px-3 py-2 space-y-0.5">
      <div className="text-muted-foreground">#{p.idx}</div>
      <div>
        <span className="text-muted-foreground">ms: </span>
        <span className="font-mono text-foreground">{p.ms}</span>
      </div>
      <div className="text-muted-foreground text-xs max-w-[280px] truncate">
        {p.route}
      </div>
      <div className="text-muted-foreground text-xs">HTTP {p.status}</div>
    </div>
  );
}

function StatusTooltip({
  total,
  ...props
}: TooltipProps<number, string> & { total: number }) {
  const t = useT();
  const { active, payload } = props;
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload as { name: string; value: number };
  const pct = total > 0 ? ((p.value / total) * 100).toFixed(1) : "—";
  return (
    <div style={TOOLTIP_STYLE} className="px-3 py-2 space-y-0.5">
      <div className="font-medium text-foreground">{t(`pf-apm-status-${p.name}`)}</div>
      <div>
        <span className="text-muted-foreground">count: </span>
        <span className="font-mono text-foreground">{p.value}</span>
      </div>
      <div>
        <span className="text-muted-foreground">share: </span>
        <span className="font-mono text-foreground">{pct}%</span>
      </div>
    </div>
  );
}

function VolumeTooltip(props: TooltipProps<number, string>) {
  const { active, payload } = props;
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload as { route: string; count: number };
  return (
    <div style={TOOLTIP_STYLE} className="px-3 py-2 space-y-0.5">
      <div className="font-mono text-foreground text-xs max-w-[280px] truncate">
        {p.route}
      </div>
      <div>
        <span className="text-muted-foreground">count: </span>
        <span className="font-mono text-foreground">{p.count}</span>
      </div>
    </div>
  );
}
