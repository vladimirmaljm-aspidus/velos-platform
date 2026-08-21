"use client";

import { useState, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Plus, Search, SearchX, FilterX, ChevronDown } from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { useAppStore } from "@/lib/store/app-store";
import {
  MarketplacePostCard,
  MarketplacePostCardSkeleton,
  type MarketplacePostCardData,
} from "./marketplace-post-card";
import { HowItWorks } from "./how-it-works";
import { COUNTRIES, PRODUCT_CATEGORIES } from "@/lib/data/reference";
import { cn } from "@/lib/utils";

interface ListResponse {
  items: MarketplacePostCardData[];
  total: number;
}

const PAGE_SIZE = 24;

/**
 * UI-3 step 2 — Marketplace list.
 *
 * Improvements over the Phase-1 baseline:
 *   • Sticky filter bar with clear visual active states (each dropdown's
 *     trigger turns copper when its value !== "all").
 *   • Results count + clear-filters button.
 *   • Loading state with skeleton cards (6 placeholders) instead of a single
 *     spinner — feels faster.
 *   • Empty state with the HowItWorks explainer + a "Be the first to post"
 *     CTA.
 *   • "Load more" pagination (server already supports offset=). A simple
 *     infinite-scroll would also work, but Load-more keeps the page
 *     navigation explicit and doesn't surprise keyboard users.
 */
