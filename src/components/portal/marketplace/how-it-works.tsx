"use client";

/**
 * UI-3 step 6 — "How the marketplace works" section.
 *
 * A 3-step explanation:
 *   1. Post what you need (buy or sell)
 *   2. Receive offers from verified companies
 *   3. Negotiate and close the deal
 *
 * Surfaced by `MarketplaceList` when the list is empty (either no posts at
 * all OR no posts match the active filters) so first-time visitors and
 * empty-result searches both get a friendly explanation + a clear CTA.
 * Also reused on the portal dashboard redesign for brand-new accounts.
 */

import { PenLine, BadgeCheck, Handshake, ArrowRight } from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Step {
  icon: React.ComponentType<{ className?: string }>;
  number: number;
  titleKey: string;
  descKey: string;
  /** Tailwind classes for the icon tile background + text color. */
  tile: string;
  ring: string;
}

const STEPS: Step[] = [
  {
    icon: PenLine,
    number: 1,
    titleKey: "how-it-works-step-1-title",
    descKey: "how-it-works-step-1-desc",
    tile: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    ring: "ring-emerald-500/20",
  },
  {
    icon: BadgeCheck,
    number: 2,
    titleKey: "how-it-works-step-2-title",
    descKey: "how-it-works-step-2-desc",
    tile: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
    ring: "ring-sky-500/20",
  },
  {
    icon: Handshake,
    number: 3,
    titleKey: "how-it-works-step-3-title",
    descKey: "how-it-works-step-3-desc",
    tile: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    ring: "ring-amber-500/20",
  },
];

export function HowItWorks({
  onCreateClick,
  className,
  showCta = true,
}: {
  onCreateClick?: () => void;
  className?: string;
  showCta?: boolean;
}) {
  const t = useT();

  return (
    <section
      className={cn(
        "rounded-2xl border border-border/60 bg-card overflow-hidden",
        "shadow-soft relative",
        className,
      )}
    >
      {/* Decorative mesh background — subtle, doesn't impede readability. */}
      <div className="absolute inset-0 bg-mesh-portal opacity-40 pointer-events-none" />
      <div className="absolute -top-12 -right-12 size-40 bg-emerald-500/10 blur-3xl rounded-full pointer-events-none" />

      <div className="relative p-6 sm:p-8">
        <header className="text-center max-w-2xl mx-auto">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
            {t("how-it-works-subtitle")}
          </p>
          <h2 className="text-xl sm:text-2xl font-semibold tracking-tight mt-1.5">
            {t("how-it-works-title")}
          </h2>
        </header>

        <ol className="mt-7 grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6 relative">
          {/* Connecting dashed line between steps (desktop only). */}
          <div
            aria-hidden
            className="hidden md:block absolute top-9 left-[16.67%] right-[16.67%] h-px border-t border-dashed border-border"
          />

          {STEPS.map((step) => {
            const Icon = step.icon;
            return (
              <li
                key={step.number}
                className="relative rounded-xl bg-background/60 backdrop-blur-sm border border-border/40 p-5 text-center"
              >
                <div
                  className={cn(
                    "size-14 mx-auto rounded-2xl flex items-center justify-center ring-1",
                    step.tile,
                    step.ring,
                  )}
                >
                  <Icon className="size-7" />
                </div>
                <div className="mt-3 flex items-center justify-center gap-1.5">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {t("marketplace-wizard-progress").replace("{n}", String(step.number)).replace("{total}", "3")}
                  </span>
                </div>
                <h3 className="text-sm font-semibold mt-1.5">{t(step.titleKey)}</h3>
                <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                  {t(step.descKey)}
                </p>
              </li>
            );
          })}
        </ol>

        {showCta && onCreateClick && (
          <div className="mt-7 text-center">
            <Button onClick={onCreateClick} className="gap-1.5 smooth hover:shadow-soft-md">
              {t("marketplace-empty-cta")}
              <ArrowRight className="size-4" />
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
