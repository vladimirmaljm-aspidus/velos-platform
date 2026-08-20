"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  ArrowLeft,
  Loader2,
  MapPin,
  Globe2,
  Calendar,
  Coins,
  Ruler,
  Layers,
  FileText,
  Truck,
  Send,
  MessageSquare,
  ShieldCheck,
  Eye,
  TrendingUp,
  TrendingDown,
  Gavel,
} from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { useAppStore } from "@/lib/store/app-store";
import { toast } from "sonner";
import { fmtMoney, fmtDate, fmtDateTime, fmtRelative } from "@/lib/utils/format";
import {
  COUNTRIES,
  PRODUCT_CATEGORIES,
  UNITS_OF_MEASURE,
  INCOTERMS,
  CURRENCIES,
} from "@/lib/data/reference";
import type { MarketplacePostType } from "@/lib/supabase/marketplace-types";
import type { AuctionType } from "@/lib/supabase/marketplace-auction-types";
import { AuctionWidget } from "./auction-widget";
import { ContractWidget } from "./contract-widget";

interface PostDetail {
  id: string;
  post_type: MarketplacePostType;
  product_name: string;
  product_category: string | null;
  product_subcategory: string | null;
  quantity: number;
  unit: string;
  target_price: number | null;
  price_max: number | null;
  price_visible: boolean;
  price_type: string;
  currency: string;
  delivery_location: string | null;
  delivery_country: string | null;
  delivery_date: string | null;
  incoterm: string | null;
  origin_country: string | null;
  packaging: string | null;
  specifications: Record<string, unknown>;
  quality_specs: unknown[];
  payment_terms: string | null;
  description: string | null;
  status: string;
  visibility: string;
  is_verified: boolean;
  verification_level: string;
  views_count: number;
  responses_count: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  // Owner-only field — the store keeps it on the row only when the caller
  // is the post owner. Presence === ownership on the client side.
  partner_id?: string;
  // Phase 4 auction columns (NULL on non-auction posts).
  auction_type?: AuctionType | null;
  auction_start_price?: number | null;
  auction_current_price?: number | null;
  auction_reserve_price?: number | null;
  auction_ends_at?: string | null;
  auction_winner_id?: string | null;
  auction_min_increment?: number | null;
}

