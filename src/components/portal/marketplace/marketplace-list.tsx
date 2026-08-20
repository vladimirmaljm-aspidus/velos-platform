"use client";

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Plus, Search, Package } from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { useAppStore } from "@/lib/store/app-store";
import { MarketplacePostCard, type MarketplacePostCardData } from "./marketplace-post-card";
import { COUNTRIES, PRODUCT_CATEGORIES } from "@/lib/data/reference";

interface ListResponse {
  items: MarketplacePostCardData[];
  total: number;
}

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

  const queryParams = new URLSearchParams({
    sort,
    limit: "24",
  });
  if (type !== "all") queryParams.set("type", type);
  if (category !== "all") queryParams.set("category", category);
  if (country !== "all") queryParams.set("country", country);
  if (debouncedSearch) queryParams.set("search", debouncedSearch);

  const q = useQuery<ListResponse>({
    queryKey: ["marketplace-list", type, category, country, sort, debouncedSearch],
    queryFn: async () => {
      const r = await fetch(`/api/marketplace?${queryParams}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });

  const items = q.data?.items ?? [];
  const total = q.data?.total ?? 0;

  function onCardClick(id: string) {
    setSelectedId(id);
  }

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("marketplace-search-placeholder")}
            className="pl-9"
          />
        </div>
        <Select value={type} onValueChange={setType}>
          <SelectTrigger className="w-full sm:w-32">
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
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-full sm:w-44">
            <SelectValue placeholder={t("marketplace-all-categories")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("marketplace-all-categories")}</SelectItem>
            {PRODUCT_CATEGORIES.map((c) => (
              <SelectItem key={c.code} value={c.code}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={country} onValueChange={setCountry}>
          <SelectTrigger className="w-full sm:w-40">
            <SelectValue placeholder={t("marketplace-all-countries")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("marketplace-all-countries")}</SelectItem>
            {COUNTRIES.map((c) => (
              <SelectItem key={c.code} value={c.code}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={setSort}>
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
        {onCreateClick && (
          <Button onClick={onCreateClick} className="shrink-0">
            <Plus className="h-4 w-4 mr-1" />
            {t("marketplace-create-post")}
          </Button>
        )}
      </div>

      {/* Result count */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {q.isLoading ? t("portal-loading-dots") : t("marketplace-results-count").replace("{n}", String(total))}
        </p>
        {(type !== "all" || category !== "all" || country !== "all" || debouncedSearch) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setType("all");
              setCategory("all");
              setCountry("all");
              setSort("recent");
            }}
          >
            {t("marketplace-clear-filters")}
          </Button>
        )}
      </div>

      {/* Grid */}
      {q.isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : q.isError ? (
        <div className="text-center py-20 text-muted-foreground">
          <p>{t("marketplace-load-error")}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => q.refetch()}>
            {t("portal-action-try-again")}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-20">
          <Package className="h-12 w-12 text-muted-foreground mx-auto mb-3 opacity-50" />
          <p className="text-muted-foreground">{t("marketplace-no-posts")}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {items.map((post) => (
            <MarketplacePostCard
              key={post.id}
              post={post}
              onClick={onCardClick}
            />
          ))}
        </div>
      )}

      {total > items.length && (
        <div className="text-center pt-2">
          <Badge variant="outline" className="text-xs text-muted-foreground">
            {items.length} / {total}
          </Badge>
        </div>
      )}
    </div>
  );
}
