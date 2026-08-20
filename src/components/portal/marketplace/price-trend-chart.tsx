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
  Area,
  ComposedChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as ChartTooltip,
  ResponsiveContainer,
  ReferenceLine,
  type TooltipProps,
} from "recharts";
import { Loader2, TrendingUp, TrendingDown, Minus, Lightbulb } from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { fmtMoney } from "@/lib/utils/format";
import type { PricePrediction, PriceHistoryPoint } from "@/lib/marketplace/price-prediction";

interface PricePredictionResponse {
  prediction: PricePrediction;
  history: PriceHistoryPoint[];
  currency: string;
  sampleSize: number;
}

interface PriceTrendChartProps {
  /** The marketplace post id — used to fetch the price prediction + history. */
  postId: string;
}

/**
 * PriceTrendChart — historical price series + 30-day predicted band for a
 * post's product.
 *
 * Calls GET /api/marketplace/[id]/price-prediction, which returns:
 *   • `history` — a 12-week weekly-average series (PriceHistoryPoint[])
 *   • `prediction` — a 30-day forecast with min/max band + trend direction.
 *
 * Chart structure (recharts ComposedChart):
 *   • An Area series for the predicted band (min → max) — shades the
 *     forecast interval so the user sees the uncertainty visually.
 *   • A Line series for the historical weekly-average prices.
 *   • A ReferenceLine at `currentAverage` so the user can compare the
 *     historical trend against the most recent mean.
 *   • A vertical ReferenceLine at "today" separating history from forecast.
 *
 * Below the chart, the prediction's `factors` list renders as a small
 * bullet list so the user can read WHY the band is wide / trend is up.
 */
