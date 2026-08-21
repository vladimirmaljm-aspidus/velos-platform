"use client";

/**
 * ProductPicker — smart searchable product picker (Combobox pattern).
 *
 * Replaces the legacy plain `<Select>` that listed every product in a flat
 * dropdown (hard to scan with 300+ items). This component:
 *   - Fetches ALL products for the active tenant (limit=1000) once and caches
 *     them via react-query.
 *   - Lets the user search by name, SKU, HS code, brand or category as they
 *     type (client-side, debounced 200ms — the server only knows about name
 *     and SKU, so we broaden the match surface here).
 *   - Groups results by category with friendly headings.
 *   - Shows key trade info on every row: name, SKU, HS code, brand, unit,
 *     price, stock — so the user can pick the right product at a glance.
 *   - Offers an "Add custom product" escape hatch for items not in the
 *     catalog.
 *   - Calls `onSelect(product)` with the full Product object so the parent
 *     can auto-fill ALL line-item fields (price, HS, brand, specs, …).
 *
 * Designed to be reusable: it's also used by the invoice & proforma forms.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Check, ChevronsUpDown, Search, Plus, Package, Loader2,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem,
  CommandList, CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { useDebounced } from "@/lib/hooks/use-debounced";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { fmtMoney, fmtNumber } from "@/lib/utils/format";
import type { Product } from "@/lib/supabase/types";

export interface ProductPickerProps {
  /** Currently selected product_id (controlled). */
  value: string;
  /** Called when the user picks a product, or null when they clear it. */
  onSelect: (product: Product | null) => void;
  /** Optional escape-hatch callback for items not in the catalog. */
  onAddCustom?: () => void;
  placeholder?: string;
  /** Displayed on the trigger when `value` isn't in the fetched list yet
   *  (e.g. when editing an existing offer whose product sits outside the
   *  current search results). */
  fallbackName?: string;
  fallbackSku?: string;
  disabled?: boolean;
  className?: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  agriculture: "Agriculture",
  fertilizers: "Fertilizers",
  metals: "Metals",
  ores: "Ores",
  spices: "Spices",
  coffee: "Coffee",
  construction: "Construction",
  chemicals: "Chemicals",
  raw_materials: "Raw Materials",
  food: "Food & Beverage",
  industry: "Industrial",
  other: "Other",
};

function categoryLabel(c: string | null | undefined): string {
  if (!c) return "Other";
  return (
    CATEGORY_LABELS[c] ||
    c.charAt(0).toUpperCase() + c.slice(1).replace(/_/g, " ")
  );
}

/** Case-insensitive contains. */
function ic(haystack: string | null | undefined, needle: string): boolean {
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needle);
}

