"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Gauge } from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { fmtMoney } from "@/lib/utils/format";

interface BenchmarkResponse {
  benchmark: {
    responseTime: {
      user: number;
      market: number;
      percentile: number;
    };
    priceCompetitiveness: {
      user: number;
      market: number;
      position: "above" | "below" | "at";
    };
    successRate: {
      user: number;
      market: number;
      percentile: number;
    };
  };
  user: {
    responseTimeHours: number;
    avgPrice: number;
    successRate: number;
  };
  market: {
    responseTimeHours: number;
    avgPrice: number;
    successRate: number;
  };
  userSampleSize: number;
  marketSampleSize: number;
}

interface BenchmarkPanelProps {
  category?: string;
  days?: number;
}

/**
 * BenchmarkPanel — user vs market comparison dashboard, for the
 * market-intelligence dashboard.
 *
 * Calls GET /api/marketplace/intelligence/benchmark?category=... &days=...
 *
 * Three metrics side-by-side:
 *   1. Response time (hours) — the signed-in partner's median response
 *      time vs the market's, with a percentile badge (lower = better).
 *   2. Price competitiveness — the partner's avg sell-side unit_price
 *      vs the market's, with an above/at/below badge (below = cheaper
 *      = more competitive for sellers).
 *   3. Success rate — the partner's % accepted vs the market's, with a
 *      percentile badge (higher = better).
 *
 * The percentiles are SIMPLIFIED proxies (the route only has two data
 * points) — surfaced as "you're in the top X%" but the tooltip notes
 * the simplified model.
 */
export function BenchmarkPanel({ category, days = 90 }: BenchmarkPanelProps) {
  const t = useT();
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  params.set("days", String(days));
  const q = useQuery<BenchmarkResponse>({
    queryKey: ["mkt-intel-benchmark", category ?? "", days],
    queryFn: async () => {
      const r = await fetch(
        `/api/marketplace/intelligence/benchmark?${params}`,
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
            <Gauge className="h-4 w-4" />
            {t("marketplace-intel-benchmark-title")}
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
            <Gauge className="h-4 w-4" />
            {t("marketplace-intel-benchmark-title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t("marketplace-intel-load-error")}
        </CardContent>
      </Card>
    );
  }

  const { benchmark, userSampleSize, marketSampleSize } = q.data;
  const rt = benchmark.responseTime;
  const pc = benchmark.priceCompetitiveness;
  const sr = benchmark.successRate;

  const rtPercentileBadge = percentileBadgeClass(rt.percentile);
  const srPercentileBadge = percentileBadgeClass(sr.percentile);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-1.5">
          <Gauge className="h-4 w-4" />
          {t("marketplace-intel-benchmark-title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <MetricBox
            label={t("marketplace-intel-benchmark-response-time")}
            user={`${rt.user.toFixed(1)}h`}
            market={`${rt.market.toFixed(1)}h`}
            badge={
              <Badge variant="outline" className={rtPercentileBadge.cls}>
                {t("marketplace-intel-benchmark-top")}: {rt.percentile}%
              </Badge>
            }
            lowerIsBetter
            tooltip={t("marketplace-intel-benchmark-rt-tooltip")}
          />
          <MetricBox
            label={t("marketplace-intel-benchmark-price")}
            user={fmtMoney(pc.user, "USD")}
            market={fmtMoney(pc.market, "USD")}
            badge={<PricePositionBadge position={pc.position} />}
            lowerIsBetter
            tooltip={t("marketplace-intel-benchmark-price-tooltip")}
          />
          <MetricBox
            label={t("marketplace-intel-benchmark-success-rate")}
            user={`${sr.user.toFixed(1)}%`}
            market={`${sr.market.toFixed(1)}%`}
            badge={
              <Badge variant="outline" className={srPercentileBadge.cls}>
                {t("marketplace-intel-benchmark-top")}: {sr.percentile}%
              </Badge>
            }
            higherIsBetter
            tooltip={t("marketplace-intel-benchmark-sr-tooltip")}
          />
        </div>

        <p className="text-xs text-muted-foreground text-center pt-1 border-t">
          {t("marketplace-intel-benchmark-sample")
            .replace("{u}", String(userSampleSize))
            .replace("{m}", String(marketSampleSize))}
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function MetricBox({
  label,
  user,
  market,
  badge,
  lowerIsBetter,
  higherIsBetter,
  tooltip,
}: {
  label: string;
  user: string;
  market: string;
  badge: React.ReactNode;
  lowerIsBetter?: boolean;
  higherIsBetter?: boolean;
  tooltip?: string;
}) {
  const t = useT();
  return (
    <div className="border rounded-md p-3 space-y-1.5" title={tooltip}>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div className="flex items-end justify-between">
        <p className="text-lg font-semibold leading-none">{user}</p>
        {badge}
      </div>
      <p className="text-[10px] text-muted-foreground">
        {lowerIsBetter && "↓ "}
        {higherIsBetter && "↑ "}
        {t("marketplace-intel-benchmark-market")}:{" "}
        <span className="font-medium text-foreground">{market}</span>
      </p>
    </div>
  );
}

function PricePositionBadge({
  position,
}: {
  position: "above" | "below" | "at";
}) {
  // 'below' = cheaper than market = more competitive for sellers → green.
  if (position === "below") {
    return (
      <Badge variant="outline" className="border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
        ↓
      </Badge>
    );
  }
  if (position === "above") {
    return (
      <Badge variant="outline" className="border-transparent bg-rose-500/15 text-rose-700 dark:text-rose-400">
        ↑
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-transparent bg-muted text-muted-foreground">
      =
    </Badge>
  );
}

function percentileBadgeClass(percentile: number): { cls: string } {
  if (percentile >= 75) {
    return {
      cls: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    };
  }
  if (percentile >= 50) {
    return {
      cls: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",
    };
  }
  return {
    cls: "border-transparent bg-rose-500/15 text-rose-700 dark:text-rose-400",
  };
}
