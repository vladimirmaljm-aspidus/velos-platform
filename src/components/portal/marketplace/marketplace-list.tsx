"use client";

import { useState, useMemo, useCallback } from "react";
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Loader2,
  Search,
  SearchX,
  FilterX,
  ChevronDown,
  Star,
  Lock,
  X,
  BookmarkPlus,
  Bell,
  BellOff,
} from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { useAppStore } from "@/lib/store/app-store";
import { toast } from "sonner";
import {
  MarketplacePostCard,
  MarketplacePostCardSkeleton,
  type MarketplacePostCardData,
} from "./marketplace-post-card";
import { HowItWorks } from "./how-it-works";
import { COUNTRIES } from "@/lib/data/reference";
import { cn } from "@/lib/utils";
import { useWatchlist } from "./marketplace-actions";

interface ListResponse {
  items: MarketplacePostCardData[];
  total: number;
}

/** GET /api/marketplace/categories — the admin-curated taxonomy (099).
 *  Shared cache key with the create wizard + intelligence dashboard. */
interface MarketplaceCategoryItem {
  id: string;
  name: string;
  slug: string;
}

/** GET /api/marketplace/saved-searches — { items: MarketplaceSavedSearch[] }.
 *  Only the fields the chip row needs (migration 100 / 1-a contract). */
interface SavedSearchItem {
  id: string;
  name: string;
  filters: {
    search?: string;
    post_type?: string;
    product_category?: string;
    country?: string;
  };
  alert_enabled: boolean;
}

const PAGE_SIZE = 24;

/**
 * Offline fallback for the category filter when the taxonomy query fails
 * or returns empty — the CANONICAL taxonomy NAMES (migration 100
 * normalised the legacy reference.ts codes on marketplace_posts to
 * exactly these), because the filter value must send the NAME stored in
 * product_category. The static PRODUCT_CATEGORIES list (codes like
 * "AGRI", labels like "Agricultural Products") matches neither.
 */
const FALLBACK_CATEGORIES = [
  "Agriculture",
  "Food & Beverage",
  "Metals",
  "Chemicals",
  "Construction",
  "Energy",
  "Textiles",
  "Machinery",
  "Other",
] as const;

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
 *
 * Task 2-a:
 *   • The category Select feeds from GET /api/marketplace/categories and
 *     sends the taxonomy NAME (posts store names since 099; migration 100
 *     normalised legacy codes) — the old static PRODUCT_CATEGORIES codes
 *     never matched anything.
 *   • Watchlist-only mode replaces the (silently ignored) filter bar with
 *     a compact header row + clear button.
 *   • Saved searches (100): save the current filter set under a name
 *     (optionally with new-match alerts), re-apply it from a chip row.
 *
 * Task 2-c: the page title/subtitle/Create header now lives ONCE in
 * MarketplaceBrowser. This component keeps the filter bar, result count
 * and feed grid; `onCreateClick` is still forwarded to the HowItWorks
 * explainer's "Be the first to post" CTA in the empty state.
 */
