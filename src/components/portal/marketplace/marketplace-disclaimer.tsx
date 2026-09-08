"use client";

import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useT } from "@/lib/i18n/store";
import { cn } from "@/lib/utils";

/**
 * MarketplaceDisclaimerBanner — permanent, non-dismissible compliance
 * notice shown at the top of the marketplace feed.
 *
 * Business context: VELOS is a NEUTRAL MEETING POINT — it connects buyers
 * and sellers and never takes part in, guarantees, or insures any
 * transaction. Every member is reminded to run their own due diligence
 * and trade-compliance checks before sending money or goods. The banner
 * links to the full Safety & Compliance panel with the practical
 * checklist (verify the counterparty, use escrow/LC, inspect goods…).
 *
 * The banner is deliberately always visible (NOT dismissible) — this is
 * a platform-protection requirement, not a UX nicety.
 */
export function MarketplaceDisclaimerBanner() {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  return (
    <>
      <div
        role="note"
        aria-live="polite"
        className={cn(
          "rounded-lg border border-amber-300/70 bg-amber-50/80 text-amber-950",
          "dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-100",
        )}
      >
        <div className="flex items-start gap-2.5 p-3 sm:p-4">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-snug">
              {t("marketplace-dd-banner-title")}
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-amber-900/90 dark:text-amber-200/90">
              {t("marketplace-dd-banner-short")}
            </p>

            {expanded && (
              <div className="mt-2 space-y-1.5 text-[13px] leading-relaxed text-amber-900/90 dark:text-amber-200/90">
                <p>{t("marketplace-dd-banner-full")}</p>
              </div>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 border-amber-400/60 bg-transparent px-2.5 text-xs text-amber-900 hover:bg-amber-100 hover:text-amber-950 dark:border-amber-700/60 dark:text-amber-100 dark:hover:bg-amber-900/40"
                onClick={() => setPanelOpen(true)}
              >
                <AlertTriangle className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                {t("marketplace-dd-open-safety")}
              </Button>
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="inline-flex items-center text-xs font-medium text-amber-800 underline-offset-2 hover:underline dark:text-amber-300"
              >
                {expanded ? (
                  <>
                    <ChevronUp className="mr-0.5 h-3.5 w-3.5" aria-hidden="true" />
                    {t("marketplace-dd-show-less")}
                  </>
                ) : (
                  <>
                    <ChevronDown className="mr-0.5 h-3.5 w-3.5" aria-hidden="true" />
                    {t("marketplace-dd-show-more")}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      <SafetyCompliancePanel open={panelOpen} onOpenChange={setPanelOpen} />
    </>
  );
}

/**
 * SafetyCompliancePanel — full-screen (sheet) due-diligence & compliance
 * guide. Opened from the disclaimer banner and from post-detail actions.
 */
export function SafetyCompliancePanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const t = useT();

  const sections: { titleKey: string; bodyKey: string }[] = [
    { titleKey: "marketplace-dd-s1-title", bodyKey: "marketplace-dd-s1-body" },
    { titleKey: "marketplace-dd-s2-title", bodyKey: "marketplace-dd-s2-body" },
    { titleKey: "marketplace-dd-s3-title", bodyKey: "marketplace-dd-s3-body" },
    { titleKey: "marketplace-dd-s4-title", bodyKey: "marketplace-dd-s4-body" },
    { titleKey: "marketplace-dd-s5-title", bodyKey: "marketplace-dd-s5-body" },
    { titleKey: "marketplace-dd-s6-title", bodyKey: "marketplace-dd-s6-body" },
  ];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            {t("marketplace-dd-panel-title")}
          </SheetTitle>
          <SheetDescription>{t("marketplace-dd-panel-subtitle")}</SheetDescription>
        </SheetHeader>

        <div className="px-4 pb-8 space-y-4">
          <p className="rounded-md border border-amber-300/70 bg-amber-50/80 p-3 text-[13px] leading-relaxed text-amber-950 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-100">
            {t("marketplace-dd-panel-liability")}
          </p>

          {sections.map((s) => (
            <section key={s.titleKey}>
              <h3 className="text-sm font-semibold">{t(s.titleKey)}</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground whitespace-pre-line">
                {t(s.bodyKey)}
              </p>
            </section>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
