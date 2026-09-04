"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Clock,
  FileText,
  Gavel,
  Globe,
  MapPin,
  MessageSquare,
  Eye,
  TrendingDown,
  TrendingUp,
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
 * UI-MARKET — Post card redesign.
 *
 * Premium B2B commodity trade card (Bloomberg-Terminal-meets-SaaS):
 *   1. Solid type badge top-left (BUY=emerald / SELL=amber / Auction=violet /
 *      Contract=sky). White text. The buy/sell polarity matches the user's
 *      spec exactly; auction/contract reuse the existing palette but as
 *      solid fills so all four types share the same visual weight.
 *   2. Verified-or-Risk badge top-right (one or the other, never both — the
 *      verified badge already implies low risk).
 *   3. Product name (text-lg bold) + category (xs uppercase muted).
 *   4. Price (right-aligned, 2xl bold for fixed / lg for range / muted base
 *      for "on request"). Currency symbol is part of fmtMoney output.
 *   5. Specs block (border-t separated): quantity + unit.
 *   6. Footer (border-t separated): location (MapPin), responses
 *      (MessageSquare), posted-ago (Clock) — all small muted.
 *
 * Padding is p-5 (was p-4 — too tight), gap-3 between blocks, rounded-xl
 * (not rounded-lg), border-border/60 with hover:border-primary/40 +
 * hover:shadow-md transition-all.
 */
const TYPE_META: Record<
  MarketplacePostType,
  {
    labelKey: string;
    icon: React.ComponentType<{ className?: string }>;
    badge: string;
  }
> = {
  buy: {
    labelKey: "marketplace-buy",
    icon: TrendingUp,
    badge: "border-transparent bg-emerald-600 text-white shadow-sm",
  },
  sell: {
    labelKey: "marketplace-sell",
    icon: TrendingDown,
    badge: "border-transparent bg-amber-600 text-white shadow-sm",
  },
  auction: {
    labelKey: "marketplace-auction",
    icon: Gavel,
    badge: "border-transparent bg-violet-600 text-white shadow-sm",
  },
  contract: {
    labelKey: "marketplace-contract",
    icon: FileText,
    badge: "border-transparent bg-sky-600 text-white shadow-sm",
  },
};

