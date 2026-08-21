"use client";

import * as React from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface PageSizeSelectorProps {
  value: number;
  onChange: (n: number) => void;
  options?: number[];
  label?: string;
  className?: string;
}

/**
 * Compact "Rows per page" selector shown in table footers.
 * Stateless — pair with `usePageSize` for persistence.
 */
export function PageSizeSelector({
  value,
  onChange,
  options = [10, 20, 50, 100, 200, 500],
  label = "Rows per page",
  className,
}: PageSizeSelectorProps) {
  return (
    <div className={`flex items-center gap-2 text-xs text-muted-foreground ${className || ""}`}>
      <span className="whitespace-nowrap">{label}</span>
      <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
        <SelectTrigger className="h-7 w-[76px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((n) => (
            <SelectItem key={n} value={String(n)} className="text-xs">
              {n}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
