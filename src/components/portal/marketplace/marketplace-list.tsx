"use client";

import { useState, useMemo, useCallback } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
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
 *   • "Load more" pagination via useInfiniteQuery (AUDIT2-LOGIC-UX M3 — was
 *     two-useQuery; after the second "Load more" the first extra page was
 *     dropped because `items = firstItems.concat(extraItems)` only ever
 *     kept ONE extra page. useInfiniteQuery accumulates every page in
 *     `data.pages` so all of them are retained).
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

  // Debounce search.
  useMemo(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => clearTimeout(timer);
  }, [search]);

  // Reset paging whenever any filter changes — done inline in the filter
  // setters (NOT in a useEffect) so we don't trip the
  // `react-hooks/set-state-in-effect` rule. useInfiniteQuery is keyed on
  // the filter values, so a filter change automatically refetches from
  // page 0 (the page state is internal to the query, no local state to
  // reset).
  const setTypeAndReset = useCallback((v: string) => { setType(v); }, []);
  const setCategoryAndReset = useCallback((v: string) => { setCategory(v); }, []);
  const setCountryAndReset = useCallback((v: string) => { setCountry(v); }, []);
  const setSortAndReset = useCallback((v: string) => { setSort(v); }, []);
  const setSearchAndReset = useCallback((v: string) => { setSearch(v); }, []);

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

  // AUDIT2-LOGIC-UX M3 — useInfiniteQuery replaces the broken two-useQuery
  // pattern. Every fetched page is retained in `data.pages`, so loading
  // page N+1 no longer evicts page N (the bug under the previous code:
  // `items = firstItems.concat(extraItems)` only kept the first page + the
  // latest fetched page, dropping every page in between). The queryKey
  // embeds the filter values so a filter change resets the page list to
  // just page 0 (no manual page-state reset needed).
  const infiniteQ = useInfiniteQuery<ListResponse>({
    queryKey: ["marketplace-list", type, category, country, sort, debouncedSearch],
    queryFn: async ({ pageParam }) => {
      // pageParam is typed as `unknown` from TanStack Query's default
      // generic — we know it's a number because initialPageParam + the
      // return of getNextPageParam below are both numbers. Cast for the
      // URLSearchParams construction.
      const pageIdx = Number(pageParam) || 0;
      const r = await fetch(`/api/marketplace?${buildQuery(pageIdx)}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const fetched = allPages.reduce((sum, p) => sum + (p.items?.length ?? 0), 0);
      // Stop fetching when we've already returned the full result set
      // (or the last page was a short page — which signals the end too).
      if (fetched >= (lastPage.total ?? 0)) return undefined;
      if ((lastPage.items?.length ?? 0) < PAGE_SIZE) return undefined;
      return allPages.length; // next page index = number of pages fetched so far
    },
  });

  // Flatten every fetched page into a single items array.
  const items: MarketplacePostCardData[] = useMemo(
    () => (infiniteQ.data?.pages ?? []).flatMap((p) => p.items ?? []),
    [infiniteQ.data],
  );
  const total = infiniteQ.data?.pages?.[0]?.total ?? 0;
  const hasMore = items.length < total;
  const loadingMore = infiniteQ.isFetching && (infiniteQ.isFetchingNextPage ?? false);
  const isInitialLoading = infiniteQ.isLoading;
  const isError = infiniteQ.isError;

  function onCardClick(id: string) {
    setSelectedId(id);
  }

  function loadMore() {
    void infiniteQ.fetchNextPage();
  }

  function clearFilters() {
    setSearch("");
    setType("all");
    setCategory("all");
    setCountry("all");
    setSort("recent");
    setDebouncedSearch("");
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
              <SelectTrigger
                aria-label={t("marketplace-filter-type")}
                className={cn("w-full sm:w-36", type !== "all" && "border-primary/60 ring-1 ring-primary/20")}
              >
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
              <SelectTrigger
                aria-label={t("marketplace-filter-category")}
                className={cn("w-full sm:w-44", category !== "all" && "border-primary/60 ring-1 ring-primary/20")}
              >
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
              <SelectTrigger
                aria-label={t("marketplace-filter-country")}
                className={cn("w-full sm:w-40", country !== "all" && "border-primary/60 ring-1 ring-primary/20")}
              >
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
              <SelectTrigger aria-label={t("marketplace-filter-sort")} className="w-full sm:w-40">
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
          {isInitialLoading
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
      {isInitialLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <MarketplacePostCardSkeleton key={`skeleton-${i}`} />
          ))}
        </div>
      ) : isError ? (
        <div className="text-center py-20 text-muted-foreground">
          <p>{t("marketplace-load-error")}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => infiniteQ.refetch()}>
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
