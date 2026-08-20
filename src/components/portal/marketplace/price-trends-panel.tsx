"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as ChartTooltip,
  ResponsiveContainer,
  type TooltipProps,
} from "recharts";
import {
  Loader2,
  TrendingUp,
  TrendingDown,
  Minus,
} from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { fmtMoney } from "@/lib/utils/format";
import type { PriceTrendResult } from "@/lib/marketplace/intelligence";

interface PriceTrendsPanelProps {
  /** product_category filter (empty/undefined = all categories). */
  category?: string;
  /** Window in weeks (1m=4 / 3m=12 / 6m=26 / 1y=52). */
  weeks?: number;
  currency?: string;
}

interface PriceTrendsResponse extends PriceTrendResult {
  currency: string;
  sampleSize: number;
}

/**
 * PriceTrendsPanel — 12-week price history per category, for the
 * market-intelligence dashboard.
 *
 * Calls GET /api/marketplace/intelligence/price-trends?category=...
 * &weeks=... &currency=...
 *
 * Renders a recharts LineChart of weekly avg/min/max prices + a trend
 * badge (up/down/stable) and the % change over the window.
 */
export function PriceTrendsPanel({
  category,
  weeks = 12,
  currency = "USD",
}: PriceTrendsPanelProps) {
  const t = useT();
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  params.set("weeks", String(weeks));
  params.set("currency", currency.toUpperCase());
  const q = useQuery<PriceTrendsResponse>({
    queryKey: ["mkt-intel-price-trends", category ?? "", weeks, currency.toUpperCase()],
    queryFn: async () => {
      const r = await fetch(
        `/api/marketplace/intelligence/price-trends?${params}`,
      );
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    staleTime: 5 * 60_000,
    retry: 0,
  });

  if (q.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-1.5">
            <TrendingUp className="h-4 w-4" />
            {t("marketplace-intel-price-trends-title")}
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
            <TrendingUp className="h-4 w-4" />
            {t("marketplace-intel-price-trends-title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t("marketplace-intel-load-error")}
        </CardContent>
      </Card>
    );
  }

  const { weeks: data, trend, changePercent, currency: cur, sampleSize } = q.data;
  const hasData = sampleSize > 0 && data.some((w) => w.sampleCount > 0);

  const chartData = data.map((w) => ({
    label: fmtShortWeekLabel(w.week),
    avg: w.sampleCount > 0 ? w.avgPrice : null,
    min: w.sampleCount > 0 ? w.minPrice : null,
    max: w.sampleCount > 0 ? w.maxPrice : null,
  }));

  const trendMeta = (() => {
    switch (trend) {
      case "up":
        return {
          label: t("marketplace-intel-trend-up"),
          icon: TrendingUp,
          cls: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
        };
      case "down":
        return {
          label: t("marketplace-intel-trend-down"),
          icon: TrendingDown,
          cls: "border-transparent bg-rose-500/15 text-rose-700 dark:text-rose-400",
        };
      case "stable":
      default:
        return {
          label: t("marketplace-intel-trend-stable"),
          icon: Minus,
          cls: "border-transparent bg-muted text-muted-foreground",
        };
    }
  })();

  const TrendIcon = trendMeta.icon;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-1.5">
          <TrendingUp className="h-4 w-4" />
          {t("marketplace-intel-price-trends-title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <Badge variant="outline" className={trendMeta.cls}>
            <TrendIcon className="h-3 w-3 mr-1" />
            {trendMeta.label}
            {hasData && (
              <span className="ml-1 font-mono">
                {changePercent > 0 ? "+" : ""}
                {changePercent}%
              </span>
            )}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {t("marketplace-intel-sample-size").replace("{n}", String(sampleSize))}
          </span>
        </div>

        {!hasData ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {t("marketplace-intel-no-data")}
          </div>
        ) : (
          <div className="h-[220px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
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
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border)" }}
                  width={60}
                  tickFormatter={(v: number) => fmtMoney(v, cur)}
                />
                <ChartTooltip content={<PriceTrendTooltip currency={cur} />} />
                <Line
                  type="monotone"
                  dataKey="max"
                  name={t("marketplace-intel-price-max")}
                  stroke="#92400E"
                  strokeWidth={1}
                  strokeOpacity={0.5}
                  strokeDasharray="3 3"
                  dot={false}
                  connectNulls
                />
                <Line
                  type="monotone"
                  dataKey="min"
                  name={t("marketplace-intel-price-min")}
                  stroke="#92400E"
                  strokeWidth={1}
                  strokeOpacity={0.5}
                  strokeDasharray="3 3"
                  dot={false}
                  connectNulls
                />
                <Line
                  type="monotone"
                  dataKey="avg"
                  name={t("marketplace-intel-price-avg")}
                  stroke="#B45309"
                  strokeWidth={2}
                  dot={{ r: 2, fill: "#B45309" }}
                  activeDot={{ r: 4 }}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function PriceTrendTooltip({
  active,
  payload,
  label,
  currency,
}: TooltipProps<number, string> & { currency: string }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-md border bg-popover p-2 text-xs text-popover-foreground shadow-md">
      <p className="font-medium mb-1">{label}</p>
      {payload
        .filter((p) => typeof p.value === "number")
        .map((p, i) => (
          <p key={i} className="text-muted-foreground">
            <span
              className="inline-block h-2 w-2 mr-1.5 rounded-full"
              style={{ background: (p.color as string) || "#B45309" }}
            />
            {p.name}:{" "}
            <span className="text-foreground font-medium">
              {fmtMoney(p.value as number, currency)}
            </span>
          </p>
        ))}
    </div>
  );
}

function fmtShortWeekLabel(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
