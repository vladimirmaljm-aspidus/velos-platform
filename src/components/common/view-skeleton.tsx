"use client";

import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/lib/i18n/store";

/* ─── ViewSkeleton ────────────────────────────────────────────────────── */
/**
 * Shared loading fallback for every dynamic() view import (app-shell +
 * portal-shell). Without it, the first visit to each view renders a blank
 * flash while the chunk downloads (audit 4-d finding P1-5).
 *
 * Mirrors the typical view layout: a PageHeader stand-in (title +
 * description), a 3-card KPI row, and a card with table-like shimmer rows
 * (same `p-4 space-y-2` + `h-12` rhythm the views use for their own
 * table skeletons).
 *
 * Page-level padding is intentionally NOT duplicated here: the shells
 * already provide it (app-shell content: `px-4 sm:px-6 lg:px-8
 * py-6 lg:py-8`; portal-shell main: `p-4 md:p-6 lg:p-8`) and the views
 * themselves add no page padding, so adding it here would double the
 * gutter and shift the layout when the real view swaps in.
 */
export function ViewSkeleton({
  className,
  rows = 5,
}: {
  className?: string;
  /** Number of table-like shimmer rows. @default 5 */
  rows?: number;
}) {
  const t = useT();
  return (
    <div
      className={cn("w-full animate-fade-in", className)}
      role="status"
      aria-busy="true"
      aria-label={t("loading")}
    >
      {/* ── PageHeader stand-in (title + description) ──────────── */}
      <div className="flex flex-col gap-1 mb-8">
        <Skeleton className="h-7 w-56 rounded-lg" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>

      {/* ── KPI row (most list views open with 3 KPI cards) ────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-20 rounded-xl" />
      </div>

      {/* ── Main card: toolbar + table-like shimmer rows ───────── */}
      <div className="rounded-xl border border-border/60 shadow-soft">
        <div className="p-4 space-y-2">
          {Array.from({ length: rows }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
