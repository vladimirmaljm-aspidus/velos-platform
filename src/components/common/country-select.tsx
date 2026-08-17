"use client";

import * as React from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { COUNTRIES, type Country } from "@/lib/data/geo/countries";

interface CountrySelectProps {
  value: string | null | undefined;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** Disable the control. */
  disabled?: boolean;
  /**
   * Render the trigger at the same height as an Input (h-9) so it lines up
   * with neighbouring form controls. Defaults to true.
   */
  compact?: boolean;
}

/**
 * Searchable country picker with flag + ISO code, backed by the full 394-entry
 * country database in `src/lib/data/geo/countries.ts`.
 *
 * Replaces the old non-searchable `<Select>` that only showed ~40 countries
 * from `src/lib/data/reference.ts`.
 */
export function CountrySelect({
  value,
  onChange,
  placeholder = "Select country",
  className,
  disabled,
  compact = true,
}: CountrySelectProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");

  const filtered = React.useMemo<Country[]>(() => {
    if (!search) return COUNTRIES;
    const q = search.toLowerCase().trim();
    return COUNTRIES.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.code.toLowerCase().includes(q) ||
        c.code3.toLowerCase().includes(q) ||
        c.officialName.toLowerCase().includes(q),
    );
  }, [search]);

  const selected = React.useMemo(
    () => COUNTRIES.find((c) => c.code === value),
    [value],
  );

  function handleSelect(code: string) {
    onChange(code);
    setOpen(false);
    setSearch("");
  }

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
            "w-full justify-between font-normal",
            compact && "h-9",
            !selected && "text-muted-foreground",
            className,
          )}
        >
          {selected ? (
            <span className="flex items-center gap-2 min-w-0">
              <span className="text-base leading-none shrink-0">
                {selected.flag}
              </span>
              <span className="truncate">{selected.name}</span>
              <span className="text-xs text-muted-foreground shrink-0">
                ({selected.code})
              </span>
            </span>
          ) : (
            <span>{placeholder}</span>
          )}
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[350px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search countries…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>No country found.</CommandEmpty>
            <CommandGroup>
              {filtered.map((c) => (
                <CommandItem
                  key={c.code}
                  value={c.code}
                  onSelect={() => handleSelect(c.code)}
                >
                  <Check
                    className={cn(
                      "h-4 w-4",
                      value === c.code ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="text-base mr-1 leading-none">
                    {c.flag}
                  </span>
                  <span className="truncate">{c.name}</span>
                  <span className="text-xs text-muted-foreground ml-auto">
                    {c.code}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
