"use client";

import { Card, CardContent } from "@/components/ui/card";
import { LucideIcon, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { cn } from "@/lib/utils";

/* ─── Trend Direction ──────────────────────────────────────────────────── */
type TrendDirection = "up" | "down" | "flat";

export interface KpiCardTrend {
  /** Percentage value to display (e.g. 12.5) */
  value: number;
  /** Direction — "up" for positive, "down" for negative */
  direction: TrendDirection;
  /** Optional label like "vs last month" */
  label?: string;
}

/* ─── Semantic variant for the icon container ──────────────────────────── */
type KpiVariant = "default" | "positive" | "warning" | "negative";

const variantMap: Record<
  KpiVariant,
  { container: string; icon: string; border: string }
> = {
  default: {
    container:
      "bg-muted/60 dark:bg-muted/40",
    icon: "text-muted-foreground",
    border: "",
  },
  positive: {
    container:
      "bg-emerald-500/10 dark:bg-emerald-500/15",
    icon: "text-emerald-600 dark:text-emerald-400",
    border: "border-l-2 border-l-emerald-500/60 dark:border-l-emerald-400/50",
  },
  warning: {
    container:
      "bg-amber-500/10 dark:bg-amber-500/15",
    icon: "text-amber-600 dark:text-amber-400",
    border: "border-l-2 border-l-amber-500/60 dark:border-l-amber-400/50",
  },
  negative: {
    container:
      "bg-red-500/10 dark:bg-red-500/15",
    icon: "text-red-600 dark:text-red-400",
    border: "border-l-2 border-l-red-500/60 dark:border-l-red-400/50",
  },
};

/* ─── KpiCard ──────────────────────────────────────────────────────────── */
export function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
  iconClassName,
  variant = "default",
  trend,
  active,
  className,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: LucideIcon;

  /**
   * Optional override applied to the icon glyph (not the container).
   * Use only for status: text-warning, text-success, text-destructive.
   * When a `variant` is set the icon inherits the variant colour automatically.
   */
  iconClassName?: string;

  /**
   * Semantic variant — controls the icon container gradient and left-border accent.
   * "positive" → emerald tones, "warning" → amber, "negative" → red.
   * @default "default"
   */
  variant?: KpiVariant;

  /** Optional trend indicator showing % change with directional arrow */
  trend?: KpiCardTrend;

  /** Mark as the primary / active KPI — adds emerald left-border accent */
  active?: boolean;

  /** Additional class names for the outer card */
  className?: string;
}) {
  const v = variantMap[variant];

  const resolvedIconClass = iconClassName ?? v.icon;

  const trendIsPositive =
    trend && (trend.direction === "up" || trend.direction === "flat");

  return (
    <Card
      className={cn(
        "card-premium overflow-hidden group",
        /* Left-border accent for active or positive variant */
        active && !v.border && "border-l-2 border-l-primary/60 dark:border-l-primary/50",
        v.border,
        className,
      )}
    >
      <CardContent className="p-6">
        <div className="flex items-start justify-between gap-3">
          {/* ── Text Column ────────────────────────────────────── */}
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/80">
              {label}
            </p>

            {/* AUDIT28-DESIGN — calmer corporate value: 26px semibold reads
                "finance report" rather than "marketing dashboard". */}
            <p className="mt-1.5 text-[26px] font-semibold tracking-tight tabular leading-none text-foreground whitespace-nowrap">
              {value}
            </p>

            {/* Subtitle + trend row */}
            <div className="mt-1.5 flex items-center gap-2 flex-wrap">
              {sub && (
                <span className="text-xs text-muted-foreground/70">
                  {sub}
                </span>
              )}

              {trend && (
                <span
                  className={cn(
                    "inline-flex items-center gap-0.5 text-xs font-semibold tabular rounded-full px-1.5 py-0.5",
                    trendIsPositive
                      ? "bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400"
                      : "bg-red-500/10 text-red-600 dark:bg-red-500/15 dark:text-red-400",
                  )}
                >
                  {trend.direction === "up" ? (
                    <ArrowUpRight className="size-3" />
                  ) : trend.direction === "down" ? (
                    <ArrowDownRight className="size-3" />
                  ) : null}
                  {Math.abs(trend.value).toFixed(1)}%
                  {trend.label && (
                    <span className="font-normal text-muted-foreground/60 ml-0.5">
                      {trend.label}
                    </span>
                  )}
                </span>
              )}
            </div>
          </div>

          {/* ── Icon Container ─────────────────────────────────── */}
          <div
            className={cn(
              "size-12 rounded-xl flex items-center justify-center shrink-0 smooth",
              "group-hover:scale-105 group-hover:shadow-soft-md",
              v.container,
            )}
          >
            <Icon className={cn("size-6", resolvedIconClass)} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
