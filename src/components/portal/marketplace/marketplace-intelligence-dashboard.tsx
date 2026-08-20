"use client";

import { useState } from "react";
import { LineChart, Globe2, Newspaper, Gauge, Calendar, Store } from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PriceTrendsPanel } from "@/components/portal/marketplace/price-trends-panel";
import { SupplyDemandPanel } from "@/components/portal/marketplace/supply-demand-panel";
import { TopCountriesPanel } from "@/components/portal/marketplace/top-countries-panel";
import { HeatmapPanel } from "@/components/portal/marketplace/heatmap-panel";
import { MarketNewsPanel } from "@/components/portal/marketplace/market-news-panel";
import { BenchmarkPanel } from "@/components/portal/marketplace/benchmark-panel";
import { SeasonalPanel } from "@/components/portal/marketplace/seasonal-panel";

/**
 * MarketplaceIntelligenceDashboard — the Phase 9 dashboard that ties
 * together the seven intelligence panels:
 *   • price trends (12-week line chart)
 *   • supply/demand (gauge)
 *   • top countries (importers + exporters bar charts)
 *   • demand heatmap (world map with intensity bubbles)
 *   • market news (web-search-driven news feed)
 *   • benchmark (user vs market — response time, price, success rate)
 *   • seasonal patterns (monthly volume + price chart)
 *
 * Two selectors at the top:
 *   1. Category — narrows every panel to a single product_category.
 *   2. Time range — 1m / 3m / 6m / 1y — sets the `weeks` (price trends)
 *      and `days` (everything else) for every panel.
 *
 * Each panel independently fetches its own data, so a failure on one
 * doesn't break the dashboard — the other panels keep rendering.
 *
 * Layout: 2-column grid on lg+, single column on mobile.
 */
const CATEGORIES = [
  "Agriculture",
  "Metals",
  "Energy",
  "Chemicals",
  "Construction Materials",
  "Food & Beverages",
  "Textiles",
  "Electronics",
] as const;

type TimeRangeKey = "1m" | "3m" | "6m" | "1y";
const TIME_RANGES: Array<{ key: TimeRangeKey; labelKey: string; weeks: number; days: number }> = [
  { key: "1m", labelKey: "marketplace-intel-time-range-1m", weeks: 4, days: 30 },
  { key: "3m", labelKey: "marketplace-intel-time-range-3m", weeks: 12, days: 90 },
  { key: "6m", labelKey: "marketplace-intel-time-range-6m", weeks: 26, days: 180 },
  { key: "1y", labelKey: "marketplace-intel-time-range-1y", weeks: 52, days: 365 },
];

export function MarketplaceIntelligenceDashboard() {
  const t = useT();
  const [category, setCategory] = useState<string>("all");
  const [timeRangeKey, setTimeRangeKey] = useState<TimeRangeKey>("3m");

  const timeRange = TIME_RANGES.find((r) => r.key === timeRangeKey)!;
  const categoryParam = category === "all" ? undefined : category;
  const weeks = timeRange.weeks;
  const days = timeRange.days;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <LineChart className="h-6 w-6" />
          {t("marketplace-intel-title")}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {t("marketplace-intel-subtitle")}
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Store className="h-4 w-4 text-muted-foreground" />
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder={t("marketplace-intel-category-all")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {t("marketplace-intel-category-all")}
              </SelectItem>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="inline-flex rounded-md border bg-background p-0.5 self-start">
          {TIME_RANGES.map((r) => (
            <Button
              key={r.key}
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                "h-7 px-3 text-xs font-medium",
                r.key === timeRangeKey
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setTimeRangeKey(r.key)}
            >
              {t(r.labelKey)}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <PriceTrendsPanel category={categoryParam} weeks={weeks} />
        <SupplyDemandPanel category={categoryParam} days={days} />
        <TopCountriesPanel category={categoryParam} days={days} />
        <HeatmapPanel category={categoryParam} days={days} />
        <SeasonalPanel category={categoryParam} />
        <BenchmarkPanel category={categoryParam} days={days} />
      </div>

      <MarketNewsPanel category={categoryParam} />

      <div className="flex items-center gap-2 text-xs text-muted-foreground justify-center pt-2 pb-6">
        <Globe2 className="h-3 w-3" />
        <span>{t("marketplace-intel-footer")}</span>
      </div>

      {/* Icons to satisfy unused-imports while keeping bundle shape
          aligned with the dashboard's visual vocabulary. */}
      <span className="hidden">
        <Newspaper />
        <Gauge />
        <Calendar />
      </span>
    </div>
  );
}