/** Country flag emoji from ISO code; falls back to a Globe lucide icon. */
function flagNode(code: string | null | undefined) {
  const flag = code ? getCountry(code)?.flag : undefined;
  return flag ?? <Globe className="size-4" />;
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
  const country = post.delivery_country ? getCountry(post.delivery_country) : null;
  const flag = flagNode(post.delivery_country);

  const isOnRequest =
    !post.price_visible || post.price_type === "on_request";
  const isRange =
    !isOnRequest &&
    post.price_type === "range" &&
    post.target_price != null &&
    post.price_max != null;
  const priceIsNumeric = !isOnRequest && post.target_price != null;

  function fmtPriceValue(): string {
    if (isOnRequest) return t("marketplace-price-on-request");
    if (isRange && post.target_price != null && post.price_max != null) {
      return `${fmtMoney(post.target_price, post.currency)} – ${fmtMoney(
        post.price_max,
        post.currency,
      )}`;
    }
    if (post.target_price != null) {
      return fmtMoney(post.target_price, post.currency);
    }
    return t("marketplace-price-on-request");
  }

  // Single fixed price → big & bold; range → smaller (fits on one line);
  // on-request → muted, smaller.
  const priceClass = isOnRequest
    ? "text-base font-medium text-muted-foreground"
    : isRange
      ? "text-lg font-bold tabular leading-none"
      : "text-2xl font-bold tabular leading-none";

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
      className={cn(
        "group cursor-pointer overflow-hidden rounded-xl border border-border/60",
        "transition-all hover:border-primary/40 hover:shadow-md hover:-translate-y-0.5",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
      )}
      onClick={() => onClick?.(post.id)}
    >
      <CardContent className="p-5 space-y-4">
        {/* ── Top row: type badge + verified/risk badge ───────────────── */}
        <div className="flex items-start justify-between gap-2">
          <Badge className={cn("gap-1.5 font-semibold", meta.badge)}>
            <TypeIcon className="size-3.5" />
            {t(meta.labelKey)}
          </Badge>
          {post.is_verified ? (
            <Badge
              variant="outline"
              className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              title={t(`marketplace-verification-${post.verification_level}`)}
            >
              <CheckCircle2 className="size-3.5" />
              {t("marketplace-card-verified")}
            </Badge>
          ) : (
            <RiskBadge postId={post.id} compact />
          )}
        </div>

        {/* ── Product name + category ─────────────────────────────────── */}
        <div className="space-y-1">
          <h3 className="text-lg font-bold leading-snug line-clamp-2 group-hover:text-primary smooth">
            {post.product_name}
          </h3>
          {post.product_category && (
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {post.product_category}
            </p>
          )}
        </div>

        {/* ── Price (prominent, right-aligned) ────────────────────────── */}
        <div className="flex items-baseline justify-end gap-1.5">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">
            {t("marketplace-price")}
          </span>
          <span className={priceClass}>{fmtPriceValue()}</span>
        </div>

        {/* ── Specs block: quantity ───────────────────────────────────── */}
        <div className="space-y-2 border-t border-border/60 pt-3 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {t("marketplace-quantity")}
            </span>
            <span className="font-semibold tabular">
              {post.quantity.toLocaleString()}
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                {post.unit}
              </span>
            </span>
          </div>
        </div>

        {/* ── Footer: location · responses · posted-ago ───────────────── */}
        <div className="border-t border-border/60 pt-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
            {(country || post.delivery_location) && (
              <span className="inline-flex min-w-0 items-center gap-1">
                <MapPin className="size-3.5 shrink-0" />
                <span className="truncate">
                  {post.delivery_location && (
                    <>{post.delivery_location}{country ? ", " : ""}</>
                  )}
                  {country && (
                    <>{flag} {country.name}</>
                  )}
                </span>
              </span>
            )}
            <span
              className="inline-flex items-center gap-1"
              title={t("marketplace-card-responses")}
            >
              <MessageSquare className="size-3.5" />
              <span className="tabular">{post.responses_count}</span>
            </span>
            <span
              className="inline-flex items-center gap-1"
              title={t("marketplace-card-views")}
            >
              <Eye className="size-3.5" />
              <span className="tabular">{post.views_count}</span>
            </span>
            <span className="ml-auto inline-flex items-center gap-1">
              <Clock className="size-3.5" />
              {t("marketplace-card-posted-ago").replace(
                "{ago}",
                fmtRelative(post.created_at),
              )}
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
    <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
      <div className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-2">
          <div className="h-6 w-16 rounded-full bg-muted/60 animate-pulse" />
          <div className="h-6 w-20 rounded-full bg-muted/40 animate-pulse" />
        </div>
        <div className="space-y-1.5">
          <div className="h-5 w-full rounded bg-muted/60 animate-pulse" />
          <div className="h-3 w-1/3 rounded bg-muted/40 animate-pulse" />
        </div>
        <div className="flex justify-end">
          <div className="h-7 w-24 rounded bg-muted/60 animate-pulse" />
        </div>
        <div className="h-px bg-border/60" />
        <div className="flex justify-between">
          <div className="h-3 w-16 rounded bg-muted/40 animate-pulse" />
          <div className="h-4 w-20 rounded bg-muted/60 animate-pulse" />
        </div>
        <div className="h-px bg-border/60" />
        <div className="flex justify-between">
          <div className="h-3 w-24 rounded bg-muted/40 animate-pulse" />
          <div className="h-3 w-16 rounded bg-muted/40 animate-pulse" />
        </div>
      </div>
    </div>
  );
}
