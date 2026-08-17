"use client";

import { ReactNode } from "react";
import { cn } from "@/lib/utils";

/* ─── EmptyState ───────────────────────────────────────────────────────── */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        /* Container — gradient border card with dashed fallback */
        "border-gradient relative overflow-hidden rounded-xl",
        "animate-fade-in",
        className,
      )}
    >
      {/* Dashed inner border overlay for visual depth */}
      <div
        className={cn(
          "m-[1px] rounded-[calc(var(--radius-xl)-1px)]",
          "bg-card",
          "border border-dashed border-border/60",
          "flex flex-col items-center justify-center text-center",
          "py-16 px-6 sm:py-20 sm:px-8",
        )}
      >
        {/* ── Icon Container ──────────────────────────────────── */}
        {icon && (
          <div
            className={cn(
              "relative mb-6",
              "size-16 sm:size-20 rounded-2xl",
              "bg-gradient-to-br from-emerald-500/10 via-teal-500/8 to-cyan-500/5",
              "dark:from-emerald-500/15 dark:via-teal-500/10 dark:to-cyan-500/8",
              "flex items-center justify-center",
              "text-emerald-600 dark:text-emerald-400",
              /* Subtle float animation */
              "animate-[float_3s_ease-in-out_infinite]",
            )}
          >
            {/* Soft glow behind the icon */}
            <div
              className={cn(
                "absolute inset-0 rounded-2xl",
                "bg-emerald-500/5 dark:bg-emerald-500/8",
                "blur-xl scale-125",
              )}
            />

            <div className="relative z-10 [&>svg]:size-7 sm:[&>svg]:size-8">
              {icon}
            </div>
          </div>
        )}

        {/* ── Title ───────────────────────────────────────────── */}
        <h3 className="text-base font-semibold text-foreground tracking-tight">
          {title}
        </h3>

        {/* ── Description ─────────────────────────────────────── */}
        {description && (
          <p className="mt-2 text-sm text-muted-foreground leading-relaxed max-w-sm">
            {description}
          </p>
        )}

        {/* ── CTA ─────────────────────────────────────────────── */}
        {action && <div className="mt-6">{action}</div>}
      </div>
    </div>
  );
}
