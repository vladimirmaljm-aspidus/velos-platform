"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Loader2, Scale } from "lucide-react";
import { useT } from "@/lib/i18n/store";

interface SupplyDemandResponse {
  index: number;
  balance: "buyer_market" | "seller_market" | "balanced";
  description: string;
  buyPosts: number;
  sellPosts: number;
  trend: "rising" | "falling" | "flat";
}

interface SupplyDemandPanelProps {
  category?: string;
  days?: number;
}

/**
 * SupplyDemandPanel — supply/demand gauge per category.
 *
 * Calls GET /api/marketplace/intelligence/supply-demand?category=... &days=...
 *
 * Renders a horizontal gauge (0 = seller market / 100 = buyer market)
 * with a marker at the current `index` and a label that describes the
 * market balance. Uses pure SVG so no maplibre-gl dependency.
 */
export function SupplyDemandPanel({ category, days = 30 }: SupplyDemandPanelProps) {
  const t = useT();
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  params.set("days", String(days));
  const q = useQuery<SupplyDemandResponse>({
    queryKey: ["mkt-intel-supply-demand", category ?? "", days],
    queryFn: async () => {
      const r = await fetch(
        `/api/marketplace/intelligence/supply-demand?${params}`,
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
            <Scale className="h-4 w-4" />
            {t("marketplace-intel-supply-demand-title")}
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
            <Scale className="h-4 w-4" />
            {t("marketplace-intel-supply-demand-title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t("marketplace-intel-load-error")}
        </CardContent>
      </Card>
    );
  }

  const { index, balance, description, buyPosts, sellPosts, trend } = q.data;

  const balanceColor: Record<SupplyDemandResponse["balance"], string> = {
    buyer_market:
      "text-emerald-700 dark:text-emerald-400",
    seller_market:
      "text-rose-700 dark:text-rose-400",
    balanced: "text-muted-foreground",
  };

  const balanceLabelKey = (() => {
    switch (balance) {
      case "buyer_market":
        return "marketplace-intel-balance-buyer";
      case "seller_market":
        return "marketplace-intel-balance-seller";
      case "balanced":
      default:
        return "marketplace-intel-balance-balanced";
    }
  })();

  const trendLabelKey = (() => {
    switch (trend) {
      case "rising":
        return "marketplace-intel-trend-rising";
      case "falling":
        return "marketplace-intel-trend-falling";
      case "flat":
      default:
        return "marketplace-intel-trend-flat";
    }
  })();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-1.5">
          <Scale className="h-4 w-4" />
          {t("marketplace-intel-supply-demand-title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-center">
          <p className={`text-3xl font-bold ${balanceColor[balance]}`}>{index}</p>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            {t("marketplace-intel-supply-demand-index-label")}
          </p>
        </div>

        <SupplyDemandGauge index={index} />

        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">
            {t("marketplace-intel-buy-posts")}:{" "}
            <span className="font-medium text-foreground">{buyPosts}</span>
          </span>
          <span className={`font-medium ${balanceColor[balance]}`}>
            {t(balanceLabelKey)}
          </span>
          <span className="text-muted-foreground">
            {t("marketplace-intel-sell-posts")}:{" "}
            <span className="font-medium text-foreground">{sellPosts}</span>
          </span>
        </div>

        <p className="text-xs text-muted-foreground text-center pt-1 border-t">
          {description}
        </p>

        <div className="text-xs text-muted-foreground text-center">
          {t("marketplace-intel-week-trend")}: {t(trendLabelKey)}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Gauge sub-component ──────────────────────────────────────────────────
//
// A horizontal bar split into three zones (seller / balanced / buyer)
// with a marker at the current index. Pure SVG so no external dep.

function SupplyDemandGauge({ index }: { index: number }) {
  const clamped = Math.max(0, Math.min(100, index));
  const markerX = 4 + (clamped / 100) * 232; // gauge spans 4 → 236

  return (
    <svg
      width="100%"
      viewBox="0 0 240 40"
      className="overflow-visible"
      aria-label={`Supply/demand index ${clamped}`}
    >
      <defs>
        <linearGradient id="sd-gradient" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#f43f5e" stopOpacity="0.85" />
          <stop offset="50%" stopColor="#a1a1aa" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#10b981" stopOpacity="0.85" />
        </linearGradient>
      </defs>
      <rect x="4" y="12" width="232" height="14" rx="7" fill="url(#sd-gradient)" />
      <line x1="80" y1="10" x2="80" y2="28" stroke="var(--background)" strokeWidth="1" strokeOpacity="0.6" />
      <line x1="160" y1="10" x2="160" y2="28" stroke="var(--background)" strokeWidth="1" strokeOpacity="0.6" />
      {/* Marker triangle */}
      <polygon
        points={`${markerX - 5},2 ${markerX + 5},2 ${markerX},10`}
        fill="var(--foreground)"
      />
      <text x="0" y="38" fontSize="9" fill="var(--muted-foreground)">
        0
      </text>
      <text x="115" y="38" fontSize="9" fill="var(--muted-foreground)" textAnchor="middle">
        50
      </text>
      <text x="240" y="38" fontSize="9" fill="var(--muted-foreground)" textAnchor="end">
        100
      </text>
    </svg>
  );
}