export function MarketplaceList({ onCreateClick }: { onCreateClick?: () => void }) {
  const t = useT();
  const setSelectedId = useAppStore((s) => s.setSelectedId);
  const [search, setSearch] = useState("");
  const [type, setType] = useState<string>("all");
  const [category, setCategory] = useState<string>("all");
  const [country, setCountry] = useState<string>("all");
  const [sort, setSort] = useState<string>("recent");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(0);

  // Debounce search.
  useMemo(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => clearTimeout(timer);
  }, [search]);

  // Reset paging whenever any filter changes — done inline in the filter
  // setters (NOT in a useEffect) so we don't trip the
  // `react-hooks/set-state-in-effect` rule. Each setter also resets `page`
  // to 0 so we never render items[24..48] of a different result set.
  const setTypeAndReset = useCallback((v: string) => { setType(v); setPage(0); }, []);
  const setCategoryAndReset = useCallback((v: string) => { setCategory(v); setPage(0); }, []);
  const setCountryAndReset = useCallback((v: string) => { setCountry(v); setPage(0); }, []);
  const setSortAndReset = useCallback((v: string) => { setSort(v); setPage(0); }, []);
  // Search is debounced so the page reset has to wait for the debounced
  // value to land — this is fine because we only render with the latest
  // debounced value.
  const setSearchAndReset = useCallback((v: string) => { setSearch(v); setPage(0); }, []);

  const buildQuery = useCallback(
    (p: number) => {
      const queryParams = new URLSearchParams({
        sort,
        limit: String(PAGE_SIZE),
        offset: String(p * PAGE_SIZE),
      });
      if (type !== "all") queryParams.set("type", type);
      if (category !== "all") queryParams.set("category", category);
      if (country !== "all") queryParams.set("country", country);
      if (debouncedSearch) queryParams.set("search", debouncedSearch);
      return queryParams;
    },
    [sort, type, category, country, debouncedSearch],
  );

  // First page — full useQuery so we can use its loading/error state to drive
  // the initial render (skeletons / error / empty).
  const firstPageQ = useQuery<ListResponse>({
    queryKey: ["marketplace-list", type, category, country, sort, debouncedSearch, 0],
    queryFn: async () => {
      const r = await fetch(`/api/marketplace?${buildQuery(0)}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });

  // Additional pages — fetched on demand when the user clicks "Load more".
  // Each page is its own query so they can fail independently; we merge the
  // items client-side.
  const extraPagesQ = useQuery<ListResponse>({
    queryKey: ["marketplace-list", type, category, country, sort, debouncedSearch, page],
    queryFn: async () => {
      if (page === 0) return { items: [], total: 0 };
      const r = await fetch(`/api/marketplace?${buildQuery(page)}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    enabled: page > 0,
  });

  const firstItems = firstPageQ.data?.items ?? [];
  const extraItems = extraPagesQ.data?.items ?? [];
  // Concatenate first page + every extra page we've fetched. The flat index
  // tracks the per-page slice so an extra page replaces (not appends) the
  // previous extra page when the user changes filters.
  const items = page === 0 ? firstItems : firstItems.concat(extraItems);
  const total = firstPageQ.data?.total ?? 0;
  const hasMore = items.length < total;
  const loadingMore = extraPagesQ.isFetching && page > 0;

  function onCardClick(id: string) {
    setSelectedId(id);
  }

  function loadMore() {
    setPage((p) => p + 1);
  }

  function clearFilters() {
    setSearch("");
    setType("all");
    setCategory("all");
    setCountry("all");
    setSort("recent");
    setDebouncedSearch("");
    setPage(0);
  }

  const hasActiveFilters =
    type !== "all" || category !== "all" || country !== "all" || debouncedSearch !== "";

  // Whether the empty state should show the "Be the first to post" CTA vs
  // just "no results match your filters". When the user has filters applied,
  // the empty state is "no matches"; when they haven't, it's "no posts at
  // all" — the latter surfaces the HowItWorks explainer.
  const isUnfilteredEmpty = !hasActiveFilters && items.length === 0;

  return (
    <div className="space-y-6">
      {/* ─── Page header: title + subtitle ───────────────────────────── */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">
            {t("marketplace-title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("marketplace-subtitle")}
          </p>
        </div>
        {onCreateClick && (
          <Button
            onClick={onCreateClick}
            className="shrink-0 gap-1.5 self-start sm:self-auto w-full sm:w-auto"
          >
            <Plus className="h-4 w-4" />
            {t("marketplace-create-post")}
          </Button>
        )}
      </div>

      {/* ─── Sticky filter bar ────────────────────────────────────────── */}
      <div className="sticky top-16 z-20 -mx-4 px-4 py-3 sm:mx-0 sm:px-0 sm:py-0 sm:space-y-3">
        <div className="rounded-xl border border-border/60 bg-background/80 backdrop-blur-md shadow-soft p-3 sm:bg-background/60 sm:border sm:border-border/60 sm:shadow-sm sm:backdrop-blur-sm">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearchAndReset(e.target.value)}
                placeholder={t("marketplace-search-placeholder")}
                className="pl-9"
              />
            </div>
            <Select value={type} onValueChange={setTypeAndReset}>
              <SelectTrigger className={cn("w-full sm:w-36", type !== "all" && "border-primary/60 ring-1 ring-primary/20")}>
                <SelectValue placeholder={t("marketplace-all-types")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("marketplace-all-types")}</SelectItem>
                <SelectItem value="buy">{t("marketplace-buy")}</SelectItem>
                <SelectItem value="sell">{t("marketplace-sell")}</SelectItem>
                <SelectItem value="auction">{t("marketplace-auction")}</SelectItem>
                <SelectItem value="contract">{t("marketplace-contract")}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={category} onValueChange={setCategoryAndReset}>
              <SelectTrigger className={cn("w-full sm:w-44", category !== "all" && "border-primary/60 ring-1 ring-primary/20")}>
                <SelectValue placeholder={t("marketplace-all-categories")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("marketplace-all-categories")}</SelectItem>
                {PRODUCT_CATEGORIES.map((c) => (
                  <SelectItem key={c.code} value={c.code}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={country} onValueChange={setCountryAndReset}>
              <SelectTrigger className={cn("w-full sm:w-40", country !== "all" && "border-primary/60 ring-1 ring-primary/20")}>
                <SelectValue placeholder={t("marketplace-all-countries")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("marketplace-all-countries")}</SelectItem>
                {COUNTRIES.map((c) => (
                  <SelectItem key={c.code} value={c.code}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={setSortAndReset}>
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue placeholder={t("marketplace-sort-recent")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="recent">{t("marketplace-sort-recent")}</SelectItem>
                <SelectItem value="price_asc">{t("marketplace-sort-price-asc")}</SelectItem>
                <SelectItem value="price_desc">{t("marketplace-sort-price-desc")}</SelectItem>
                <SelectItem value="popular">{t("marketplace-sort-popular")}</SelectItem>
                <SelectItem value="ending_soon">{t("marketplace-sort-ending-soon")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* ─── Result count + clear filters ──────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-muted-foreground">
          {firstPageQ.isLoading
            ? t("marketplace-skeleton-loading")
            : t("marketplace-results-count").replace("{n}", String(total))}
          {hasMore && (
            <span className="ml-2 text-muted-foreground/70">
              · {t("marketplace-results-count").replace("{n}", String(items.length))} shown
            </span>
          )}
        </p>
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            className="gap-1.5 text-muted-foreground"
          >
            <FilterX className="size-3.5" />
            {t("marketplace-clear-filters")}
          </Button>
        )}
      </div>

      {/* ─── Grid ──────────────────────────────────────────────────────── */}
      {firstPageQ.isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <MarketplacePostCardSkeleton key={`skeleton-${i}`} />
          ))}
        </div>
      ) : firstPageQ.isError ? (
        <div className="text-center py-20 text-muted-foreground">
          <p>{t("marketplace-load-error")}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => firstPageQ.refetch()}>
            {t("portal-action-try-again")}
          </Button>
        </div>
      ) : items.length === 0 ? (
        isUnfilteredEmpty ? (
          // Truly empty marketplace — show the HowItWorks explainer + CTA.
          <div className="space-y-6">
            <div className="text-center py-8">
              <div className="size-14 mx-auto rounded-2xl bg-emerald-500/10 flex items-center justify-center mb-3">
                <Search className="size-7 text-emerald-700 dark:text-emerald-400" />
              </div>
              <p className="text-base font-semibold">{t("marketplace-no-posts")}</p>
              <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
                {t("marketplace-empty-desc")}
              </p>
            </div>
            <HowItWorks onCreateClick={onCreateClick} />
          </div>
        ) : (
          // Empty because of filters — calmer empty state.
          <div className="text-center py-16 rounded-xl border border-dashed border-border/60 bg-muted/10">
            <div className="size-12 mx-auto rounded-xl bg-muted flex items-center justify-center mb-3">
              <SearchX className="size-6 text-muted-foreground" />
            </div>
            <p className="font-medium">{t("marketplace-empty-title")}</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
              {t("marketplace-empty-desc")}
            </p>
            <Button variant="outline" size="sm" className="mt-4 gap-1.5" onClick={clearFilters}>
              <FilterX className="size-3.5" />
              {t("marketplace-clear-filters")}
            </Button>
          </div>
        )
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {items.map((post) => (
              <MarketplacePostCard
                key={post.id}
                post={post}
                onClick={onCardClick}
              />
            ))}
            {/* Skeleton placeholders rendered while a "Load more" fetch is
                in flight so the new page slides in gracefully. */}
            {loadingMore && Array.from({ length: 3 }).map((_, i) => (
              <MarketplacePostCardSkeleton key={`skeleton-more-${i}`} />
            ))}
          </div>

          {/* Load more button */}
          {hasMore && (
            <div className="text-center pt-2 pb-4">
              <Button
                variant="outline"
                onClick={loadMore}
                disabled={loadingMore}
                className="gap-1.5"
              >
                {loadingMore ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t("marketplace-loading-more")}
                  </>
                ) : (
                  <>
                    {t("marketplace-load-more")}
                    <ChevronDown className="size-4" />
                  </>
                )}
              </Button>
              <p className="text-xs text-muted-foreground mt-2 tabular">
                {items.length} / {total}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
