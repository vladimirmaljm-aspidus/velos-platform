"use client";

import * as React from "react";
import {
  AlertTriangle,
  Info,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import type {
  CompletenessReport,
  CompletenessIssue,
} from "@/lib/utils/completeness-checker";
import { useT } from "@/lib/i18n/store";

interface CompletenessCheckerProps {
  report: CompletenessReport;
  className?: string;
}

/**
 * Real-time data completeness panel for the offer creation form.
 *
 * Renders the CompletenessReport produced by `checkOfferCompleteness` as a
 * compact sidebar/below-the-form card: a progress bar with a 0–100% score,
 * a critical/warning summary badge, and a scrollable list of every missing
 * field grouped by location (offer / item / partner / tenant) with
 * per-field suggestions.
 *
 * The report is recomputed on every keystroke by the parent form (via
 * `useMemo`), so this component is purely presentational.
 */
export function CompletenessChecker({
  report,
  className,
}: CompletenessCheckerProps) {
  const t = useT();
  const {
    issues,
    criticalCount,
    warningCount,
    completenessScore,
    filledFields,
    totalFields,
  } = report;

  const scoreColor =
    completenessScore >= 80
      ? "text-green-600"
      : completenessScore >= 50
        ? "text-yellow-600"
        : "text-red-600";
  // The shadcn Progress renders the filled bar as a child element with
  // `[data-slot=progress-indicator]` and `bg-primary`. We override that
  // child's background via a Tailwind arbitrary descendant selector so the
  // bar actually reflects the score's severity color.
  const scoreIndicatorBg =
    completenessScore >= 80
      ? "[&>[data-slot=progress-indicator]]:bg-green-500"
      : completenessScore >= 50
        ? "[&>[data-slot=progress-indicator]]:bg-yellow-500"
        : "[&>[data-slot=progress-indicator]]:bg-red-500";

  // Group issues by location (and item index when present) so the list reads
  // naturally: all offer-level issues first, then per-line-item, then
  // partner, then tenant.
  const grouped = React.useMemo(() => {
    const map = new Map<string, CompletenessIssue[]>();
    for (const issue of issues) {
      const key =
        issue.location +
        (issue.itemIndex != null ? ` ${issue.itemIndex + 1}` : "");
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(issue);
    }
    return Array.from(map.entries());
  }, [issues]);

  return (
    <div className={cn("border rounded-lg p-4 space-y-3", className)}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4" />
          {t("misc-data-completeness")}
        </h3>
        <Badge
          variant={
            criticalCount > 0
              ? "destructive"
              : warningCount > 0
                ? "secondary"
                : "default"
          }
        >
          {t("misc-pct-complete").replace("{n}", String(completenessScore))}
        </Badge>
      </div>

      <div className="space-y-1">
        <Progress
          value={completenessScore}
          className={cn("h-2", scoreIndicatorBg)}
        />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>
            {t("misc-fields-filled").replace("{filled}", String(filledFields)).replace("{total}", String(totalFields))}
          </span>
          <span className={scoreColor}>
            {criticalCount > 0 && t("misc-critical-count").replace("{n}", String(criticalCount))}
            {warningCount > 0 && t("misc-warnings-count").replace("{n}", String(warningCount))}
            {criticalCount === 0 && warningCount === 0 && t("misc-all-fields-complete")}
          </span>
        </div>
      </div>

      {issues.length > 0 && (
        <div className="max-h-64 overflow-y-auto pr-1 -mr-1">
          <div className="space-y-2">
            {grouped.map(([group, groupIssues]) => (
              <div key={group} className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {group === "offer"
                    ? t("misc-completeness-offer")
                    : group === "partner"
                      ? t("misc-completeness-partner")
                      : group === "tenant"
                        ? t("misc-completeness-tenant")
                        : group.startsWith("item")
                          ? t("misc-completeness-line-item").replace("{n}", group.split(" ")[1])
                          : group}
                </div>
                {groupIssues.map((issue, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    {issue.severity === "critical" && (
                      <XCircle className="h-3.5 w-3.5 text-red-500 mt-0.5 shrink-0" />
                    )}
                    {issue.severity === "warning" && (
                      <AlertTriangle className="h-3.5 w-3.5 text-yellow-500 mt-0.5 shrink-0" />
                    )}
                    {issue.severity === "info" && (
                      <Info className="h-3.5 w-3.5 text-blue-500 mt-0.5 shrink-0" />
                    )}
                    <div className="flex-1">
                      <span
                        className={cn(
                          issue.severity === "critical" &&
                            "text-red-700 font-medium",
                          issue.severity === "warning" && "text-yellow-700",
                          issue.severity === "info" && "text-blue-700",
                        )}
                      >
                        {issue.message}
                      </span>
                      {issue.suggestion && (
                        <div className="text-muted-foreground mt-0.5">
                          {issue.suggestion}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
