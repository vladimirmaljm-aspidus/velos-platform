"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  BarChart,
  Bar,
  Line,
  ComposedChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as ChartTooltip,
  ResponsiveContainer,
  type TooltipProps,
} from "recharts";
import { Loader2, Calendar } from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { fmtMoney } from "@/lib/utils/format";

interface SeasonalMonth {
  month: number;
  avgPrice: number;
  avgVolume: number;
  pattern: "high" | "medium" | "low";
}

interface SeasonalResponse {
  months: SeasonalMonth[];
  currency: string;
  sampleSize: number;
}

interface SeasonalPanelProps {
  category?: string;
  currency?: string;
}

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * SeasonalPanel — seasonal price patterns per category, for the
 * market-intelligence dashboard.
 *
 * Calls GET /api/marketplace/intelligence/seasonal?category=... &currency=...
 *
 * Renders a ComposedChart:
 *   • Bars for the monthly volume (left axis) — the seasonal cycle is
 *     volume-driven, so bars anchor the chart.
 *   • A line for the monthly avg price (right axis) — overlaid so the
 *     user can spot price-volatility seasons.
 *   • Bar fill colour: green (high-volume month) / amber (medium) /
 *     rose (low) — same palette as the heatmap.
 */
export function SeasonalPanel({ category, currency = "USD" }: SeasonalPanelProps) {
  const t = useT();
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  params.set("currency", currency.toUpperCase());
  const q = useQuery<SeasonalResponse>({
    queryKey: ["mkt-intel-seasonal", category ?? "", currency.toUpperCase()],
    queryFn: async () => {
      const r = await fetch(
        `/api/marketplace/intelligence/seasonal?${params}`,
      );
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    staleTime: 10 * 60_000,
    retry: 0,
  });

  if (q.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-1.5">
            <Calendar className="h-4 w-4" />
            {t("marketplace-intel-seasonal-title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }
  if (q.isError || !q.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-1.5">
            <Calendar className="h-4 w-4" />
            {t("marketplace-intel-seasonal-title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t("marketplace-intel-load-error")}
        </CardContent>
      </Card>
    );
  }

  const { months, currency: cur, sampleSize } = q.data;

  if (sampleSize === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-1.5">
            <Calendar className="h-4 w-4" />
            {t("marketplace-intel-seasonal-title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t("marketplace-intel-no-data")}
        </CardContent>
      </Card>
    );
  }

  const chartData = months.map((m) => ({
    label: MONTH_LABELS[m.month - 1] ?? String(m.month),
    volume: m.avgVolume,
    price: m.avgPrice > 0 ? m.avgPrice : null,
    pattern: m.pattern,
    fill:
      m.pattern === "high"
        ? "#10b981"
        : m.pattern === "medium"
          ? "#f59e0b"
          : "#f43f5e",
  }));

  const maxVolume = Math.max(...months.map((m) => m.avgVolume), 1);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-1.5">
          <Calendar className="h-4 w-4" />
          {t("marketplace-intel-seasonal-title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">
            {t("marketplace-intel-seasonal-volume-axis")}: 0–{maxVolume}
          </span>
          <span className="text-muted-foreground">
            {t("marketplace-intel-sample-size").replace("{n}", String(sampleSize))}
          </span>
        </div>
        <div className="h-[240px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={chartData}
              margin={{ top: 8, right: 8, bottom: 8, left: 8 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={{ stroke: "var(--border)" }}
              />
              <YAxis
                yAxisId="volume"
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={{ stroke: "var(--border)" }}
                width={40}
                tickFormatter={(v: number) => String(v)}
              />
              <YAxis
                yAxisId="price"
                orientation="right"
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={{ stroke: "var(--border)" }}
                width={60}
                tickFormatter={(v: number) => fmtMoney(v, cur)}
              />
              <ChartTooltip content={<SeasonalTooltip currency={cur} />} />
              <Bar
                yAxisId="volume"
                dataKey="volume"
                name={t("marketplace-intel-seasonal-volume")}
                radius={[4, 4, 0, 0]}
                // Use the per-bar fill colour via the `fill` field on each
                // data point — recharts accepts a function here.
                fill="#9ca3af"
                shape={(props: any) => {
                  const { x, y, width, height, payload } = props;
                  return (
                    <rect
                      x={x}
                      y={y}
                      width={width}
                      height={height}
                      rx={4}
                      fill={payload.fill}
                      fillOpacity="0.75"
                    />
                  );
                }}
              />
              <Line
                yAxisId="price"
                type="monotone"
                dataKey="price"
                name={t("marketplace-intel-seasonal-price")}
                stroke="#1d4ed8"
                strokeWidth={2}
                dot={{ r: 3, fill: "#1d4ed8", stroke: "var(--background)" }}
                activeDot={{ r: 5 }}
                connectNulls
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="flex items-center justify-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
            {t("marketplace-intel-seasonal-high")}
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
            {t("marketplace-intel-seasonal-medium")}
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-rose-500" />
            {t("marketplace-intel-seasonal-low")}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function SeasonalTooltip({
  active,
  payload,
  label,
  currency,
}: TooltipProps<number, string> & { currency: string }) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload as
    | { volume: number; price: number | null; pattern: string }
    | undefined;
  return (
    <div className="rounded-md border bg-popover p-2 text-xs text-popover-foreground shadow-md">
      <p className="font-medium mb-1">{label}</p>
      {payload.map((p, i) => {
        if (p.value === null || typeof p.value !== "number") return null;
        const isPrice = p.dataKey === "price";
        return (
          <p key={i} className="text-muted-foreground">
            <span
              className="inline-block h-2 w-2 mr-1.5 rounded-full"
              style={{ background: (p.color as string) || "#9ca3af" }}
            />
            {p.name}:{" "}
            <span className="text-foreground font-medium">
              {isPrice
                ? fmtMoney(p.value as number, currency)
                : String(p.value)}
            </span>
          </p>
        );
      })}
      {row && (
        <p className="text-muted-foreground mt-1">
          pattern:{" "}
          <span className="text-foreground font-medium">{row.pattern}</span>
        </p>
      )}
    </div>
  );
}
