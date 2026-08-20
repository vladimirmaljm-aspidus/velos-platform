"use client";

import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Loader2, ShieldCheck, ShieldAlert, ShieldX, ShieldQuestion } from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { cn } from "@/lib/utils";
import type { RiskAssessment, RiskFactor } from "@/lib/marketplace/risk-scoring";

interface RiskBadgeResponse {
  assessment: RiskAssessment;
}

interface RiskBadgeProps {
  /** The marketplace post id — used to fetch the risk assessment. */
  postId: string;
  /** Compact "icon + score" mode for the post card list. Defaults to true.
   *  Set false on the post-detail page for the expanded "icon + label +
   *  tooltip" variant. */
  compact?: boolean;
  /** Optional className applied to the Badge root. */
  className?: string;
}

const LEVEL_META: Record<
  RiskAssessment["level"],
  { labelKey: string; icon: React.ComponentType<{ className?: string }>; cls: string }
> = {
  low: {
    labelKey: "marketplace-risk-low",
    icon: ShieldCheck,
    cls: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  },
  medium: {
    labelKey: "marketplace-risk-medium",
    icon: ShieldQuestion,
    cls: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",
  },
  high: {
    labelKey: "marketplace-risk-high",
    icon: ShieldAlert,
    cls: "border-transparent bg-orange-500/15 text-orange-700 dark:text-orange-400",
  },
  critical: {
    labelKey: "marketplace-risk-critical",
    icon: ShieldX,
    cls: "border-transparent bg-rose-500/15 text-rose-700 dark:text-rose-400",
  },
};

/**
 * RiskBadge — AI fraud-score badge for a marketplace post.
 *
 * Calls GET /api/marketplace/[id]/risk to fetch the assessment. The badge
 * colour follows the four risk bands (green=low, yellow=medium,
 * orange=high, red=critical) and the tooltip lists every triggered
 * factor with its description so an ops reviewer can see what drove the
 * score.
 *
 * The badge is OPTIONAL — when the assessment fails to load (network
 * error, auth failure, etc.), the badge renders nothing rather than
 * showing a misleading "0 score" placeholder. This is the same pattern
 * the verification-badge uses for level="none".
 *
 * The badge is intentionally lightweight — the risk API is called once
 * per mount (no refetchInterval — risk does not change per second).
 */
export function RiskBadge({ postId, compact = true, className }: RiskBadgeProps) {
  const t = useT();
  const q = useQuery<RiskBadgeResponse>({
    queryKey: ["marketplace-risk", postId],
    queryFn: async () => {
      const r = await fetch(`/api/marketplace/${postId}/risk`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    // The risk score only changes when the post / partner changes — keep
    // it cached for 5 minutes to avoid re-fetching on every detail-page
    // navigation back-and-forth.
    staleTime: 5 * 60_000,
    retry: 0,
  });

  if (q.isLoading) {
    return (
      <Badge variant="outline" className={cn("text-muted-foreground", className)}>
        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
        {t("marketplace-risk-loading")}
      </Badge>
    );
  }
  if (q.isError || !q.data?.assessment) {
    // Don't surface failures — a missing risk score shouldn't draw
    // attention away from the post content. The verification-badge next
    // to this one already communicates verification status.
    return null;
  }

  const a = q.data.assessment;
  const meta = LEVEL_META[a.level] ?? LEVEL_META.medium;
  const Icon = meta.icon;
  const triggered = a.factors.filter((f: RiskFactor) => f.triggered);

  // Compact mode: "icon + score" — the tooltip lists the factors.
  // Expanded mode: "icon + label + score" — same tooltip.
  const label = compact ? `${a.score}` : `${t(meta.labelKey)} · ${a.score}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={cn(meta.cls, "cursor-help", className)}>
          <Icon className={compact ? "h-3 w-3 mr-1" : "h-3.5 w-3.5 mr-1"} />
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm p-3">
        <div className="space-y-1.5">
          <p className="text-xs font-semibold">
            {t("marketplace-risk-tooltip-title")} — {t(meta.labelKey)} ({a.score}/100)
          </p>
          <p className="text-xs text-muted-foreground">
            {t(`marketplace-risk-recommendation-${a.recommendation}`)}
          </p>
          {triggered.length > 0 ? (
            <ul className="text-xs space-y-1 mt-1.5 pt-1.5 border-t border-border">
              {triggered.map((f) => (
                <li key={f.factor} className="text-muted-foreground">
                  <span className="font-medium text-foreground">• {t(`marketplace-risk-factor-${f.factor}`)}</span>
                  <span className="block text-[10px] mt-0.5">{f.description}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground mt-1.5 pt-1.5 border-t border-border">
              {t("marketplace-risk-no-factors")}
            </p>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
