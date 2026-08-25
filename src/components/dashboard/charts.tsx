"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard analytics chart components (task D-2).
//
// Five reusable recharts visualisations, each fed by a slice of the
// `DashboardCharts` payload returned from GET /api/dashboard/charts:
//
//   • SalesTrendChart        — LineChart, monthly revenue, last 12 months
//   • TopProductsChart       — horizontal BarChart, top-N products by revenue
//   • OfferStatusChart       — PieChart (donut), count by OfferStatus
//   • MarginByCategoryChart  — vertical BarChart, avg margin % per category
//   • PaymentTrendChart      — AreaChart, monthly cash received
//
// All components are pure presentational — no data fetching here. The
// parent (dashboard-view) owns the useQuery and passes the pre-aggregated
// arrays down via props. Empty-state handling is local to each chart so
// a sparse series in one chart doesn't hide the others.
//
// ── VELOS copper palette ────────────────────────────────────────────────────
// Charts lean on the existing design-system tokens already wired in
// globals.css — `--chart-1` (deep copper, oklch(0.395 0.115 55) ≈ #B45309
// in sRGB) is the primary, with `--chart-2` (muted brass / amber, ≈ #D97706),
// `--chart-4` (corporate green), `--warning` (amber), and `--muted-foreground`
// for status slices that should recede (draft / expired).
//
// Hard-coded hex fallbacks are inlined on each <Cell> as the LAST style
// layer — recharts' fill prop doesn't read CSS custom properties
// consistently across browsers (the var() resolves at SVG-attribute time
// and is missing on Safari < 16), so we provide the literal copper hex
// (#B45309 / #D97706 / #F59E0B / #92400E / #FEF3C7) as a guaranteed
// fallback. The dark-mode CSS variables already brighten --chart-1 to
// oklch(0.68 0.14 58), so the literal hex is a touch darker in dark mode
// but still readable on the dark card surface.
// ─────────────────────────────────────────────────────────────────────────────

import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, AreaChart, Area,
  Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  type TooltipProps,
} from "recharts";
import type {
  DashboardSalesPoint,
  DashboardTopProduct,
  DashboardOfferStatusSlice,
  DashboardMarginByCategory,
  DashboardPaymentPoint,
  OfferStatus,
} from "@/lib/supabase/types";
import { fmtMoney, fmtNumber } from "@/lib/utils/format";
import { useT } from "@/lib/i18n/store";

// ── VELOS copper palette ────────────────────────────────────────────────────
// Primary:    #B45309  — deep copper (Veles, god of earth & wealth)
// Secondary:  #D97706  — amber
// Tertiary:   #F59E0B  — bright amber
// Quaternary: #92400E  — burnt copper
// Light:      #FEF3C7  — pale cream
//
// Status palette intentionally mixes warm + cool so the donut reads at a
// glance: draft (cool grey, "not yet actioned"), sent (bright amber,
// "in flight"), accepted (corporate green, "win"), rejected (red,
// "lost"), expired (faint copper, "stale").
const COPPER = {
  primary: "#B45309",
  secondary: "#D97706",
  tertiary: "#F59E0B",
  quaternary: "#92400E",
  light: "#FEF3C7",
} as const;

const STATUS_FILL: Record<OfferStatus, string> = {
  draft: "#94a3b8",      // slate-400 — cool grey, "not yet actioned"
  sent: "#F59E0B",       // amber-500 — "in flight"
  accepted: "#16a34a",   // green-600 — "win"
  rejected: "#dc2626",   // red-600 — "lost"
  expired: "#92400E",    // burnt copper — "stale"
  countered: "#D97706",  // amber-600 — "negotiation in progress"
};

// Shared tooltip styling — opaque popover, hairline border, small font.
// Matches the look of the existing Revenue & Margin Trend chart on the
// dashboard so the new charts feel native.
const TOOLTIP_STYLE = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--popover-foreground)",
} as const;

const AXIS_TICK_STYLE = { fontSize: 11, fill: "var(--muted-foreground)" } as const;

const GRID_STROKE = "var(--border)";

