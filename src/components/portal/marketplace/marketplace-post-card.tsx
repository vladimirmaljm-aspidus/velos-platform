"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Eye,
  MessageSquare,
  MapPin,
  ShieldCheck,
  Clock,
  TrendingUp,
  TrendingDown,
  Gavel,
  FileText,
  Package,
  CheckCircle2,
} from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { fmtMoney, fmtRelative } from "@/lib/utils/format";
import { getCountry } from "@/lib/data/geo/countries";
import { cn } from "@/lib/utils";
import type { MarketplacePostType } from "@/lib/supabase/marketplace-types";
import { RiskBadge } from "./risk-badge";

export interface MarketplacePostCardData {
  id: string;
  post_type: MarketplacePostType;
  product_name: string;
  product_category: string | null;
  quantity: number;
  unit: string;
  target_price: number | null;
  price_max: number | null;
  price_visible: boolean;
  price_type: string;
  currency: string;
  delivery_location: string | null;
  delivery_country: string | null;
  is_verified: boolean;
  verification_level: string;
  views_count: number;
  responses_count: number;
  expires_at: string | null;
  created_at: string;
}

/**
 * UI-3 step 2 — type → badge meta. Buy = green (real green, distinct from
 * the copper emerald remap which we reserve for sell). Sell = copper
 * (emerald-* in our palette). Auction = amber, Contract = violet.
 */
const TYPE_META: Record<
  MarketplacePostType,
  { labelKey: string; icon: React.ComponentType<{ className?: string }>; badge: string; tile: string }
