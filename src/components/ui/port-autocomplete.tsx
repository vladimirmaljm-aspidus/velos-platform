"use client";

import * as React from "react";
import { Anchor, Loader2, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface PortOption {
  name: string;
  country: string;
  countryCode: string;
  unlocode: string;
  region: string;
}

interface PortAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  className?: string;
  disabled?: boolean;
}

/**
 * Port autocomplete input — searches our embedded World Port Index
 * (120+ major ports) as the user types.
 *
 * When a port is selected, the input shows just the port name (e.g. "Jebel Ali").
 * The dropdown shows: port name, country, UN/LOCODE.
 *
 * No API key needed — uses our embedded port data.
 */
export function PortAutocomplete({
  value,
  onChange,
  placeholder = "Start typing port name…",
  label,
  className,
  disabled,
}: PortAutocompleteProps) {
  const [search, setSearch] = React.useState(value);
  const [open, setOpen] = React.useState(false);
  const [results, setResults] = React.useState<PortOption[]>([]);
  const [loading, setLoading] = React.useState(false);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
// eslint-disable-next-line react-hooks/set-state-in-effect
    setSearch(value);
  }, [value]);

  // Debounced search against our ports API
  React.useEffect(() => {
    if (search.length < 2 || search === value) {
// eslint-disable-next-line react-hooks/set-state-in-effect
      setResults([]);
      setOpen(false);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/integrations/ports?q=${encodeURIComponent(search)}&limit=10`);
        const data = await r.json();
        setResults(data.items || []);
        setOpen((data.items || []).length > 0);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search]);

  function handleSelect(port: PortOption) {
    onChange(port.name);
    setSearch(port.name);
    setOpen(false);
  }

  return (
    <div className="space-y-1.5">
      {label && <Label>{label}</Label>}
      <Popover open={open && results.length > 0} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <div className="relative">
            <Anchor className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
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
          </div>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
          <div className="max-h-64 overflow-y-auto">
            {results.map((port) => (
              <button
                key={port.unlocode}
                type="button"
                onClick={() => handleSelect(port)}
                className="flex w-full items-start gap-2 rounded-sm py-2 px-3 text-sm text-left hover:bg-accent transition-colors"
              >
                <Anchor className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="truncate font-medium">{port.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {port.country} · {port.unlocode} · {port.region}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

import { Label } from "@/components/ui/label";
