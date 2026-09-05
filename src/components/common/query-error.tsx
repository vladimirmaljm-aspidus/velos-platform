"use client";

import { RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/store";

/* ─── QueryError ───────────────────────────────────────────────────────── */
/**
 * Honest failed-load state for server-backed list views (audit 4-d finding
 * P1-2 / task 35-3). Previously a failed useQuery rendered the view's
 * "empty" branch — an API outage looked exactly like "no data", which
 * destroyed trust. This card renders where the list content would, states
 * plainly that the load failed, and offers a retry.
 *
 * Used as the first branch of the standard skeleton/table/empty ternary:
 *   {q.isError ? <QueryError onRetry={() => q.refetch()} /> : isLoading ? … }
 *
 * `label` adds context (e.g. "Offers") in front of the generic message.
 * When no `onRetry` is provided the retry button renders disabled — the
 * failure is still surfaced honestly (role="alert").
 */
export function QueryError({
  onRetry,
  label,
  className,
}: {
  /** Re-run the failed query (usually `() => q.refetch()`). */
  onRetry?: () => void;
  /** Optional context label, e.g. the view/section name. */
  label?: string;
  className?: string;
}) {
  const t = useT();

  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-lg",
        "border border-destructive/30 bg-destructive/5 text-destructive",
        "px-4 py-3",
        "animate-fade-in",
        className,
      )}
    >
      <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-sm font-medium leading-relaxed">
        {label ? `${label} — ${t("load_error")}` : t("load_error")}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={onRetry}
        disabled={onRetry === undefined}
        className="shrink-0 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        <RefreshCw className="size-3.5" aria-hidden="true" />
        {t("retry")}
      </Button>
    </div>
  );
}
