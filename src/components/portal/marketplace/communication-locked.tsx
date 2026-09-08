"use client";

import { LockKeyhole, ShieldCheck, ArrowUpRight, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/store";
import { useAppStore } from "@/lib/store/app-store";
import { cn } from "@/lib/utils";
import type { MarketplaceBlockReason } from "@/lib/portal/use-marketplace-permissions";

export type LockReason = Exclude<MarketplaceBlockReason, null>;

export interface CommunicationLockedCardProps {
  reason: LockReason;
  /**
   * Where the card is rendered — picks the right explainer copy:
   *   • browser   → general marketplace notice (above the tabs)
   *   • respond   → post-detail respond form
   *   • negotiate → negotiation room composer
   *   • bid       → auction bid box
   *   • qa        → Q&A / review forms
   *   (only the tier/kyc reasons carry per-context copy; the policy-level
   *   reasons below render the same message everywhere.)
   */
  context?: "browser" | "respond" | "negotiate" | "bid" | "qa";
  className?: string;
}

/** Copy + CTA per lock reason — mirrors the server marketplace-gate codes
 *  (tier_insufficient / kyc_required / posting_admins_only /
 *  marketplace_disabled / module_disabled) so UI and API never disagree. */
function lockCopy(
  reason: LockReason,
  context: NonNullable<CommunicationLockedCardProps["context"]>,
): { titleKey: string; bodyKey: string; cta: "upgrade" | "kyc" | "contact" | null } {
  switch (reason) {
    case "tier":
      return {
        titleKey: "marketplace-locked-tier-title",
        bodyKey:
          context === "browser"
            ? "marketplace-locked-tier-body"
            : `marketplace-locked-tier-body-${context}`,
        cta: "upgrade",
      };
    case "kyc":
      return {
        titleKey: "marketplace-locked-kyc-title",
        bodyKey:
          context === "browser"
            ? "marketplace-locked-kyc-body"
            : `marketplace-locked-kyc-body-${context}`,
        cta: "kyc",
      };
    case "admins_only":
      // posting_policy = admins_only — the tenant admin manages every
      // listing; portal clients cannot post/respond/negotiate at all.
      return {
        titleKey: "marketplace-locked-admins-title",
        bodyKey: "marketplace-locked-admins-body",
        cta: "contact",
      };
    case "marketplace_disabled":
      // The tenant's marketplace switch is off — reuses the same keys the
      // feed's 403 error card renders (099).
      return {
        titleKey: "marketplace-disabled-title",
        bodyKey: "marketplace-disabled-desc",
        cta: null,
      };
    case "module":
      // Per-user/per-tenant module permission denied (module_disabled).
      return {
        titleKey: "marketplace-locked-module-title",
        bodyKey: "marketplace-locked-module-body",
        cta: null,
      };
  }
}

/**
 * CommunicationLockedCard — rendered INSTEAD of an actionable form when
 * the client doesn't meet the marketplace communication policy.
 *
 * Mirrors the server-side marketplace-gate rules:
 *   • tier                → basic/limited can browse but must upgrade.
 *   • kyc                 → KYC review must be fully approved.
 *   • admins_only         → posting is restricted to tenant admins.
 *   • marketplace_disabled→ the tenant switch is off for everyone.
 *   • module              → the marketplace module is denied for the user.
 */
export function CommunicationLockedCard({
  reason,
  context = "browser",
  className,
}: CommunicationLockedCardProps) {
  const t = useT();
  const setView = useAppStore((s) => s.setView);
  const copy = lockCopy(reason, context);

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
            {t(copy.titleKey)}
          </p>
          <p className="mt-0.5 max-w-prose text-[13px] leading-relaxed text-muted-foreground">
            {t(copy.bodyKey)}
          </p>
        </div>
      </div>

      {copy.cta === "upgrade" ? (
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
      ) : copy.cta === "kyc" ? (
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => setView("portal-kyc")}
        >
          <ShieldCheck className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          {t("marketplace-locked-kyc-cta")}
        </Button>
      ) : copy.cta === "contact" ? (
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => {
            // Contact request → the portal messages channel (the client
            // cannot reach the admin console).
            setView("portal-messages");
          }}
        >
          <MessageCircle className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          {t("marketplace-locked-contact-cta")}
        </Button>
      ) : null}
    </div>
  );
}