export function ProductPicker({
  value,
  onSelect,
  onAddCustom,
  placeholder = "Search products…",
  fallbackName,
  fallbackSku,
  disabled,
  className,
}: ProductPickerProps) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const debouncedSearch = useDebounced(search, 200);

  // Fetch the full catalog once (limit=1000 covers the ~363-product VELOS
  // DB; if the catalog grows past that the server still returns the most
  // recent 1000 — combined with client-side search this stays usable).
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["products", tenantKey, "picker", "1000"],
    queryFn: async () => {
      const r = await fetch(api(`/api/products`, { limit: 1000 }));
      if (!r.ok) throw new Error("Failed to load products");
      return r.json() as Promise<{ items: Product[]; total: number }>;
    },
    staleTime: 60_000, // cache for 1 minute to avoid re-fetching on every open
  });

  const allProducts = data?.items || [];

  // Client-side search across name, SKU, HS code, brand, category.
  // Server-side `/api/products?search=` only covers name + SKU, so we filter
  // here to add HS-code & brand matching.
  const filtered = React.useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    if (!q) return allProducts;
    return allProducts.filter((p) =>
      ic(p.name, q) ||
      ic(p.sku, q) ||
      ic(p.hs_code, q) ||
      ic(p.brand, q) ||
      ic(p.category, q) ||
      ic(p.tags?.join(" "), q)
    );
  }, [allProducts, debouncedSearch]);

  // Group filtered results by category (sorted by category label, then by name).
  const grouped = React.useMemo(() => {
    const map = new Map<string, Product[]>();
    for (const p of filtered) {
      const cat = p.category || "other";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(p);
    }
    for (const [, items] of map) {
      items.sort((a, b) => a.name.localeCompare(b.name));
    }
    return Array.from(map.entries()).sort((a, b) =>
      categoryLabel(a[0]).localeCompare(categoryLabel(b[0]))
    );
  }, [filtered]);

  // Trigger display: prefer the product from fetched data; fall back to
  // parent-provided name/sku so editing existing rows still shows something.
  const selected = allProducts.find((p) => p.id === value) || null;
  const showName = selected?.name || fallbackName || "";
  const showSku = selected?.sku || fallbackSku || "";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "w-full justify-between font-normal h-8 px-2",
            !showName && "text-muted-foreground",
            className
          )}
        >
          {showName ? (
            <span className="flex items-center gap-1.5 min-w-0">
              <Package className="size-3.5 text-muted-foreground shrink-0" />
              <span className="truncate text-xs">{showName}</span>
              {showSku && (
                <Badge
                  variant="secondary"
                  className="text-xs h-4 px-1 shrink-0 font-mono"
                >
                  {showSku}
                </Badge>
              )}
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <Search className="size-3.5" />
              <span className="text-xs">{placeholder}</span>
            </span>
          )}
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[540px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search by name, SKU, HS code, brand, category…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-[360px]">
            <CommandEmpty>
              {isLoading || (isFetching && !allProducts.length) ? (
                <span className="flex items-center justify-center gap-1.5">
                  <Loader2 className="size-3.5 animate-spin" />
                  Loading products…
                </span>
              ) : (
                <span>
                  No products match &ldquo;{search}&rdquo;.
                  {onAddCustom && " Try a different term or add a custom one below."}
                </span>
              )}
            </CommandEmpty>

            {grouped.map(([category, items]) => (
              <CommandGroup
                key={category}
                heading={`${categoryLabel(category)} (${items.length})`}
              >
                {items.map((p) => (
                  <ProductItem
                    key={p.id}
                    p={p}
                    selected={value === p.id}
                    onSelect={() => {
                      onSelect(p);
                      setOpen(false);
                      setSearch("");
                    }}
                  />
                ))}
              </CommandGroup>
            ))}

            {onAddCustom && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    onSelect={() => {
                      onAddCustom();
                      setOpen(false);
                      setSearch("");
                    }}
                  >
                    <Plus className="size-4" />
                    <span>Add custom product (not in catalog)</span>
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

const ProductItem = React.memo(function ProductItem({
  p,
  selected,
  onSelect,
}: {
  p: Product;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      value={p.id}
      onSelect={onSelect}
      className="flex items-start gap-2 py-2"
    >
      <Check
        className={cn(
          "size-4 mt-0.5 shrink-0",
          selected ? "opacity-100" : "opacity-0"
        )}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate text-sm">{p.name}</span>
          {p.sku && (
            <Badge
              variant="outline"
              className="text-xs h-4 px-1 font-mono shrink-0"
            >
              {p.sku}
            </Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5 flex-wrap">
          {p.hs_code && <span className="font-mono">HS {p.hs_code}</span>}
          {p.brand && <span>· {p.brand}</span>}
          <span>· {p.unit}</span>
          <span className="font-medium text-foreground">
            · {fmtMoney(p.price, p.currency || "USD")}/{p.unit}
          </span>
          {p.stock > 0 && (
            <span className="text-emerald-600 dark:text-emerald-500">
              · Stock: {fmtNumber(p.stock)}
            </span>
          )}
          {p.stock === 0 && (
            <span className="text-amber-600 dark:text-amber-500">
              · Out of stock
            </span>
          )}
        </div>
      </div>
    </CommandItem>
  );
});