> = {
  buy: {
    labelKey: "marketplace-buy",
    icon: TrendingUp,
    badge: "border-transparent bg-green-500/15 text-green-700 dark:text-green-400",
    tile: "bg-green-500/10 text-green-700 dark:text-green-400",
  },
  sell: {
    labelKey: "marketplace-sell",
    icon: TrendingDown,
    badge: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    tile: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  auction: {
    labelKey: "marketplace-auction",
    icon: Gavel,
    badge: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",
    tile: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  contract: {
    labelKey: "marketplace-contract",
    icon: FileText,
    badge: "border-transparent bg-violet-500/15 text-violet-700 dark:text-violet-400",
    tile: "bg-violet-500/10 text-violet-700 dark:text-violet-400",
  },
};

/** Category code → emoji-ish product icon fallback tile color. Used by the
 *  product image placeholder so different categories get a distinct tint. */
const CATEGORY_TILE: Record<string, string> = {
  AGRI: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  FOOD: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  SUGAR: "bg-pink-500/10 text-pink-700 dark:text-pink-400",
  GRAIN: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400",
  OIL: "bg-lime-500/10 text-lime-700 dark:text-lime-400",
  METAL: "bg-slate-500/10 text-slate-700 dark:text-slate-300",
  CHEM: "bg-violet-500/10 text-violet-700 dark:text-violet-400",
  CMT: "bg-stone-500/10 text-stone-700 dark:text-stone-300",
  ENERGY: "bg-red-500/10 text-red-700 dark:text-red-400",
  TEXTILE: "bg-teal-500/10 text-teal-700 dark:text-teal-400",
  MACHINERY: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  PACKAGING: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-400",
  OTHER: "bg-muted text-muted-foreground",
};

function categoryTile(code: string | null): string {
  if (code && CATEGORY_TILE[code]) return CATEGORY_TILE[code];
  return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
}

/** Country flag emoji from ISO code; falls back to 🌐. */
function flagEmoji(code: string | null | undefined): string {
  if (!code) return "🌐";
  const c = getCountry(code);
  return c?.flag || "🌐";
}

export function MarketplacePostCard({
  post,
  onClick,
}: {
  post: MarketplacePostCardData;
  onClick?: (id: string) => void;
}) {
  const t = useT();
  const meta = TYPE_META[post.post_type] ?? TYPE_META.sell;
  const TypeIcon = meta.icon;
  const country = post.delivery_country
    ? getCountry(post.delivery_country)
    : null;
  const flag = flagEmoji(post.delivery_country);

  function fmtPrice(): string {
    if (!post.price_visible || post.price_type === "on_request") {
      return t("marketplace-price-on-request");
    }
    if (post.price_type === "range" && post.target_price != null && post.price_max != null) {
      return `${fmtMoney(post.target_price, post.currency)} – ${fmtMoney(post.price_max, post.currency)}`;
    }
    if (post.target_price != null) {
      return fmtMoney(post.target_price, post.currency);
    }
    return t("marketplace-price-on-request");
  }

  function fmtUnitLabel(): string {
    return post.unit;
  }

  return (
    <Card
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.(post.id);
        }
      }}
      className="cursor-pointer transition-all hover:shadow-soft-md hover:border-primary/40 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 group overflow-hidden"
      onClick={() => onClick?.(post.id)}
    >
      <CardContent className="p-0">
        {/* Header strip — product image placeholder (left) + type badge (right). */}
        <div className="relative h-24 sm:h-28 bg-gradient-to-br from-muted/40 to-muted/10 overflow-hidden">
          {/* Category-tinted product icon */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div
              className={cn(
                "size-12 rounded-xl flex items-center justify-center shadow-soft",
                categoryTile(post.product_category),
              )}
            >
              <Package className="size-6" />
            </div>
          </div>
          {/* Type badge (top-left) */}
          <div className="absolute top-2.5 left-2.5">
            <Badge variant="outline" className={cn("gap-1 font-medium", meta.badge)}>
              <TypeIcon className="size-3" />
              {t(meta.labelKey)}
            </Badge>
          </div>
          {/* Verified badge (top-right) */}
          {post.is_verified && (
            <div className="absolute top-2.5 right-2.5">
              <Badge
                variant="outline"
                className="gap-1 border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 backdrop-blur-sm"
                title={t(`marketplace-verification-${post.verification_level}`)}
              >
                <CheckCircle2 className="size-3" />
                {t("marketplace-card-verified")}
              </Badge>
            </div>
          )}
          {/* Country flag emoji (bottom-right) */}
          {country && (
            <div
              className="absolute bottom-2 right-2.5 text-lg leading-none"
              title={country.name}
            >
              <span>{flag}</span>
            </div>
          )}
        </div>

        {/* Body */}
        <div className="p-4 space-y-3">
          {/* Risk badge — compact, on its own line so it doesn't crowd the
              type badge. Hidden when the AI service is unavailable. */}
          <RiskBadge postId={post.id} compact />

          <div>
            <h3 className="font-semibold text-base leading-snug line-clamp-2 group-hover:text-primary smooth">
              {post.product_name}
            </h3>
            {post.product_category && (
              <p className="text-xs text-muted-foreground mt-0.5">{post.product_category}</p>
            )}
          </div>

          {/* Quantity + unit + price — the headline numbers */}
          <div className="rounded-lg bg-muted/40 border border-border/40 p-2.5">
            <div className="flex items-baseline justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {t("marketplace-quantity")}
                </p>
                <p className="text-sm font-semibold tabular leading-tight">
                  <span className="text-base">{post.quantity.toLocaleString()}</span>
                  <span className="text-muted-foreground ml-1 text-xs">{fmtUnitLabel()}</span>
                </p>
              </div>
              <div className="text-right min-w-0">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {t("marketplace-price")}
                </p>
                <p className="text-sm font-semibold leading-tight truncate">
                  {fmtPrice()}
                </p>
              </div>
            </div>
          </div>

          {/* Location */}
          {(country || post.delivery_location) && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <MapPin className="size-3 shrink-0" />
              <span className="truncate">
                {post.delivery_location && <>{post.delivery_location}{country ? ", " : ""}</>}
                {country && <>{flag} {country.name}</>}
              </span>
            </div>
          )}

          {/* Footer — views / responses / posted ago */}
          <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-2 border-t border-border/60">
            <div className="flex items-center gap-2.5">
              <span className="inline-flex items-center gap-1" title={t("marketplace-card-views")}>
                <Eye className="size-3" />
                <span className="tabular">{post.views_count}</span>
              </span>
              <span className="inline-flex items-center gap-1" title={t("marketplace-card-responses")}>
                <MessageSquare className="size-3" />
                <span className="tabular">{post.responses_count}</span>
              </span>
            </div>
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3" />
              {t("marketplace-card-posted-ago").replace("{ago}", fmtRelative(post.created_at))}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Skeleton card used by `MarketplaceList` while the data is loading. */
export function MarketplacePostCardSkeleton() {
  return (
    <div className="rounded-xl border border-border/60 bg-card overflow-hidden">
      <div className="h-24 sm:h-28 bg-muted/40 animate-pulse" />
      <div className="p-4 space-y-3">
        <div className="h-4 w-3/4 rounded bg-muted/60 animate-pulse" />
        <div className="h-3 w-1/3 rounded bg-muted/40 animate-pulse" />
        <div className="h-12 rounded-lg bg-muted/30 animate-pulse" />
        <div className="h-3 w-1/2 rounded bg-muted/40 animate-pulse" />
        <div className="h-3 mt-2 border-t border-border/60 pt-2 flex justify-between">
          <div className="h-3 w-16 rounded bg-muted/40 animate-pulse" />
          <div className="h-3 w-12 rounded bg-muted/40 animate-pulse" />
        </div>
      </div>
    </div>
  );
}
