"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Eye,
  MessageSquare,
  MapPin,
  Globe2,
  ShieldCheck,
  Clock,
  TrendingUp,
  TrendingDown,
  Gavel,
  FileText,
} from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { fmtMoney, fmtRelative } from "@/lib/utils/format";
import { COUNTRIES } from "@/lib/data/reference";
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

const TYPE_META: Record<MarketplacePostType, { labelKey: string; icon: React.ComponentType<{ className?: string }>; cls: string }> = {
  buy: { labelKey: "marketplace-buy", icon: TrendingUp, cls: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  sell: { labelKey: "marketplace-sell", icon: TrendingDown, cls: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-400" },
  auction: { labelKey: "marketplace-auction", icon: Gavel, cls: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  contract: { labelKey: "marketplace-contract", icon: FileText, cls: "border-transparent bg-violet-500/15 text-violet-700 dark:text-violet-400" },
};

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
    ? COUNTRIES.find((c) => c.code === post.delivery_country)
    : null;

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

  return (
    <Card
      className="cursor-pointer transition-all hover:shadow-md hover:border-primary/40"
      onClick={() => onClick?.(post.id)}
    >
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <Badge variant="outline" className={meta.cls}>
            <TypeIcon className="h-3 w-3 mr-1" />
            {t(meta.labelKey)}
          </Badge>
          {post.is_verified && (
            <Badge variant="outline" className="border-transparent bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
              <ShieldCheck className="h-3 w-3 mr-1" />
              {t(`marketplace-verification-${post.verification_level}`)}
            </Badge>
          )}
        </div>

        {/* Phase 5: AI risk badge — compact "icon + score" variant with a
            hover tooltip listing every triggered risk factor. The badge
            renders nothing on assessment failure (network error, etc.) so
            the card stays uncluttered when the AI service is unavailable. */}
        <div className="flex justify-end">
          <RiskBadge postId={post.id} compact />
        </div>

        <div>
          <h3 className="font-semibold text-base line-clamp-2">{post.product_name}</h3>
          {post.product_category && (
            <p className="text-xs text-muted-foreground mt-0.5">{post.product_category}</p>
          )}
        </div>

        <div className="flex items-baseline justify-between">
          <div className="text-sm">
            <span className="font-medium">{post.quantity.toLocaleString()}</span>
            <span className="text-muted-foreground ml-1">{post.unit}</span>
          </div>
          <div className="text-sm font-semibold">{fmtPrice()}</div>
        </div>

        {(country || post.delivery_location) && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <MapPin className="h-3 w-3" />
            <span>
              {post.delivery_location && <>{post.delivery_location}{country ? ", " : ""}</>}
              {country && (
                <span className="inline-flex items-center gap-1">
                  <Globe2 className="h-3 w-3" />
                  {country.name}
                </span>
              )}
            </span>
          </div>
        )}

        <div className="flex items-center justify-between text-xs text-muted-foreground pt-2 border-t">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <Eye className="h-3 w-3" />
              {post.views_count}
            </span>
            <span className="inline-flex items-center gap-1">
              <MessageSquare className="h-3 w-3" />
              {post.responses_count}
            </span>
          </div>
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {fmtRelative(post.created_at)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
