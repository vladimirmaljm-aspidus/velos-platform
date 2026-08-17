"use client";

/**
 * PartnerPicker — searchable combobox for picking a Partner (supplier/buyer/etc.).
 *
 * Replaces the legacy plain `<Select>` that listed every partner in a flat
 * dropdown. With 100+ partners (many sharing similar names across regions),
 * a searchable combobox with rich row previews is dramatically more usable.
 *
 * Features:
 *   - Fetches partners for the active tenant (limit=500) and caches via
 *     react-query (1-min staleTime so re-opening the popover is instant).
 *   - Debounced (200ms) client-side search across name, email, country,
 *     contact_name, city — broader than the server's name-only `search`.
 *   - Optional `filterType` restricts to partners whose `type` matches
 *     ("supplier", "buyer", "agent", …) — partners typed "both" always pass
 *     through, since they're both a supplier and a buyer.
 *   - Shows name, type, country, email on every row so the user can pick
 *     the right partner at a glance.
 *   - Calls `onSelect(partner | null)` with the full Partner object.
 *   - Optional `allowClear` adds a "No partner" row at the top so users
 *     can unset the value (matches the previous `<Select>` behavior).
 *
 * Pattern mirrors `ProductPicker` so the two pickers feel symmetrical across
 * the trade calculator and other forms.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Search, UserX, Building2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { useDebounced } from "@/lib/hooks/use-debounced";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import type { Partner } from "@/lib/supabase/types";
import { useT } from "@/lib/i18n/store";

export interface PartnerPickerProps {
  /** Currently selected partner_id (controlled). */
  value: string;
  /** Called when the user picks a partner, or null when they clear it. */
  onSelect: (partner: Partner | null) => void;
  /** Restrict the list to a single partner type. Partners typed "both"
   *  always pass through (they're supplier AND buyer). */
  filterType?: "supplier" | "buyer" | "agent" | "logistics" | "customs" | "bank" | "inspector";
  /** When true, includes a "No partner" row at the top so the user can
   *  unset the value. Defaults to true. */
  allowClear?: boolean;
  placeholder?: string;
  /** Displayed on the trigger when `value` isn't in the fetched list yet
   *  (e.g. editing an existing record whose partner is filtered out). */
  fallbackName?: string;
  disabled?: boolean;
  className?: string;
}

/** Case-insensitive contains. */
function ic(haystack: string | null | undefined, needle: string): boolean {
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needle);
}

export function PartnerPicker({
  value,
  onSelect,
  filterType,
  allowClear = true,
  placeholder,
  fallbackName,
  disabled,
  className,
}: PartnerPickerProps) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const debouncedSearch = useDebounced(search, 200);

  // Fetch the full partner list once (limit=500 covers the typical CRM
  // size; combined with client-side search this stays usable).
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["partners", tenantKey, "picker", "500"],
    queryFn: async () => {
      const r = await fetch(api("/api/partners", { limit: 500 }));
      if (!r.ok) throw new Error("Failed to load partners");
      return r.json() as Promise<{ items: Partner[]; total: number }>;
    },
    staleTime: 60_000,
  });

  const allPartners = data?.items || [];

  // 1) Filter by type (advisory: "both" passes through every filter).
  const typeFiltered = React.useMemo(() => {
    if (!filterType) return allPartners;
    return allPartners.filter((p) => {
      const t = (p.type || "").toLowerCase();
      return t === filterType || t === "both";
    });
  }, [allPartners, filterType]);

  // 2) Client-side search across name, email, country, contact, city.
  const filtered = React.useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    if (!q) return typeFiltered;
    return typeFiltered.filter((p) =>
      ic(p.name, q) ||
      ic(p.email, q) ||
      ic(p.country, q) ||
      ic(p.contact_name, q) ||
      ic(p.city, q) ||
      ic(p.tax_id, q) ||
      ic(p.vat_number, q)
    );
  }, [typeFiltered, debouncedSearch]);

  // Trigger display: prefer partner from fetched data; fall back to
  // parent-provided name so editing existing records still shows something.
  const selected = allPartners.find((p) => p.id === value) || null;
  const showName = selected?.name || fallbackName || "";
  const triggerPlaceholder = placeholder || t("crm-no-partner");

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
            "w-full justify-between font-normal h-9 px-3",
            !showName && "text-muted-foreground",
            className
          )}
        >
          {showName ? (
            <span className="flex items-center gap-1.5 min-w-0">
              <Building2 className="size-3.5 text-muted-foreground shrink-0" />
              <span className="truncate text-sm">{showName}</span>
              {selected?.country && (
                <Badge variant="outline" className="text-[10px] h-4 px-1 shrink-0">
                  {selected.country}
                </Badge>
              )}
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <Search className="size-3.5" />
              <span className="text-sm">{triggerPlaceholder}</span>
            </span>
          )}
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[480px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t("crm-search-partners-by")}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-[360px]">
            <CommandEmpty>
              {isLoading || (isFetching && !allPartners.length) ? (
                <span className="flex items-center justify-center gap-1.5">
                  <Search className="size-3.5 animate-spin" />
                  {t("crm-loading-partners")}
                </span>
              ) : (
                <span>
                  {t("crm-no-partners-match").replace("{search}", search)}
                </span>
              )}
            </CommandEmpty>

            {allowClear && (
              <CommandGroup>
                <CommandItem
                  onSelect={() => {
                    onSelect(null);
                    setOpen(false);
                    setSearch("");
                  }}
                  className="text-muted-foreground"
                >
                  <UserX className="size-4" />
                  <span>{t("crm-no-partner")}</span>
                </CommandItem>
              </CommandGroup>
            )}

            <CommandGroup heading={(filterType ? t("crm-partner-type-prefix").replace("{type}", filterType.charAt(0).toUpperCase() + filterType.slice(1)) : t("partners")) + ` (${filtered.length})`}>
              {filtered.map((p) => (
                <PartnerItem
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
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

const PartnerItem = React.memo(function PartnerItem({
  p,
  selected,
  onSelect,
}: {
  p: Partner;
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
          <Badge
            variant="outline"
            className="text-[10px] h-4 px-1 shrink-0"
          >
            {p.type}
          </Badge>
          {p.country && (
            <Badge
              variant="secondary"
              className="text-[10px] h-4 px-1 shrink-0"
            >
              {p.country}
            </Badge>
          )}
        </div>
        {(p.email || p.city || p.contact_name) && (
          <div className="text-[11px] text-muted-foreground flex items-center gap-1.5 mt-0.5 flex-wrap">
            {p.contact_name && <span>{p.contact_name}</span>}
            {p.contact_name && p.email && <span>·</span>}
            {p.email && <span className="truncate">{p.email}</span>}
            {(p.contact_name || p.email) && p.city && <span>·</span>}
            {p.city && <span>{p.city}</span>}
          </div>
        )}
      </div>
    </CommandItem>
  );
});
