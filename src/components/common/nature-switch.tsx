"use client";

import { Package, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/store";
import type { DocumentNature } from "@/lib/supabase/types";

/**
 * NatureSwitch — the goods vs services document selector.
 *
 * Shown at the very top of the offer / proforma / invoice form dialogs so
 * the user picks the document's NATURE before anything else. The choice
 * drives the whole form:
 *
 *   goods    → the classic trade flow (product picker with HS codes,
 *              origin, incoterms, POL/POD, vessel, container, packaging)
 *   services → the services flow (free-text service lines with their own
 *              period, time-based units, place of service; no HS / origin /
 *              shipping fields anywhere)
 *
 * Renders as two large selectable cards (48px+ touch targets) rather than a
 * tiny radio — this is a first-class business decision, not a detail.
 */
export function NatureSwitch({
  value,
  onChange,
  disabled,
  className,
}: {
  value: DocumentNature;
  onChange: (nature: DocumentNature) => void;
  disabled?: boolean;
  className?: string;
}) {
  const t = useT();
  const options: Array<{
    value: DocumentNature;
    label: string;
    desc: string;
    icon: typeof Package;
  }> = [
    {
      value: "goods",
      label: t("fin-nature-goods"),
      desc: t("fin-nature-goods-desc"),
      icon: Package,
    },
    {
      value: "services",
      label: t("fin-nature-services"),
      desc: t("fin-nature-services-desc"),
      icon: Wrench,
    },
  ];

  return (
    <div
      role="radiogroup"
      aria-label={t("fin-nature-label")}
      className={cn("grid grid-cols-2 gap-2", className)}
    >
      {options.map((opt) => {
        const selected = value === opt.value;
        const Icon = opt.icon;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={cn(
              "group flex items-start gap-3 rounded-lg border p-3 text-left transition-all min-h-[64px]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              selected
                ? "border-primary bg-primary/5 shadow-sm"
                : "border-border/70 bg-card hover:border-border hover:bg-muted/40",
              disabled && "opacity-60 cursor-not-allowed",
            )}
          >
            <span
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-md border",
                selected
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border/60 bg-muted/50 text-muted-foreground",
              )}
            >
              <Icon className="size-4.5" />
            </span>
            <span className="min-w-0">
              <span
                className={cn(
                  "block text-sm font-medium leading-tight",
                  selected ? "text-foreground" : "text-foreground/90",
                )}
              >
                {opt.label}
              </span>
              <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                {opt.desc}
              </span>
            </span>
            <span
              aria-hidden
              className={cn(
                "ml-auto mt-0.5 size-2 shrink-0 rounded-full border transition-colors",
                selected ? "border-primary bg-primary" : "border-muted-foreground/30 bg-transparent",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}

/** Tiny inline badge showing a document's nature (list rows, detail headers). */
export function NatureBadge({
  nature,
  className,
}: {
  nature: DocumentNature | string | null | undefined;
  className?: string;
}) {
  const t = useT();
  const isServices = nature === "services";
  const Icon = isServices ? Wrench : Package;
  return (
    <span
      title={isServices ? t("fin-nature-services") : t("fin-nature-goods")}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none whitespace-nowrap",
        isServices
          ? "border-teal-500/40 bg-teal-500/10 text-teal-700 dark:text-teal-300"
          : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        className,
      )}
    >
      <Icon className="size-2.5" />
      {isServices ? t("fin-nature-badge-services") : t("fin-nature-badge-goods")}
    </span>
  );
}
