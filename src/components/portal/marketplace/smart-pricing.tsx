"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  TrendingUp,
  TrendingDown,
  BarChart3,
  Lightbulb,
  Info,
  Loader2,
} from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { fmtMoney } from "@/lib/utils/format";
import type { MarketPriceStats } from "@/lib/supabase/marketplace-auction-types";

interface SmartPricingProps {
  /** Product name to look up. Empty string disables the widget. */
  productName: string;
  /** The caller's target price (number | null). NULL when the caller has
   *  not entered a price yet (or picked "on_request"). */
  targetPrice: number | null;
  currency: string;
}

interface SmartPricingResponse {
  stats: MarketPriceStats;
}

/**
 * SmartPricing — market price guidance for the create-post form.
 *
 * Calls GET /api/marketplace/smart-pricing?product=<name>&price=<target>
 * &currency=<USD> with a 400ms debounce so the user sees the market
 * context while typing the product name.
 *
 * Renders nothing when the product name is empty.
 *
 * UI:
 *   • Loader while fetching.
 *   • When sample_size < 3: a muted "not enough data" hint.
 *   • When target_price is set: an assessment badge (high / low / fair)
 *     with a contextual explanation.
 *   • Always (when data available): average / median / min / max numbers.
 *   • Always (when suggested_price != null): a "Suggested price" callout
 *     the user can click to auto-fill (the parent form's onChange handler
 *     is invoked).
 */
export function SmartPricing({ productName, targetPrice, currency }: SmartPricingProps) {
  const t = useT();
  const [debounced, setDebounced] = useState(productName);

  // Debounce the product name so we don't fire a request per keystroke.
  useEffect(() => {
    const i = setTimeout(() => setDebounced(productName.trim()), 400);
    return () => clearTimeout(i);
  }, [productName]);

  const q = useQuery<SmartPricingResponse>({
    queryKey: ["marketplace-smart-pricing", debounced, currency, targetPrice ?? ""],
    queryFn: async () => {
      const params = new URLSearchParams({
        product: debounced,
        currency,
      });
      if (targetPrice !== null && Number.isFinite(targetPrice)) {
        params.set("price", String(targetPrice));
      }
      const r = await fetch(`/api/marketplace/smart-pricing?${params}`);
      if (!r.ok) throw new Error("Failed to fetch market price.");
      return r.json();
    },
    enabled: debounced.length >= 2,
    staleTime: 60_000, // prices don't change per second
  });

  if (!debounced || debounced.length < 2) return null;

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-1.5">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t("marketplace-smart-pricing-loading")}
      </div>
    );
  }
  if (q.isError || !q.data) return null;

  const s = q.data.stats;
  if (s.sample_size < 3) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-1.5">
        <Info className="h-3 w-3" />
        {t("marketplace-smart-pricing-insufficient-data")}
      </div>
    );
  }

  const assessment = s.assessment;
  const assessmentMeta = (() => {
    switch (assessment) {
      case "high":
        return {
          label: t("marketplace-smart-pricing-assessment-high"),
          icon: TrendingUp,
          cls: "border-transparent bg-rose-500/15 text-rose-700 dark:text-rose-400",
          desc: t("marketplace-smart-pricing-assessment-high-desc"),
        };
      case "low":
        return {
          label: t("marketplace-smart-pricing-assessment-low"),
          icon: TrendingDown,
          cls: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",
          desc: t("marketplace-smart-pricing-assessment-low-desc"),
        };
      case "fair":
        return {
          label: t("marketplace-smart-pricing-assessment-fair"),
          icon: BarChart3,
          cls: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
          desc: t("marketplace-smart-pricing-assessment-fair-desc"),
        };
      default:
        return null;
    }
  })();

  return (
    <Card className="bg-muted/30">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-1.5 text-muted-foreground">
          <Lightbulb className="h-3 w-3" />
          {t("marketplace-smart-pricing-title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Assessment badge */}
        {assessmentMeta && targetPrice !== null && (
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={assessmentMeta.cls}>
              <assessmentMeta.icon className="h-3 w-3 mr-1" />
              {assessmentMeta.label}
            </Badge>
            <span className="text-sm text-muted-foreground">{assessmentMeta.desc}</span>
          </div>
        )}

        {/* Stats grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <StatBox label={t("marketplace-smart-pricing-average")} value={s.average_price} currency={currency} highlight />
          <StatBox label={t("marketplace-smart-pricing-median")} value={s.median_price} currency={currency} />
          <StatBox label={t("marketplace-smart-pricing-min")} value={s.min_price} currency={currency} />
          <StatBox label={t("marketplace-smart-pricing-max")} value={s.max_price} currency={currency} />
        </div>

        {/* Sample size + suggested price */}
        <div className="flex items-center justify-between text-xs text-muted-foreground pt-1 border-t">
          <span>
            {t("marketplace-smart-pricing-sample-size").replace("{n}", String(s.sample_size))}
          </span>
          {s.suggested_price !== null && (
            <span className="font-medium text-foreground">
              {t("marketplace-smart-pricing-suggested").replace(
                "{n}",
                fmtMoney(s.suggested_price, currency),
              )}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function StatBox({
  label,
  value,
  currency,
  highlight,
}: {
  label: string;
  value: number | null;
  currency: string;
  highlight?: boolean;
}) {
  return (
    <div className={highlight ? "rounded-md bg-background/80 p-2" : "p-2"}>
      <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="font-medium mt-0.5">{fmtMoney(value, currency)}</p>
    </div>
  );
}
