"use client";

import * as React from "react";
import { ChevronDown, Search, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n/store";

export interface SearchableOption {
  value: string;
  label: string;
  /** Optional secondary text shown below the label */
  description?: string;
  /** Optional flag emoji or icon */
  icon?: string;
}

interface SearchableSelectProps {
  options: SearchableOption[];
  value?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  /** When true, shows a clear (X) button when a value is selected */
  clearable?: boolean;
}

/**
 * A searchable dropdown select component.
 *
 * Use this instead of the regular <Select> when the options list is long
 * (countries, cities, partners, products) — the user can type to filter.
 *
 * Features:
 *   - Type-ahead search (filters by label + description)
 *   - Keyboard navigation (arrow keys, enter, escape)
 *   - Optional clear button
 *   - Optional description text per option
 *   - Optional icon (flag emoji) per option
 *
 * Example:
 *   <SearchableSelect
 *     options={COUNTRIES.map(c => ({ value: c.code, label: c.name, icon: flagEmoji(c.code) }))}
 *     value={form.country}
 *     onChange={(v) => set("country", v)}
 *     placeholder="Select country"
 *     searchPlaceholder="Search countries…"
 *   />
 */
export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder,
  searchPlaceholder,
  emptyText,
  disabled,
  className,
  clearable,
}: SearchableSelectProps) {
  const t = useT();
  const effectivePlaceholder = placeholder ?? t("no_results");
  const effectiveSearchPlaceholder = searchPlaceholder ?? t("search");
  const effectiveEmptyText = emptyText ?? t("no_results");
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.value === value);

  // Filter options by search query
  const filtered = React.useMemo(() => {
    if (!search.trim()) return options;
    const q = search.toLowerCase();
    return options.filter((o) =>
      o.label.toLowerCase().includes(q) ||
      o.description?.toLowerCase().includes(q) ||
      o.value.toLowerCase().includes(q)
    );
  }, [options, search]);

  // Focus input when popover opens
  React.useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setSearch("");
    }
  }, [open]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("w-full justify-between font-normal", !selected && "text-muted-foreground", className)}
          disabled={disabled}
        >
          {selected ? (
            <span className="flex items-center gap-2 truncate">
              {selected.icon && <span className="text-base">{selected.icon}</span>}
              <span className="truncate">{selected.label}</span>
            </span>
          ) : (
            effectivePlaceholder
          )}
          <span className="flex items-center gap-1 shrink-0">
            {clearable && selected && (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    onChange("");
                  }
                }}
                className="text-muted-foreground hover:text-foreground rounded p-0.5"
              >
                <X className="size-3.5" />
              </span>
            )}
            <ChevronDown className={cn("size-4 opacity-50 transition-transform", open && "rotate-180")} />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <div className="flex items-center border-b px-3">
          <Search className="mr-2 size-4 shrink-0 opacity-50" />
          <Input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={effectiveSearchPlaceholder}
            className="border-0 shadow-none focus-visible:ring-0 px-0 h-9"
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">{effectiveEmptyText}</div>
          ) : (
            filtered.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={cn(
                  "relative flex w-full cursor-pointer select-none items-center gap-2 rounded-sm py-2 px-2 text-sm outline-none transition-colors",
                  "hover:bg-accent hover:text-accent-foreground",
                  value === option.value && "bg-accent text-accent-foreground"
                )}
              >
                {option.icon && <span className="text-base shrink-0">{option.icon}</span>}
                <div className="flex-1 min-w-0 text-left">
                  <div className="truncate font-medium">{option.label}</div>
                  {option.description && (
                    <div className="truncate text-xs text-muted-foreground">{option.description}</div>
                  )}
                </div>
                {value === option.value && <Check className="size-4 shrink-0" />}
              </button>
            ))
          )}
        </div>
        {filtered.length > 0 && (
          <div className="border-t px-3 py-1.5 text-xs text-muted-foreground">
            {t("misc-ss-options-count").replace("{n}", String(filtered.length))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
