"use client";

import { Button } from "@/components/ui/button";
import { ChevronDown, Loader2 } from "lucide-react";

/**
 * Shared "Load more" footer used by paginated list views (FIX-MARKET-UI /
 * FIX 4). Renders a centered button + a "{shown} of {total}" hint. Hidden
 * when there's no more data to load.
 *
 * The component is purely presentational — the parent owns the offset /
 * pages / loadMore state and passes the rendered counts. We keep this in
 * `components/common/` so the inventory / commissions / ERP / document
 * register views can share the same affordance.
 */
export function LoadMoreFooter({
  shown,
  total,
  hasMore,
  loading,
  onClick,
  loadMoreLabel,
  loadingLabel,
  showingLabel,
}: {
  shown: number;
  total: number;
  hasMore: boolean;
  loading: boolean;
  onClick: () => void;
  loadMoreLabel: string;
  loadingLabel: string;
  showingLabel: string;
}) {
  return (
    <div className="border-t border-border/40 p-4 flex flex-col items-center gap-2">
      <p className="text-xs text-muted-foreground">
        {showingLabel
          .replace("{shown}", String(shown))
          .replace("{total}", String(total))}
      </p>
      {hasMore && (
        <Button
          type="button"
          variant="outline"
          onClick={onClick}
          disabled={loading}
          className="gap-1.5"
        >
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ChevronDown className="size-4" />
          )}
          {loading ? loadingLabel : loadMoreLabel}
        </Button>
      )}
    </div>
  );
}

/**
 * Convenience hook that encapsulates the offset/page state + loadMore
 * behaviour shared across paginated views. Returns the current offset
 * (for the fetch URL), a `loadMore` callback (increments the page), and
 * a `reset` callback (resets to page 1 — called when filters change).
 *
 * The page size is fixed at `pageSize` (default 20) — every paginated
 * view in FIX 4 uses the same default so the UX is consistent across
 * Commissions, Inventory, ERP, and Document Register.
 */
export function useLoadMorePagination(pageSize = 20) {
  // We expose `pages` (the number of pages loaded) instead of a raw offset
  // because it makes the "Load more" semantics obvious: each click adds
  // one more page. The fetch URL computes offset = (pages - 1) * pageSize.
  return {
    pageSize,
    computeOffset: (pages: number) => (pages - 1) * pageSize,
  };
}
