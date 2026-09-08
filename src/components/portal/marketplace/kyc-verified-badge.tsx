"use client";

import { Badge } from "@/components/ui/badge";
import { FileCheck2, FileWarning } from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { cn } from "@/lib/utils";

export interface KycVerifiedBadgeProps {
  /**
   * Whether the poster's KYC is fully approved (partner.kyc_status ===
   * "approved"). Arrives from the API as `poster_kyc_verified` (posts) or
   * `kyc_verified` (company profiles) — a boolean only; no KYC document
   * data is ever exposed.
   */
  verified: boolean | undefined | null;
  /** Visual size variant — `sm` for cards, `md` (default) for headers. */
  size?: "sm" | "md" | "lg";
  /** When true, nothing is rendered for unverified posters (cards). */
  hideWhenUnverified?: boolean;
  className?: string;
}

/**
 * KycVerifiedBadge — trust signal that the poster/client passed the
 * platform's full KYC review (identity + company documents checked by
 * VELOS compliance). Deliberately distinct from the admin-granted
 * VerificationBadge (bronze→platinum): this badge answers "are this
 * client's documents verified", not "how prestigious is the company".
 *
 * - verified=true  → emerald FileCheck2 "KYC Verified" badge.
 * - verified=false → muted FileWarning "KYC not verified" badge, or
 *                    nothing when hideWhenUnverified is set.
 */
export function KycVerifiedBadge({
  verified,
  size = "md",
  hideWhenUnverified = false,
  className,
}: KycVerifiedBadgeProps) {
  const t = useT();
  if (verified !== true && hideWhenUnverified) return null;

  const iconCls =
    size === "sm" ? "h-3 w-3 mr-1" :
    size === "lg" ? "h-4.5 w-4.5 mr-1.5" :
    "h-3.5 w-3.5 mr-1";
  const textCls =
    size === "sm" ? "text-[11px] px-1.5" :
    size === "lg" ? "text-sm px-2.5" :
    "";

  if (verified === true) {
    return (
      <Badge
        variant="outline"
        className={cn(
          "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
          textCls,
          className,
        )}
      >
        <FileCheck2 className={iconCls} aria-hidden="true" />
        {t("marketplace-kyc-verified")}
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className={cn("border-border bg-muted/40 text-muted-foreground", textCls, className)}
    >
      <FileWarning className={iconCls} aria-hidden="true" />
      {t("marketplace-kyc-not-verified")}
    </Badge>
  );
}

/**
 * Icon-only variant for tight slots (post-card header, response rows).
 * Renders the emerald check when verified; returns null otherwise so
 * unverified posters don't occupy card space.
 */
export function KycVerifiedIconOnly({
  verified,
  className,
}: {
  verified: boolean | undefined | null;
  className?: string;
}) {
  const t = useT();
  if (verified !== true) return null;
  return (
    <span
      className={cn("inline-flex items-center text-emerald-600 dark:text-emerald-400", className)}
      title={t("marketplace-kyc-verified")}
    >
      <FileCheck2 className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="sr-only">{t("marketplace-kyc-verified")}</span>
    </span>
  );
}