export function MarketplaceList({ onCreateClick }: { onCreateClick?: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const setSelectedId = useAppStore((s) => s.setSelectedId);
  const [search, setSearch] = useState("");
  const [type, setType] = useState<string>("all");
  const [category, setCategory] = useState<string>("all");
  const [country, setCountry] = useState<string>("all");
  const [sort, setSort] = useState<string>("recent");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  // Watchlist-only mode — shows just the posts the client starred.
  const [watchlistOnly, setWatchlistOnly] = useState(false);
  const watchlist = useWatchlist();

  // ── Saved searches (100) ─────────────────────────────────────────────
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveAlert, setSaveAlert] = useState(false);

  // ── Categories from the API (099 taxonomy) ───────────────────────────
  // Shared query key with the create wizard / intelligence dashboard; on
  // failure/empty the static canonical-name fallback keeps the filter
  // usable. The option VALUE is the NAME (matches product_category).
  const categoriesQ = useQuery<{ items: MarketplaceCategoryItem[] }>({
    queryKey: ["marketplace-categories"],
    queryFn: async () => {
      const r = await fetch("/api/marketplace/categories");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const categoryOptions = useMemo(() => {
    const apiItems = categoriesQ.data?.items ?? [];
    if (apiItems.length > 0) {
      return apiItems.map((c) => ({ value: c.name, label: c.name }));
    }
    return FALLBACK_CATEGORIES.map((name) => ({ value: name, label: name }));
  }, [categoriesQ.data]);

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
    queryKey: ["marketplace-list", type, category, country, sort, debouncedSearch, watchlistOnly],
    queryFn: async ({ pageParam }) => {
      // pageParam is typed as `unknown` from TanStack Query's default
      // generic — we know it's a number because initialPageParam + the
      // return of getNextPageParam below are both numbers. Cast for the
      // URLSearchParams construction.
      const pageIdx = Number(pageParam) || 0;
      const r = watchlistOnly
        ? await fetch(`/api/marketplace/watchlist?hydrate=1&limit=${PAGE_SIZE}&offset=${pageIdx * PAGE_SIZE}`)
        : await fetch(`/api/marketplace?${buildQuery(pageIdx)}`);
      if (!r.ok) {
        // 099 — surface the machine-readable error code (e.g.
        // "marketplace_disabled") from the JSON error body so the error
        // branch below can render the tenant lock card instead of the
        // generic failure.
        const e = await r.json().catch(() => ({}));
        throw new Error((e as { code?: string }).code || "failed");
      }
      return r.json();
    },
    enabled: !watchlistOnly || watchlist.ids.length > 0 || watchlist.loading,
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

  // The caller's saved searches (100) — newest first. Rendered as a chip
  // row above the filter bar; a failed load simply hides the row.
  const savedQ = useQuery<{ items: SavedSearchItem[] }>({
    queryKey: ["marketplace-saved-searches"],
    queryFn: async () => {
      const r = await fetch("/api/marketplace/saved-searches");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    staleTime: 30_000,
    retry: 1,
  });
  const savedSearches = savedQ.data?.items ?? [];

  // Save the CURRENT filter set (only non-default values are sent).
  const saveSearch = useMutation({
    mutationFn: async (input: { name: string; alert_enabled: boolean }) => {
      const filters: Record<string, string> = {};
      if (debouncedSearch) filters.search = debouncedSearch;
      if (type !== "all") filters.post_type = type;
      if (category !== "all") filters.product_category = category;
      if (country !== "all") filters.country = country;
      const r = await fetch("/api/marketplace/saved-searches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: input.name,
          filters,
          alert_enabled: input.alert_enabled,
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error || "Failed to save search.");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-save-search-saved"));
      qc.invalidateQueries({ queryKey: ["marketplace-saved-searches"] });
      setSaveOpen(false);
      setSaveName("");
      setSaveAlert(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Delete a saved search (chip X).
  const deleteSaved = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/marketplace/saved-searches/${id}`, { method: "DELETE" });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error || "Failed to delete search.");
      }
    },
    onSuccess: () => {
      toast.success(t("marketplace-saved-search-deleted"));
      qc.invalidateQueries({ queryKey: ["marketplace-saved-searches"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Toggle the alert flag. The saved-searches contract (1-a) exposes only
  // GET/POST/DELETE — there is no PATCH — so the toggle is an awaited
  // DELETE + re-POST with the flipped flag, then one invalidation.
  const toggleAlert = useMutation({
    mutationFn: async (s: SavedSearchItem) => {
      const dr = await fetch(`/api/marketplace/saved-searches/${s.id}`, {
        method: "DELETE",
      });
      if (!dr.ok) {
        const e = await dr.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error || "Failed to update search.");
      }
      const cr = await fetch("/api/marketplace/saved-searches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: s.name,
          filters: s.filters,
          alert_enabled: !s.alert_enabled,
        }),
      });
      if (!cr.ok) {
        const e = await cr.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error || "Failed to update search.");
      }
      return { alert_enabled: !s.alert_enabled };
    },
    onSuccess: (data) => {
      toast.success(
        data.alert_enabled
          ? t("marketplace-saved-search-alert-on")
          : t("marketplace-saved-search-alert-off"),
      );
      qc.invalidateQueries({ queryKey: ["marketplace-saved-searches"] });
    },
    onError: (e: Error) => toast.error(e.message),
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
  // 099 — the feed 403s with code "marketplace_disabled" when the tenant
  // switch is off; the queryFn above pipes that code into the Error message.
  const marketplaceDisabled =
    isError && (infiniteQ.error as Error | null)?.message === "marketplace_disabled";

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
    setWatchlistOnly(false);
  }

  // Apply a saved search's filter set (bypasses the search debounce so
  // the query key updates immediately).
  function applySavedSearch(s: SavedSearchItem) {
    setSearch(s.filters.search ?? "");
    setDebouncedSearch(s.filters.search ?? "");
    setType(s.filters.post_type ?? "all");
    setCategory(s.filters.product_category ?? "all");
    setCountry(s.filters.country ?? "all");
    // Saved searches never carry a sort — restore the default.
    setSort("recent");
    setWatchlistOnly(false);
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
      {/* ─── Saved-search chips (100) ────────────────────────────────── */}
      {/* Only rendered when the list is non-empty. Copper accent pills,
          matching the quick-nav chips in MarketplaceBrowser. */}
      {savedSearches.length > 0 && !marketplaceDisabled && (
        <nav
          aria-label={t("marketplace-saved-searches-title")}
          className="flex flex-wrap items-center gap-2"
        >
          {savedSearches.map((s) => (
            <div
              key={s.id}
              className={cn(
                "group inline-flex items-center gap-0.5 rounded-full border pl-3 pr-1.5 py-1 text-xs smooth",
                s.alert_enabled
                  ? "border-primary/40 bg-primary/5 text-primary"
                  : "border-border/60 bg-background text-muted-foreground hover:border-primary/40 hover:text-primary",
              )}
            >
              <button
                type="button"
                className="max-w-44 truncate font-medium smooth"
                title={t("marketplace-saved-search-apply")}
                onClick={() => applySavedSearch(s)}
              >
                {s.name}
              </button>
              <button
                type="button"
                aria-label={t("marketplace-saved-search-alert-on")}
                title={
                  s.alert_enabled
                    ? t("marketplace-saved-search-alert-off")
                    : t("marketplace-saved-search-alert-on")
                }
                disabled={toggleAlert.isPending || deleteSaved.isPending}
                onClick={() => toggleAlert.mutate(s)}
                className={cn(
                  "rounded-full p-1 smooth hover:bg-accent",
                  s.alert_enabled ? "text-primary" : "text-muted-foreground/70",
                )}
              >
                {s.alert_enabled ? (
                  <Bell className="size-3.5" />
                ) : (
                  <BellOff className="size-3.5" />
                )}
              </button>
              <button
                type="button"
                aria-label={t("marketplace-saved-search-delete")}
                title={t("marketplace-saved-search-delete")}
                disabled={toggleAlert.isPending || deleteSaved.isPending}
                onClick={() => deleteSaved.mutate(s.id)}
                className="rounded-full p-1 text-muted-foreground/70 smooth hover:bg-accent hover:text-destructive"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </nav>
      )}

      {/* ─── Sticky filter bar ────────────────────────────────────────── */}
      {/* 099 — filters + result count are pointless when the marketplace is
          disabled for the tenant; only the lock card below renders. 2-a —
          hidden in watchlist-only mode (the filters are ignored there);
          the compact watchlist header replaces it. */}
      {!marketplaceDisabled && !watchlistOnly && (
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
                {/* 2-a — taxonomy NAMES from the API (posts store names
                    since 099; migration 100 normalised legacy codes). */}
                {categoryOptions.map((c) => (
                  <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
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
            {/* Watchlist toggle — personal bookmarks, every tier. */}
            <Button
              type="button"
              variant="outline"
              aria-pressed={watchlistOnly}
              className={cn(
                "gap-1.5 w-full sm:w-auto",
                watchlistOnly && "border-amber-500/60 bg-amber-500/10 text-amber-700 dark:text-amber-400",
              )}
              onClick={() => setWatchlistOnly((v) => !v)}
            >
              <Star className={cn("h-4 w-4", watchlistOnly && "fill-current text-amber-500")} />
              {t("marketplace-watchlist")}
            </Button>
            {/* 100 — save the current filter set under a name. Active only
                when some filter ≠ default. */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5 w-full sm:w-auto"
              disabled={!hasActiveFilters || saveSearch.isPending}
              title={hasActiveFilters ? t("marketplace-save-search") : t("marketplace-save-search-empty")}
              onClick={() => setSaveOpen(true)}
            >
              <BookmarkPlus className="h-3.5 w-3.5" />
              {t("marketplace-save-search")}
            </Button>
          </div>
        </div>
      </div>
      )}

      {/* ─── Watchlist-only header (2-a) ────────────────────────────────── */}
      {/* Compact row replacing the (silently ignored) filter bar while the
          feed is scoped to the starred posts. */}
      {!marketplaceDisabled && watchlistOnly && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2">
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-700 dark:text-amber-400">
            <Star className="size-4 fill-current" aria-hidden="true" />
            {t("marketplace-watchlist")}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1 text-muted-foreground"
            onClick={() => setWatchlistOnly(false)}
          >
            <X className="size-3.5" />
            {t("marketplace-clear-filters")}
          </Button>
        </div>
      )}

      {/* ─── Result count + clear filters ──────────────────────────── */}
      {!marketplaceDisabled && (
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-muted-foreground">
          {isInitialLoading
            ? t("marketplace-skeleton-loading")
            : t("marketplace-results-count").replace("{n}", String(total))}
          {hasMore && (
            <span className="ml-2 text-muted-foreground/70">
              {/* 2-a — "shown" was hardcoded English; now interpolated. */}
              · {t("marketplace-results-shown").replace("{n}", String(items.length))}
            </span>
          )}
        </p>
        {(hasActiveFilters || watchlistOnly) && (
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
      )}

      {/* ─── Grid ──────────────────────────────────────────────────────── */}
      {isInitialLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <MarketplacePostCardSkeleton key={`skeleton-${i}`} />
          ))}
        </div>
      ) : isError ? (
        marketplaceDisabled ? (
          // 099 — the tenant administrator turned the marketplace off: a
          // friendly lock card instead of the raw "failed to load" error.
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="size-14 rounded-2xl bg-muted flex items-center justify-center mb-4">
              <Lock className="size-7 text-muted-foreground" />
            </div>
            <p className="text-base font-semibold">{t("marketplace-disabled-title")}</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-md">
              {t("marketplace-disabled-desc")}
            </p>
          </div>
        ) : (
          <div className="text-center py-20 text-muted-foreground">
            <p>{t("marketplace-load-error")}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => infiniteQ.refetch()}>
              {t("portal-action-try-again")}
            </Button>
          </div>
        )
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

      {/* ─── Save-search dialog (100) ─────────────────────────────────── */}
      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t("marketplace-save-search-title")}</DialogTitle>
            <DialogDescription>{t("marketplace-save-search-desc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="save-search-name">{t("marketplace-save-search-name-label")}</Label>
              <Input
                id="save-search-name"
                value={saveName}
                maxLength={80}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder={t("marketplace-save-search-name-label")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && saveName.trim() && !saveSearch.isPending) {
                    saveSearch.mutate({ name: saveName.trim(), alert_enabled: saveAlert });
                  }
                }}
              />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
              <Label
                htmlFor="save-search-alert"
                className="text-sm font-normal cursor-pointer"
              >
                {t("marketplace-save-search-alert-label")}
              </Label>
              <Switch
                id="save-search-alert"
                checked={saveAlert}
                onCheckedChange={setSaveAlert}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setSaveOpen(false)}>
              {t("portal-action-cancel")}
            </Button>
            <Button
              type="button"
              disabled={!saveName.trim() || saveSearch.isPending}
              onClick={() => saveSearch.mutate({ name: saveName.trim(), alert_enabled: saveAlert })}
            >
              {saveSearch.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {t("portal-action-save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