// ── Empty state ─────────────────────────────────────────────────────────────
function ChartEmpty({ message }: { message: string }) {
  return (
    <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

// ── Custom tooltip components ───────────────────────────────────────────────
// recharts' default formatter is awkward for currency + count pairs, so
// each chart gets a typed custom tooltip that lays out the payload the way
// the dashboard wants it.

function SalesTooltip({ active, payload }: TooltipProps<number, string>) {
  const t = useT();
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload as DashboardSalesPoint;
  return (
    <div style={TOOLTIP_STYLE} className="px-3 py-2 space-y-0.5">
      <div className="font-medium text-foreground">{p.label}</div>
      <div className="text-muted-foreground">
        {t("misc-charts-revenue")}:{" "}
        <span className="font-mono text-foreground">{fmtMoney(p.revenue)}</span>
      </div>
      <div className="text-muted-foreground">
        {t("misc-charts-count")}:{" "}
        <span className="font-mono text-foreground">{fmtNumber(p.count)}</span>
      </div>
    </div>
  );
}

function PaymentTooltip({ active, payload }: TooltipProps<number, string>) {
  const t = useT();
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload as DashboardPaymentPoint;
  return (
    <div style={TOOLTIP_STYLE} className="px-3 py-2 space-y-0.5">
      <div className="font-medium text-foreground">{p.label}</div>
      <div className="text-muted-foreground">
        {t("misc-charts-payments")}:{" "}
        <span className="font-mono text-foreground">{fmtMoney(p.payments)}</span>
      </div>
      <div className="text-muted-foreground">
        {t("misc-charts-count")}:{" "}
        <span className="font-mono text-foreground">{fmtNumber(p.count)}</span>
      </div>
    </div>
  );
}

function TopProductsTooltip({ active, payload }: TooltipProps<number, string>) {
  const t = useT();
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload as DashboardTopProduct;
  return (
    <div style={TOOLTIP_STYLE} className="px-3 py-2 space-y-0.5 max-w-xs">
      <div className="font-medium text-foreground truncate">{p.name}</div>
      {p.sku && (
        <div className="text-xs text-muted-foreground font-mono">{p.sku}</div>
      )}
      <div className="text-muted-foreground">
        {t("misc-charts-revenue")}:{" "}
        <span className="font-mono text-foreground">{fmtMoney(p.revenue)}</span>
      </div>
      <div className="text-muted-foreground">
        {t("misc-charts-line-items")}:{" "}
        <span className="font-mono text-foreground">{fmtNumber(p.count)}</span>
      </div>
    </div>
  );
}

function OfferStatusTooltip({ active, payload }: TooltipProps<number, string>) {
  const t = useT();
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload as DashboardOfferStatusSlice;
  return (
    <div style={TOOLTIP_STYLE} className="px-3 py-2 space-y-0.5">
      <div className="font-medium text-foreground capitalize">{p.status}</div>
      <div className="text-muted-foreground">
        {t("misc-charts-count")}:{" "}
        <span className="font-mono text-foreground">{fmtNumber(p.count)}</span>
      </div>
      <div className="text-muted-foreground">
        {t("misc-charts-total-value")}:{" "}
        <span className="font-mono text-foreground">{fmtMoney(p.value)}</span>
      </div>
    </div>
  );
}

function MarginTooltip({ active, payload }: TooltipProps<number, string>) {
  const t = useT();
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload as DashboardMarginByCategory;
  return (
    <div style={TOOLTIP_STYLE} className="px-3 py-2 space-y-0.5 max-w-xs">
      <div className="font-medium text-foreground truncate">{p.category}</div>
      <div className="text-muted-foreground">
        {t("misc-charts-avg-margin")}:{" "}
        <span className="font-mono text-foreground">{p.marginPct.toFixed(1)}%</span>
      </div>
      <div className="text-muted-foreground">
        {t("misc-charts-products")}:{" "}
        <span className="font-mono text-foreground">{fmtNumber(p.productCount)}</span>
      </div>
    </div>
  );
}

// ── 1. Sales Trend — LineChart ──────────────────────────────────────────────
export function SalesTrendChart({ data }: { data: DashboardSalesPoint[] }) {
  const t = useT();
  const total = data.reduce((s, p) => s + (p.revenue || 0), 0);
  if (!data.length || total === 0) {
    return <ChartEmpty message={t("misc-charts-no-sales-data")} />;
  }
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="salesLineGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={COPPER.primary} stopOpacity={0.9} />
            <stop offset="100%" stopColor={COPPER.quaternary} stopOpacity={0.6} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
        <XAxis
          dataKey="label"
          tick={AXIS_TICK_STYLE}
          stroke="var(--muted-foreground)"
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          tick={AXIS_TICK_STYLE}
          stroke="var(--muted-foreground)"
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k`}
          width={48}
        />
        <Tooltip content={<SalesTooltip />} />
        <Line
          type="monotone"
          dataKey="revenue"
          stroke="url(#salesLineGrad)"
          strokeWidth={2.5}
          dot={{ r: 3, fill: COPPER.primary, stroke: COPPER.primary }}
          activeDot={{ r: 5, fill: COPPER.secondary, stroke: "var(--background)", strokeWidth: 2 }}
          isAnimationActive={true}
          animationDuration={600}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── 2. Top Products — horizontal BarChart ───────────────────────────────────
export function TopProductsChart({ data }: { data: DashboardTopProduct[] }) {
  const t = useT();
  if (!data.length) {
    return <ChartEmpty message={t("misc-charts-no-products")} />;
  }
  // Truncate long product names on the y-axis so they don't push the bars
  // off-screen. The full name shows in the tooltip.
  const formatName = (name: string): string => {
    if (!name) return "—";
    return name.length > 22 ? `${name.slice(0, 21)}…` : name;
  };
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 24, left: 8, bottom: 4 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} horizontal={false} />
        <XAxis
          type="number"
          tick={AXIS_TICK_STYLE}
          stroke="var(--muted-foreground)"
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k`}
        />
        <YAxis
          type="category"
          dataKey="name"
          tick={AXIS_TICK_STYLE}
          stroke="var(--muted-foreground)"
          tickLine={false}
          axisLine={false}
          width={130}
          tickFormatter={(v: string) => formatName(v)}
        />
        <Tooltip content={<TopProductsTooltip />} cursor={{ fill: "var(--muted)", opacity: 0.35 }} />
        <Bar dataKey="revenue" radius={[0, 6, 6, 0]} barSize={18}>
          {data.map((entry, i) => (
            <Cell
              key={entry.product_id || i}
              fill={
                // Gradient: top product gets the deep copper, fading to
                // bright amber down the list — visual hierarchy without
                // a rainbow palette.
                i === 0 ? COPPER.primary :
                i === 1 ? COPPER.secondary :
                i === 2 ? COPPER.tertiary :
                i === 3 ? COPPER.quaternary :
                COPPER.light
              }
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── 3. Offer Status — Donut PieChart ────────────────────────────────────────
export function OfferStatusChart({ data }: { data: DashboardOfferStatusSlice[] }) {
  const t = useT();
  const total = data.reduce((s, p) => s + (p.count || 0), 0);
  if (!data.length || total === 0) {
    return <ChartEmpty message={t("misc-charts-no-offers")} />;
  }
  // Center label: total offer count. We render an absolutely-positioned
  // div over the chart container (recharts doesn't have a built-in center
  // label for donuts).
  return (
    <div className="relative h-full w-full">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="count"
            nameKey="status"
            cx="50%"
            cy="50%"
            innerRadius="58%"
            outerRadius="82%"
            paddingAngle={2}
            stroke="var(--background)"
            strokeWidth={2}
            isAnimationActive={true}
            animationDuration={600}
          >
            {data.map((entry) => (
              <Cell
                key={entry.status}
                fill={STATUS_FILL[entry.status] || COPPER.primary}
              />
            ))}
          </Pie>
          <Tooltip content={<OfferStatusTooltip />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <span className="text-2xl font-semibold tabular text-foreground">
          {fmtNumber(total)}
        </span>
        <span className="text-xs text-muted-foreground mt-0.5">
          {t("misc-charts-total-offers")}
        </span>
      </div>
    </div>
  );
}

// ── 4. Margin by Category — vertical BarChart ───────────────────────────────
export function MarginByCategoryChart({ data }: { data: DashboardMarginByCategory[] }) {
  const t = useT();
  if (!data.length) {
    return <ChartEmpty message={t("misc-charts-no-margin-data")} />;
  }
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="marginBarGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={COPPER.secondary} stopOpacity={0.95} />
            <stop offset="100%" stopColor={COPPER.primary} stopOpacity={0.75} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
        <XAxis
          dataKey="category"
          tick={AXIS_TICK_STYLE}
          stroke="var(--muted-foreground)"
          tickLine={false}
          axisLine={false}
          // Long category names get truncated; full name shows in tooltip.
          tickFormatter={(v: string) => (v && v.length > 12 ? `${v.slice(0, 11)}…` : v)}
        />
        <YAxis
          tick={AXIS_TICK_STYLE}
          stroke="var(--muted-foreground)"
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => `${v.toFixed(0)}%`}
          width={42}
        />
        <Tooltip content={<MarginTooltip />} cursor={{ fill: "var(--muted)", opacity: 0.35 }} />
        <Bar
          dataKey="marginPct"
          fill="url(#marginBarGrad)"
          radius={[6, 6, 0, 0]}
          barSize={28}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── 5. Payment Trend — AreaChart ────────────────────────────────────────────
export function PaymentTrendChart({ data }: { data: DashboardPaymentPoint[] }) {
  const t = useT();
  const total = data.reduce((s, p) => s + (p.payments || 0), 0);
  if (!data.length || total === 0) {
    return <ChartEmpty message={t("misc-charts-no-payments")} />;
  }
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="paymentAreaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={COPPER.secondary} stopOpacity={0.5} />
            <stop offset="100%" stopColor={COPPER.secondary} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
        <XAxis
          dataKey="label"
          tick={AXIS_TICK_STYLE}
          stroke="var(--muted-foreground)"
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          tick={AXIS_TICK_STYLE}
          stroke="var(--muted-foreground)"
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k`}
          width={48}
        />
        <Tooltip content={<PaymentTooltip />} />
        <Area
          type="monotone"
          dataKey="payments"
          stroke={COPPER.secondary}
          strokeWidth={2.5}
          fill="url(#paymentAreaGrad)"
          dot={{ r: 2.5, fill: COPPER.secondary, stroke: COPPER.secondary }}
          activeDot={{ r: 5, fill: COPPER.primary, stroke: "var(--background)", strokeWidth: 2 }}
          isAnimationActive={true}
          animationDuration={600}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
