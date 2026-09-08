"use client";

import { LockKeyhole, ShieldCheck, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/store";
import { useAppStore } from "@/lib/store/app-store";
import { cn } from "@/lib/utils";

export type LockReason = "tier" | "kyc";

export interface CommunicationLockedCardProps {
  reason: LockReason;
  /**
   * Where the card is rendered — picks the right explainer copy:
   *   • browser   → general marketplace notice (above the tabs)
   *   • respond   → post-detail respond form
   *   • negotiate → negotiation room composer
   *   • bid       → auction bid box
   *   • qa        → Q&A / review forms
   */
  context?: "browser" | "respond" | "negotiate" | "bid" | "qa";
  className?: string;
}

/**
 * CommunicationLockedCard — rendered INSTEAD of an actionable form when
 * the client's tier / KYC status doesn't meet the marketplace
 * communication policy. Mirrors the server-side marketplace-gate rules:
 *   • tier    → basic/limited can browse but must upgrade to Standard+.
 *   • kyc     → Standard+ requires a fully approved KYC review.
 *
 * Mirrors error codes `tier_insufficient` / `kyc_required` from
 * requireMarketplaceCommunicator() so UI and API never disagree.
 */
export function CommunicationLockedCard({
  reason,
  context = "browser",
  className,
}: CommunicationLockedCardProps) {
  const t = useT();
  const setView = useAppStore((s) => s.setView);

  const titleKey =
    reason === "tier" ? "marketplace-locked-tier-title" : "marketplace-locked-kyc-title";
  const bodyKey =
    reason === "tier"
      ? context === "browser"
        ? "marketplace-locked-tier-body"
        : `marketplace-locked-tier-body-${context}`
      : context === "browser"
        ? "marketplace-locked-kyc-body"
        : `marketplace-locked-kyc-body-${context}`;

  return (
    <div
      role="status"
      className={cn(
        "flex flex-col items-start gap-3 rounded-lg border border-dashed border-border bg-muted/40 p-4 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <div className="rounded-md bg-muted p-2">
          <LockKeyhole className="h-4.5 w-4.5 text-muted-foreground" aria-hidden="true" />
        </div>
        <div>
          <p className="text-sm font-semibold flex items-center gap-1.5">
            {t(titleKey)}
          </p>
          <p className="mt-0.5 max-w-prose text-[13px] leading-relaxed text-muted-foreground">
            {t(bodyKey)}
          </p>
        </div>
      </div>

      {reason === "tier" ? (
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => {
            // Portal clients cannot open the CRM plan-upgrade queue — that
            // is a super-admin view. Point them to the portal messages
            // channel instead, where they can request a tier upgrade from
            // their account provider.
            setView("portal-messages");
          }}
        >
          {t("marketplace-locked-upgrade-cta")}
          <ArrowUpRight className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => setView("portal-kyc")}
        >
          <ShieldCheck className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          {t("marketplace-locked-kyc-cta")}
        </Button>
      )}
    </div>
  );
}
