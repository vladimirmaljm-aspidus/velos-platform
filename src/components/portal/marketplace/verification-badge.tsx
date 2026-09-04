"use client";

import { Badge } from "@/components/ui/badge";
import {
  ShieldCheck,
  Shield,
  Award,
  Crown,
} from "lucide-react";
import { useT } from "@/lib/i18n/store";
import type { MarketplaceVerificationLevel } from "@/lib/supabase/marketplace-profile-types";
import { cn } from "@/lib/utils";

interface VerificationBadgeMeta {
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Tailwind classes for the badge background + text colour. */
  cls: string;
  /** Whether the badge is shown when level is "none". */
  showWhenNone: boolean;
}

const LEVEL_META: Record<MarketplaceVerificationLevel, VerificationBadgeMeta> = {
  none: {
    labelKey: "marketplace-verification-none",
    icon: Shield,
    cls: "border-border bg-muted/40 text-muted-foreground",
    showWhenNone: true,
  },
  bronze: {
    labelKey: "marketplace-verification-bronze",
    icon: ShieldCheck,
    cls: "border-transparent bg-amber-700/15 text-amber-700 dark:text-amber-500",
    showWhenNone: false,
  },
  silver: {
    labelKey: "marketplace-verification-silver",
    icon: ShieldCheck,
    cls: "border-transparent bg-slate-400/20 text-slate-700 dark:text-slate-300",
    showWhenNone: false,
  },
  gold: {
    labelKey: "marketplace-verification-gold",
    icon: Award,
    cls: "border-transparent bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
    showWhenNone: false,
  },
  platinum: {
    labelKey: "marketplace-verification-platinum",
    icon: Crown,
    cls: "border-transparent bg-violet-500/15 text-violet-700 dark:text-violet-300",
    showWhenNone: false,
  },
};

export interface VerificationBadgeProps {
  level: MarketplaceVerificationLevel | string;
  /** Visual size variant — `sm` for cards, `md` (default) for headers, `lg` for hero areas. */
  size?: "sm" | "md" | "lg";
  /** When true, the badge is hidden entirely for level="none" (useful on
   * cards where unverified companies show nothing rather than "Unverified"). */
  hideWhenUnverified?: boolean;
  /** Optional className override applied to the Badge root. */
  className?: string;
}

/**
 * VerificationBadge — renders a coloured badge for the marketplace
 * verification tier (none/bronze/silver/gold/platinum).
 *
 * - "none"    → muted "Unverified" badge (hidden when hideWhenUnverified=true).
 * - "bronze"  → amber.
 * - "silver"  → slate.
 * - "gold"    → yellow with Award icon.
 * - "platinum" → violet with Crown icon.
 *
 * The icon + colour pair is the same set used by MarketplacePostCard +
 * MarketplacePostDetail so the tier reads consistently across every
 * surface where it appears.
 */
export function VerificationBadge({
  level,
  size = "md",
  hideWhenUnverified = false,
  className,
}: VerificationBadgeProps) {
  const t = useT();
  const lvl = (level as MarketplaceVerificationLevel) || "none";
  const meta = LEVEL_META[lvl] ?? LEVEL_META.none;
  if (lvl === "none" && hideWhenUnverified) return null;

  const Icon = meta.icon;
  const iconCls =
    size === "sm" ? "h-3 w-3 mr-1" :
    size === "lg" ? "h-4 w-4 mr-1.5" :
    "h-3.5 w-3.5 mr-1";

  return (
    <Badge variant="outline" className={cn(meta.cls, className)}>
      <Icon className={iconCls} />
      {t(meta.labelKey)}
    </Badge>
  );
}

/**
 * Compact tier icon-only variant — used in tight UI slots (e.g. the
 * post-card header on the marketplace list). Returns a single coloured
 * icon next to a tooltip/title attribute; falls back to NULL when the
 * level is "none" so unverified companies don't get an icon.
 */
export function VerificationIconOnly({
  level,
  className,
}: {
  level: MarketplaceVerificationLevel | string;
  className?: string;
}) {
  const lvl = (level as MarketplaceVerificationLevel) || "none";
  if (lvl === "none") return null;
  const meta = LEVEL_META[lvl];
  const Icon = meta.icon;
  return <Icon className={cn("h-3.5 w-3.5", meta.cls.split(" ").filter((c) => c.startsWith("text-")).join(" "), className)} />;
}