const TYPE_BADGE: Record<MarketplacePostType, { labelKey: string; icon: React.ComponentType<{ className?: string }>; cls: string }> = {
  buy: { labelKey: "marketplace-buy", icon: TrendingUp, cls: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  sell: { labelKey: "marketplace-sell", icon: TrendingDown, cls: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-400" },
  auction: { labelKey: "marketplace-auction", icon: Gavel, cls: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  contract: { labelKey: "marketplace-contract", icon: FileText, cls: "border-transparent bg-violet-500/15 text-violet-700 dark:text-violet-400" },
};

export function MarketplacePostDetail({ postId }: { postId: string }) {
  const t = useT();
  const setSelectedId = useAppStore((s) => s.setSelectedId);
  const qc = useQueryClient();

  const [showResponseForm, setShowResponseForm] = useState(false);
  const [response, setResponse] = useState({
    quantity: "",
    unit_price: "",
    currency: "USD",
    delivery_date: "",
    delivery_location: "",
    incoterm: "",
    payment_terms: "",
    message: "",
  });

  const q = useQuery<{ post: PostDetail }>({
    queryKey: ["marketplace-post", postId],
    queryFn: async () => {
      const r = await fetch(`/api/marketplace/${postId}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    refetchInterval: 30_000,
  });

  const sendResponse = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        message: response.message || null,
        currency: response.currency,
      };
      if (response.quantity) payload.quantity = Number(response.quantity);
      if (response.unit_price) payload.unit_price = Number(response.unit_price);
      if (response.delivery_date) payload.delivery_date = new Date(response.delivery_date).toISOString();
      if (response.delivery_location) payload.delivery_location = response.delivery_location;
      if (response.incoterm) payload.incoterm = response.incoterm;
      if (response.payment_terms) payload.payment_terms = response.payment_terms;

      const r = await fetch(`/api/marketplace/${postId}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to send offer.");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-offer-sent"));
      setShowResponseForm(false);
      setResponse({
        quantity: "", unit_price: "", currency: "USD",
        delivery_date: "", delivery_location: "",
        incoterm: "", payment_terms: "", message: "",
      });
      qc.invalidateQueries({ queryKey: ["marketplace-post", postId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (q.isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (q.isError || !q.data?.post) {
    return (
      <div className="text-center py-20">
        <p className="text-muted-foreground">{t("marketplace-post-not-found")}</p>
        <Button variant="outline" className="mt-3" onClick={() => setSelectedId(null)}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          {t("marketplace-back-to-list")}
        </Button>
      </div>
    );
  }

  const post = q.data.post;
  const meta = TYPE_BADGE[post.post_type] ?? TYPE_BADGE.sell;
  const TypeIcon = meta.icon;
  const country = post.delivery_country ? COUNTRIES.find((c) => c.code === post.delivery_country) : null;
  const origin = post.origin_country ? COUNTRIES.find((c) => c.code === post.origin_country) : null;
  const unit = UNITS_OF_MEASURE.find((u) => u.code === post.unit);
  const incoterm = post.incoterm ? INCOTERMS.find((i) => i.code === post.incoterm) : null;

  function fmtPrice(): string {
    if (!post.price_visible || post.price_type === "on_request") {
      return t("marketplace-price-on-request");
    }
    if (post.price_type === "range" && post.target_price != null && post.price_max != null) {
      return `${fmtMoney(post.target_price, post.currency)} – ${fmtMoney(post.price_max, post.currency)}`;
    }
    if (post.target_price != null) return fmtMoney(post.target_price, post.currency);
    return t("marketplace-price-on-request");
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={() => setSelectedId(null)}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          {t("marketplace-back-to-list")}
        </Button>
      </div>

      {/* Header */}
      <Card>
        <CardContent className="p-6">
          <div className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
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
                <Badge variant="outline" className="text-xs">
                  {t(`marketplace-status-${post.status}`) || post.status}
                </Badge>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Eye className="h-3 w-3" />
                  {post.views_count}
                </span>
                <span className="inline-flex items-center gap-1">
                  <MessageSquare className="h-3 w-3" />
                  {post.responses_count}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  {fmtRelative(post.created_at)}
                </span>
              </div>
            </div>

            <div>
              <h1 className="text-2xl font-bold">{post.product_name}</h1>
              {post.product_category && (
                <p className="text-sm text-muted-foreground mt-1">
                  {post.product_category}
                  {post.product_subcategory ? ` · ${post.product_subcategory}` : ""}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 border-t">
              <div>
                <p className="text-xs text-muted-foreground">{t("marketplace-quantity")}</p>
                <p className="font-medium mt-0.5 flex items-center gap-1">
                  <Ruler className="h-3.5 w-3.5 text-muted-foreground" />
                  {post.quantity.toLocaleString()} {unit?.name || post.unit}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t("marketplace-price")}</p>
                <p className="font-medium mt-0.5 flex items-center gap-1">
                  <Coins className="h-3.5 w-3.5 text-muted-foreground" />
                  {fmtPrice()}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t("marketplace-delivery")}</p>
                <p className="font-medium mt-0.5 flex items-center gap-1">
                  <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                  {post.delivery_location || "—"}
                  {country && (
                    <span className="inline-flex items-center gap-1">
                      <Globe2 className="h-3.5 w-3.5 text-muted-foreground" />
                      {country.name}
                    </span>
                  )}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t("marketplace-delivery-date")}</p>
                <p className="font-medium mt-0.5 flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                  {post.delivery_date ? fmtDate(post.delivery_date) : "—"}
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Trade terms */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("marketplace-trade-terms")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <DetailRow icon={Truck} label={t("marketplace-incoterm")} value={incoterm ? `${incoterm.code} — ${incoterm.name}` : post.incoterm || "—"} />
            <DetailRow icon={Globe2} label={t("marketplace-origin-country")} value={origin ? origin.name : post.origin_country || "—"} />
            <DetailRow icon={Layers} label={t("marketplace-packaging")} value={post.packaging || "—"} />
            <DetailRow icon={FileText} label={t("marketplace-payment-terms")} value={post.payment_terms || "—"} />
            {post.expires_at && (
              <DetailRow icon={Calendar} label={t("marketplace-expires-at")} value={fmtDateTime(post.expires_at)} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("marketplace-description")}</CardTitle>
          </CardHeader>
          <CardContent>
            {post.description ? (
              <p className="text-sm whitespace-pre-wrap">{post.description}</p>
            ) : (
              <p className="text-sm text-muted-foreground">{t("marketplace-no-description")}</p>
            )}
            {Array.isArray(post.quality_specs) && post.quality_specs.length > 0 && (
              <>
                <Separator className="my-3" />
                <p className="text-xs font-medium mb-2">{t("marketplace-quality-specs")}</p>
                <ul className="text-xs space-y-1">
                  {(post.quality_specs as string[]).map((s, i) => (
                    <li key={i} className="text-muted-foreground">• {s}</li>
                  ))}
                </ul>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Phase 4: auction widget — shown only on auction posts. */}
      {post.post_type === "auction" && (
        <AuctionWidget postId={post.id} post={{
          id: post.id,
          post_type: post.post_type,
          target_price: post.target_price,
          currency: post.currency,
          auction_type: post.auction_type ?? null,
          auction_start_price: post.auction_start_price ?? null,
          auction_current_price: post.auction_current_price ?? null,
          auction_reserve_price: post.auction_reserve_price ?? null,
          auction_ends_at: post.auction_ends_at ?? null,
          auction_winner_id: post.auction_winner_id ?? null,
          auction_min_increment: post.auction_min_increment ?? null,
          status: post.status,
        }} />
      )}

      {/* Phase 4: contract widget — shown only on contract posts. */}
      {post.post_type === "contract" && (
        <ContractWidget
          postId={post.id}
          currency={post.currency}
          unit={post.unit}
          isOwner={!!post.partner_id}
        />
      )}

      {/* Send response form */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{t("marketplace-send-offer")}</CardTitle>
            {!showResponseForm && (
              <Button size="sm" onClick={() => setShowResponseForm(true)}>
                <Send className="h-4 w-4 mr-1" />
                {t("marketplace-respond")}
              </Button>
            )}
          </div>
        </CardHeader>
        {showResponseForm && (
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label htmlFor="r-qty">{t("marketplace-quantity")}</Label>
                <Input
                  id="r-qty"
                  type="number"
                  value={response.quantity}
                  onChange={(e) => setResponse({ ...response, quantity: e.target.value })}
                  placeholder={String(post.quantity)}
                />
              </div>
              <div>
                <Label htmlFor="r-price">{t("marketplace-unit-price")}</Label>
                <Input
                  id="r-price"
                  type="number"
                  value={response.unit_price}
                  onChange={(e) => setResponse({ ...response, unit_price: e.target.value })}
                  placeholder={post.target_price ? String(post.target_price) : ""}
                />
              </div>
              <div>
                <Label htmlFor="r-currency">{t("marketplace-currency")}</Label>
                <Select value={response.currency} onValueChange={(v) => setResponse({ ...response, currency: v })}>
                  <SelectTrigger id="r-currency"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.slice(0, 12).map((c) => (
                      <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="r-ddate">{t("marketplace-delivery-date")}</Label>
                <Input
                  id="r-ddate"
                  type="date"
                  value={response.delivery_date}
                  onChange={(e) => setResponse({ ...response, delivery_date: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="r-dloc">{t("marketplace-delivery-location")}</Label>
                <Input
                  id="r-dloc"
                  value={response.delivery_location}
                  onChange={(e) => setResponse({ ...response, delivery_location: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="r-inco">{t("marketplace-incoterm")}</Label>
                <Select value={response.incoterm} onValueChange={(v) => setResponse({ ...response, incoterm: v })}>
                  <SelectTrigger id="r-inco"><SelectValue placeholder="—" /></SelectTrigger>
                  <SelectContent>
                    {INCOTERMS.map((i) => (
                      <SelectItem key={i.code} value={i.code}>{i.code} — {i.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="r-pay">{t("marketplace-payment-terms")}</Label>
                <Input
                  id="r-pay"
                  value={response.payment_terms}
                  onChange={(e) => setResponse({ ...response, payment_terms: e.target.value })}
                />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="r-msg">{t("marketplace-message")}</Label>
                <Textarea
                  id="r-msg"
                  rows={4}
                  value={response.message}
                  onChange={(e) => setResponse({ ...response, message: e.target.value })}
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => sendResponse.mutate()} disabled={sendResponse.isPending}>
                {sendResponse.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Send className="h-4 w-4 mr-1" />}
                {t("marketplace-send-offer")}
              </Button>
              <Button variant="outline" onClick={() => setShowResponseForm(false)}>
                {t("portal-action-cancel")}
              </Button>
            </div>
          </CardContent>
        )}
        {!showResponseForm && post.responses_count > 0 && (
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {t("marketplace-responses-received-count").replace("{n}", String(post.responses_count))}
            </p>
          </CardContent>
        )}
      </Card>
    </div>
  );
}

function DetailRow({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground inline-flex items-center gap-2">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </span>
      <span className="font-medium text-right">{value}</span>
    </div>
  );
}
