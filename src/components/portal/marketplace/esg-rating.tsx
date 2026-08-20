"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Leaf,
  ShieldCheck,
  Users,
  Gauge,
  Calendar,
  Loader2,
  Award,
} from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { fmtDate } from "@/lib/utils/format";
import type { ESGRating, ESGScore } from "@/lib/supabase/marketplace-esg-types";
import { ESG_RATING_LABEL_KEY } from "@/lib/supabase/marketplace-esg-types";
import { cn } from "@/lib/utils";

interface ESGScoreResponse {
  score: ESGScore | null;
}

interface RatingMeta {
  /** Tailwind classes for the badge background + text colour. */
  cls: string;
  /** Bar colour override — defaults to `bg-primary` when null. */
  bar: string | null;
}

const RATING_META: Record<ESGRating, RatingMeta> = {
  aaa: { cls: "border-transparent bg-emerald-600/15 text-emerald-700 dark:text-emerald-300", bar: "bg-emerald-600" },
  aa:  { cls: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400", bar: "bg-emerald-500" },
  a:   { cls: "border-transparent bg-lime-500/15 text-lime-700 dark:text-lime-400",           bar: "bg-lime-500" },
  bbb: { cls: "border-transparent bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",     bar: "bg-yellow-500" },
  bb:  { cls: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",         bar: "bg-amber-500" },
  b:   { cls: "border-transparent bg-orange-500/15 text-orange-700 dark:text-orange-400",     bar: "bg-orange-500" },
  ccc: { cls: "border-transparent bg-rose-500/15 text-rose-700 dark:text-rose-400",            bar: "bg-rose-500" },
  unrated: { cls: "border-transparent bg-muted/40 text-muted-foreground", bar: null },
};

interface Pillar {
  key: "environmental" | "social" | "governance";
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
  valueKey: "environmental_score" | "social_score" | "governance_score";
}

const PILLARS: Pillar[] = [
  { key: "environmental", labelKey: "marketplace-esg-pillar-environmental", icon: Leaf,       valueKey: "environmental_score" },
  { key: "social",        labelKey: "marketplace-esg-pillar-social",         icon: Users,      valueKey: "social_score" },
  { key: "governance",    labelKey: "marketplace-esg-pillar-governance",    icon: ShieldCheck, valueKey: "governance_score" },
];

/**
 * ESG rating card — renders a company's environmental / social / governance
 * score breakdown + the overall letter-grade rating (AAA → CCC).
 *
 * The card is shown on the company profile. When the partner has no
 * assessment row yet, the card surfaces a muted "unrated" state with a
 * short callout explaining how the score is derived.
 *
 * Props:
 *   • `partnerId` — whose ESG score to load.
 *   • `compact` — when true, the card is rendered without the hero header
 *     (used inside the carbon-offset widget / dashboard slots where space
 *     is tight).
 */
export function ESGRating({
  partnerId,
  compact = false,
}: {
  partnerId: string;
  compact?: boolean;
}) {
  const t = useT();

  const q = useQuery<ESGScoreResponse>({
    queryKey: ["marketplace-esg-score", partnerId],
    queryFn: async () => {
      const r = await fetch(`/api/marketplace/esg/${encodeURIComponent(partnerId)}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    staleTime: 60_000,
  });

  if (q.isLoading) {
    return (
      <Card>
        <CardContent className="py-10 flex justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (q.isError) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          {t("marketplace-esg-load-error")}
        </CardContent>
      </Card>
    );
  }

  const score = q.data?.score ?? null;
  const rating: ESGRating = score?.rating ?? "unrated";
  const ratingMeta = RATING_META[rating] ?? RATING_META.unrated;
  const overall = score?.overall_score ?? 0;

  return (
    <Card>
      {!compact && (
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Gauge className="h-4 w-4" />
            {t("marketplace-esg-title")}
          </CardTitle>
        </CardHeader>
      )}
      <CardContent className="space-y-4">
        {/* Hero — overall rating + score */}
        <div className="flex items-center gap-4 rounded-md bg-gradient-to-br from-emerald-500/10 to-blue-500/10 p-4">
          <div className="size-12 rounded-md bg-background/60 flex items-center justify-center shrink-0">
            <Award className={cn("h-6 w-6", ratingMeta.cls.split(" ").filter((c) => c.startsWith("text-")).join(" "))} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {t("marketplace-esg-overall-rating")}
            </p>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="text-2xl font-bold tracking-tight uppercase">
                {rating === "unrated" ? "—" : rating}
              </span>
              {score && (
                <span className="text-sm font-medium text-muted-foreground">
                  {overall} / 100
                </span>
              )}
            </div>
            {score?.assessment_date && (
              <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                {t("marketplace-esg-assessed-on").replace(
                  "{date}",
                  fmtDate(score.assessment_date),
                )}
              </p>
            )}
          </div>
          <Badge variant="outline" className={cn("uppercase text-xs font-semibold", ratingMeta.cls)}>
            {t(ESG_RATING_LABEL_KEY[rating])}
          </Badge>
        </div>

        {/* Subscore bars */}
        <div className="space-y-3">
          {PILLARS.map((pillar) => {
            const value = score?.[pillar.valueKey] ?? 0;
            const barCls = ratingMeta.bar ?? "bg-primary";
            return (
              <div key={pillar.key} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-1.5">
                    <pillar.icon className="h-3.5 w-3.5 text-muted-foreground" />
                    {t(pillar.labelKey)}
                  </span>
                  <span className="font-medium tabular-nums">{value}</span>
                </div>
                <Progress
                  value={value}
                  // Override the indicator colour so the bar matches the
                  // rating tier (green = good, amber = watch, rose = poor).
                  className={cn(`[&_[data-slot=progress-indicator]]:${barCls}`)}
                />
              </div>
            );
          })}
        </div>

        {/* Notes + methodology */}
        {score?.notes && (
          <div className="rounded-md bg-muted/30 p-2.5 text-xs text-muted-foreground">
            <p className="font-medium mb-0.5">{t("marketplace-esg-notes")}</p>
            <p className="whitespace-pre-wrap">{score.notes}</p>
          </div>
        )}

        {!score && (
          <p className="text-xs text-muted-foreground">
            {t("marketplace-esg-unrated-desc")}
          </p>
        )}

        <p className="text-[10px] text-muted-foreground border-t pt-2">
          {t("marketplace-esg-methodology")}
        </p>
      </CardContent>
    </Card>
  );
}
