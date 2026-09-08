"use client";

/**
 * Task 2-c — "How the marketplace works" explainer, rebuilt as a
 * professional 4-stage trade-lifecycle walkthrough (the old 3-step
 * "post → offers → negotiate" version stopped at the negotiation and
 * never showed the rest of the funnel):
 *
 *   1. Browse & analyze   → marketplace feed + intelligence
 *   2. Connect & negotiate → private negotiation rooms
 *   3. Deal room           → documents + payment instruments
 *   4. Ship & track        → logistics
 *
 * Every stage carries a real CTA that navigates the SPA (setView), so the
 * explainer doubles as in-product wayfinding — not just marketing copy.
 *
 * Surfaced by `MarketplaceList` when the list is empty, by the portal
 * dashboard for brand-new accounts, and inside the MarketplaceBrowser's
 * "How it works" dialog (hideHeader — the dialog supplies the title).
 */

import { Search, MessagesSquare, FileSignature, Truck, ArrowRight } from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { Button } from "@/components/ui/button";
import { useAppStore, type ViewKey } from "@/lib/store/app-store";
import { cn } from "@/lib/utils";

interface Stage {
  icon: React.ComponentType<{ className?: string }>;
  number: number;
  titleKey: string;
  descKey: string;
  ctaKey: string;
  /** SPA view the stage CTA navigates to. */
  ctaView: ViewKey;
  /** Tailwind classes for the icon tile background + text color. */
  tile: string;
  ring: string;
}

const STAGES: Stage[] = [
  {
    icon: Search,
    number: 1,
    titleKey: "marketplace-how-stage1-title",
    descKey: "marketplace-how-stage1-desc",
    ctaKey: "marketplace-how-cta-browse",
    ctaView: "portal-marketplace",
    tile: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    ring: "ring-emerald-500/20",
  },
  {
    icon: MessagesSquare,
    number: 2,
    titleKey: "marketplace-how-stage2-title",
    descKey: "marketplace-how-stage2-desc",
    ctaKey: "marketplace-how-cta-negotiate",
    ctaView: "portal-marketplace-negotiations",
    tile: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    ring: "ring-amber-500/20",
  },
  {
    icon: FileSignature,
    number: 3,
    titleKey: "marketplace-how-stage3-title",
    descKey: "marketplace-how-stage3-desc",
    ctaKey: "marketplace-how-cta-deal",
    // The deal room lives inside the negotiations surface (accepted rooms).
    ctaView: "portal-marketplace-negotiations",
    tile: "bg-primary/10 text-primary",
    ring: "ring-primary/20",
  },
  {
    icon: Truck,
    number: 4,
    titleKey: "marketplace-how-stage4-title",
    descKey: "marketplace-how-stage4-desc",
    ctaKey: "marketplace-how-cta-ship",
    ctaView: "portal-logistics",
    tile: "bg-teal-500/10 text-teal-700 dark:text-teal-400",
    ring: "ring-teal-500/20",
  },
];

export function HowItWorks({
  onCreateClick,
  className,
  showCta = true,
  hideHeader = false,
  onNavigate,
}: {
  onCreateClick?: () => void;
  className?: string;
  showCta?: boolean;
  /** Dialog usage: the dialog supplies its own title/description — hide
   *  the section header so it isn't rendered twice. */
  hideHeader?: boolean;
  /** Dialog usage: fired after a stage CTA navigates, so the hosting
   *  dialog can close itself instead of lingering over the target view. */
  onNavigate?: () => void;
}) {
  const t = useT();
  const setView = useAppStore((s) => s.setView);

  return (
    <section
      className={cn(
        "@container rounded-2xl border border-border/60 bg-card overflow-hidden",
        "shadow-soft relative",
        className,
      )}
    >
      {/* Decorative mesh background — subtle, doesn't impede readability. */}
      <div className="absolute inset-0 bg-mesh-portal opacity-40 pointer-events-none" />

      <div className="relative p-6 sm:p-8">
        {!hideHeader && (
          <header className="text-center max-w-2xl mx-auto">
            <p className="text-sm text-muted-foreground">
              {t("how-it-works-subtitle")}
            </p>
            <h2 className="text-xl sm:text-2xl font-semibold tracking-tight mt-1.5">
              {t("how-it-works-title")}
            </h2>
          </header>
        )}

        <ol
          className={cn(
            // Container-query grid (not viewport breakpoints) so the same
            // component lays out correctly at full page width (4 stages in
            // a row) AND inside the max-w-3xl "How it works" dialog (2×2).
            "grid grid-cols-1 @md:grid-cols-2 @3xl:grid-cols-4 gap-4 relative",
            !hideHeader && "mt-7",
          )}
        >
          {/* Connecting dashed line between the stage tiles (only when the
              four stages sit in a single row — @3xl container). The cards
              are opaque, so the line only shows in the gaps between them. */}
          <div
            aria-hidden
            className="hidden @3xl:block absolute top-11 left-[68px] right-[68px] h-px border-t border-dashed border-border"
          />

          {STAGES.map((stage) => {
            const Icon = stage.icon;
            return (
              <li
                key={stage.number}
                className="group relative rounded-xl bg-background border border-border/40 p-5 transition-colors hover:border-primary/40"
              >
                <div className="flex items-start justify-between gap-2">
                  <div
                    className={cn(
                      "size-12 rounded-xl flex items-center justify-center ring-1",
                      stage.tile,
                      stage.ring,
                    )}
                  >
                    <Icon className="size-6" />
                  </div>
                  {/* Numbered badge — implies the stage order at a glance. */}
                  <span
                    aria-hidden
                    className="size-6 rounded-full bg-muted border border-border/60 text-xs font-semibold text-muted-foreground flex items-center justify-center tabular"
                  >
                    {stage.number}
                  </span>
                  <span className="sr-only">
                    {t("marketplace-wizard-progress")
                      .replace("{n}", String(stage.number))
                      .replace("{total}", String(STAGES.length))}
                  </span>
                </div>
                <h3 className="text-sm font-semibold mt-4">{t(stage.titleKey)}</h3>
                <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
                  {t(stage.descKey)}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-4 w-full sm:w-auto gap-1.5 rounded-full group-hover:border-primary/40 group-hover:text-primary"
                  onClick={() => {
                    setView(stage.ctaView);
                    onNavigate?.();
                  }}
                >
                  {t(stage.ctaKey)}
                  <ArrowRight className="size-3.5" />
                </Button>
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
