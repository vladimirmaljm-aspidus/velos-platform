"use client";

import * as React from "react";
import { Search, MapPin, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface AddressPrediction {
  place_id: string;
  description: string;
  main_text: string;
  secondary_text: string;
}

export interface ParsedAddress {
  formatted_address: string;
  street: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  country_code: string;
  lat?: number;
  lng?: number;
}

interface AddressAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  onSelect?: (address: ParsedAddress) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

/**
 * Address input with Google Places Autocomplete.
 *
 * As the user types, it queries /api/places/autocomplete for suggestions.
 * When the user selects a suggestion, it fetches the full address details
 * from /api/places/details and calls onSelect with the parsed address
 * (street, city, state, postal_code, country, country_code, lat, lng).
 *
 * If Google Maps API key is not configured, it falls back to a plain text
 * input (the user can still type the address manually).
 *
 * Usage:
 *   <AddressAutocomplete
 *     value={form.address_line}
 *     onChange={(v) => set("address_line", v)}
 *     onSelect={(addr) => {
 *       set("address_line", addr.street);
 *       set("city", addr.city);
 *       set("state", addr.state);
 *       set("postal_code", addr.postal_code);
 *       set("country", addr.country_code);
 *     }}
 *     placeholder="Start typing your address…"
 *   />
 */
export function AddressAutocomplete({
  value,
  onChange,
  onSelect,
  placeholder = "Start typing your address…",
  className,
  disabled,
}: AddressAutocompleteProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState(value);
  const [predictions, setPredictions] = React.useState<AddressPrediction[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [selectedPlaceId, setSelectedPlaceId] = React.useState<string | null>(null);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync external value changes
  React.useEffect(() => {
// eslint-disable-next-line react-hooks/set-state-in-effect
    setSearch(value);
  }, [value]);

  // Debounced search
  React.useEffect(() => {
    if (search.length < 3 || search === value) {
// eslint-disable-next-line react-hooks/set-state-in-effect
      setPredictions([]);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/places/autocomplete?input=${encodeURIComponent(search)}`);
        const data = await r.json();
        setPredictions(data.predictions || []);
        setOpen(true);
      } catch {
        setPredictions([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search]);

  async function handleSelect(prediction: AddressPrediction) {
    setSelectedPlaceId(prediction.place_id);
    setOpen(false);
    onChange(prediction.description);
    setSearch(prediction.description);

    // Fetch full details
    try {
      const r = await fetch(`/api/places/details?place_id=${prediction.place_id}`);
      const data = await r.json();
      if (data.formatted_address && onSelect) {
        onSelect(data as ParsedAddress);
      }
    } catch {
      // If details fetch fails, the description is still set
    }
    setSelectedPlaceId(null);
  }

  return (
    <Popover open={open && predictions.length > 0} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div className="relative">
          <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
          <Input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              onChange(e.target.value);
            }}
            placeholder={placeholder}
            disabled={disabled}
            className={cn("pl-10", className)}
          />
          {loading && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 size-4 animate-spin text-muted-foreground" />
          )}
          {!loading && search.length >= 3 && (
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          )}
        </div>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <div className="max-h-64 overflow-y-auto">
          {predictions.map((p) => (
            <button
              key={p.place_id}
              type="button"
              onClick={() => handleSelect(p)}
              disabled={selectedPlaceId === p.place_id}
              className="flex w-full items-start gap-2 rounded-sm py-2 px-3 text-sm text-left hover:bg-accent transition-colors disabled:opacity-50"
            >
              <MapPin className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
              <div className="min-w-0">
                <div className="truncate font-medium">{p.main_text}</div>
                <div className="truncate text-xs text-muted-foreground">{p.secondary_text}</div>
              </div>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