export function PriceTrendChart({ postId }: PriceTrendChartProps) {
  const t = useT();
  const q = useQuery<PricePredictionResponse>({
    queryKey: ["marketplace-price-prediction", postId],
    queryFn: async () => {
      const r = await fetch(`/api/marketplace/${postId}/price-prediction`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    staleTime: 5 * 60_000, // price predictions don't change per second
    retry: 0,
  });

  if (q.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-1.5">
            <TrendingUp className="h-4 w-4" />
            {t("marketplace-price-trend-title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (q.isError || !q.data) {
    return null; // hide rather than mislead — the card is non-essential
  }

  const { prediction, history, currency } = q.data;

  // Empty dataset — show the "no data" message.
  if (prediction.currentAverage === 0 || history.every((h) => h.sampleSize === 0)) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-1.5">
            <TrendingUp className="h-4 w-4" />
            {t("marketplace-price-trend-title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t("marketplace-price-trend-no-data")}
        </CardContent>
      </Card>
    );
  }

  // Build the chart data — merge history (date, average) with two
  // "forecast" points carrying the predicted min/max. The forecast is
  // rendered as a 2-point band spanning today → 30 days from now.
  const todayIso = new Date().toISOString();
  const future30dIso = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  type ChartPoint = {
    date: string;
    label: string;
    average: number | null;
    predMin: number | null;
    predMax: number | null;
  };

  const chartData: ChartPoint[] = history.map((h) => ({
    date: h.date,
    label: fmtShortDate(h.date),
    average: h.sampleSize > 0 ? h.average : null,
    predMin: null,
    predMax: null,
  }));

  // Append the forecast anchor points — the band extends from `today`
  // to `today+30d`. The "average" line is null for these points so the
  // historical series stays clean.
  chartData.push({
    date: todayIso,
    label: t("marketplace-price-trend-today"),
    average: null,
    predMin: prediction.predicted30Day.min,
    predMax: prediction.predicted30Day.max,
  });
  chartData.push({
    date: future30dIso,
    label: t("marketplace-price-trend-30d"),
    average: null,
    predMin: prediction.predicted30Day.min,
    predMax: prediction.predicted30Day.max,
  });

  const trendMeta = (() => {
    switch (prediction.predicted30Day.trend) {
      case "up":
        return {
          label: t("marketplace-price-trend-trend-up"),
          icon: TrendingUp,
          cls: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
        };
      case "down":
        return {
          label: t("marketplace-price-trend-trend-down"),
          icon: TrendingDown,
          cls: "border-transparent bg-rose-500/15 text-rose-700 dark:text-rose-400",
        };
      case "stable":
      default:
        return {
          label: t("marketplace-price-trend-trend-stable"),
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
          {t("marketplace-price-trend-title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <StatBox
            label={t("marketplace-price-trend-current-avg")}
            value={fmtMoney(prediction.currentAverage, currency)}
            highlight
          />
          <StatBox
            label={t("marketplace-price-trend-30d-min")}
            value={fmtMoney(prediction.predicted30Day.min, currency)}
          />
          <StatBox
            label={t("marketplace-price-trend-30d-max")}
            value={fmtMoney(prediction.predicted30Day.max, currency)}
          />
          <StatBox
            label={t("marketplace-price-trend-confidence")}
            value={`${prediction.confidence}%`}
          />
        </div>

        {/* Trend badge + sample size */}
        <div className="flex items-center justify-between">
          <Badge variant="outline" className={trendMeta.cls}>
            <TrendIcon className="h-3 w-3 mr-1" />
            {trendMeta.label}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {t("marketplace-price-trend-sample-size").replace(
              "{n}",
              String(q.data.sampleSize),
            )}
          </span>
        </div>

        {/* The chart itself — fixed height to keep the card tidy. */}
        <div className="h-[220px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={chartData}
              margin={{ top: 8, right: 8, bottom: 8, left: 8 }}
            >
              <defs>
                <linearGradient id="predBandFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#B45309" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#B45309" stopOpacity={0.05} />
                </linearGradient>
              </defs>
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
                tickFormatter={(v: number) => fmtMoney(v, currency)}
              />
              <ChartTooltip
                content={<PriceTrendTooltip currency={currency} />}
              />
              {/* Predicted band — an Area chart drawn under the line.
                  We render `predMax` as the Area's `dataKey` and pass
                  `predMin` as `baseLine` so the area fills between
                  min and max (rather than min → 0). */}
              <Area
                type="monotone"
                dataKey="predMax"
                name={t("marketplace-price-trend-30d-max")}
                stroke="#D97706"
                strokeWidth={1}
                fill="url(#predBandFill)"
                connectNulls
              />
              <Area
                type="monotone"
                dataKey="predMin"
                name={t("marketplace-price-trend-30d-min")}
                stroke="#D97706"
                strokeWidth={1}
                fill="var(--background)"
                connectNulls
              />
              {/* Historical weekly-average line. */}
              <Line
                type="monotone"
                dataKey="average"
                name={t("marketplace-price-trend-current-avg")}
                stroke="#B45309"
                strokeWidth={2}
                dot={{ r: 3, fill: "#B45309", stroke: "var(--background)" }}
                activeDot={{ r: 5 }}
                connectNulls
              />
              {/* Reference line at the current average — visual anchor
                  for "is the prediction higher or lower than today?". */}
              <ReferenceLine
                y={prediction.currentAverage}
                stroke="#92400E"
                strokeDasharray="4 4"
                strokeOpacity={0.5}
                label={{
                  value: t("marketplace-price-trend-current-avg"),
                  position: "insideTopRight",
                  fontSize: 10,
                  fill: "var(--muted-foreground)",
                }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Factors list — surfaces WHY the prediction is what it is. */}
        {prediction.factors.length > 0 && (
          <div className="space-y-1.5 pt-2 border-t">
            <p className="text-xs font-medium flex items-center gap-1.5">
              <Lightbulb className="h-3 w-3 text-muted-foreground" />
              {t("marketplace-price-trend-factors-title")}
            </p>
            <ul className="text-xs space-y-1">
              {prediction.factors.map((f, i) => (
                <li key={i} className="text-muted-foreground">
                  • {f}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Seasonality note (optional). */}
        {prediction.seasonalNote && (
          <div className="rounded-md bg-amber-500/10 p-2.5 text-xs text-amber-900 dark:text-amber-200">
            <p className="font-medium mb-0.5">{t("marketplace-price-trend-seasonal-title")}</p>
            <p>{prediction.seasonalNote}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Helper sub-components ────────────────────────────────────────────────

function StatBox({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className={highlight ? "rounded-md bg-muted/40 p-2" : "p-2"}>
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="font-medium mt-0.5 text-sm">{value}</p>
    </div>
  );
}

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
      {payload.map((p, i) => {
        const v = typeof p.value === "number" ? fmtMoney(p.value, currency) : "—";
        return (
          <p key={i} className="text-muted-foreground">
            <span
              className="inline-block h-2 w-2 mr-1.5 rounded-full"
              style={{ background: (p.color as string) || "#B45309" }}
            />
            {p.name}: <span className="text-foreground font-medium">{v}</span>
          </p>
        );
      })}
    </div>
  );
}

function fmtShortDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
