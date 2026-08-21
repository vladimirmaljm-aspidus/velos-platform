"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/store";

export interface BulkAction {
  key: string;
  label: string;
  icon?: React.ReactNode;
  variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
  onClick: () => void | Promise<void>;
  disabled?: boolean;
  confirm?: string; // if set, shows a native confirm() with this text
}

interface BulkActionBarProps {
  count: number;
  onClear: () => void;
  actions: BulkAction[];
  label?: string;
  className?: string;
}

/**
 * Fixed-bottom bulk action bar. Appears when `count > 0`.
 * Actions run sequentially — if any throws, subsequent actions still run.
 */
export function BulkActionBar({
  count,
  onClear,
  actions,
  label,
  className,
}: BulkActionBarProps) {
  const t = useT();
  const selectedLabel = label || t("misc-bulk-selected");
  if (count <= 0) return null;

  return (
    <div
      className={cn(
        "fixed left-1/2 -translate-x-1/2 bottom-4 z-40",
        "flex items-center gap-2 rounded-full border border-border/60 bg-card shadow-lg px-3 py-2",
        "backdrop-blur supports-[backdrop-filter]:bg-card/95",
        className,
      )}
      role="region"
      aria-label={t("misc-bulk-actions-aria")}
    >
      <span className="text-sm font-medium tabular-nums px-1">
        {count} {selectedLabel}
      </span>
      <div className="h-5 w-px bg-border/60 mx-1" />
      {actions.map((a) => (
        <Button
          key={a.key}
          size="sm"
          variant={a.variant || "outline"}
          disabled={a.disabled}
          onClick={async () => {
            if (a.confirm && !window.confirm(a.confirm)) return;
            await a.onClick();
          }}
        >
          {a.icon}
          {a.icon ? <span className="ml-1">{a.label}</span> : a.label}
        </Button>
      ))}
      <div className="h-5 w-px bg-border/60 mx-1" />
      <Button
        size="icon"
        variant="ghost"
        className="size-7 rounded-full"
        onClick={onClear}
        aria-label={t("misc-bulk-clear-selection")}
        title={t("misc-bulk-clear-selection")}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}

/** Helper hook that manages a Set of selected row IDs. */
export function useRowSelection<T extends { id: string }>(items: T[]) {
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  const clear = React.useCallback(() => setSelected(new Set()), []);

  const toggle = React.useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allOnPageSelected = items.length > 0 && items.every((i) => selected.has(i.id));
  const someOnPageSelected = items.some((i) => selected.has(i.id));

  const toggleAllOnPage = React.useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (items.every((i) => next.has(i.id))) {
        items.forEach((i) => next.delete(i.id));
      } else {
        items.forEach((i) => next.add(i.id));
      }
      return next;
    });
  }, [items]);

  // Prune IDs that dropped out of the current dataset (e.g. after delete).
  React.useEffect(() => {
// eslint-disable-next-line react-hooks/set-state-in-effect
    setSelected((prev) => {
      const ids = new Set(items.map((i) => i.id));
      const next = new Set<string>();
      let changed = false;
      for (const id of prev) {
        if (ids.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [items]);

  return {
    selected,
    setSelected,
    clear,
    toggle,
    toggleAllOnPage,
    allOnPageSelected,
    someOnPageSelected,
    count: selected.size,
    isSelected: (id: string) => selected.has(id),
    ids: Array.from(selected),
  };
}
