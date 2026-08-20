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
  Building2,
  Clock,
  Package,
  CheckCircle2,
  ListChecks,
} from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { useAppStore } from "@/lib/store/app-store";
import { toast } from "sonner";
import { fmtMoney, fmtDate, fmtDateTime, fmtRelative } from "@/lib/utils/format";
import { getCountry } from "@/lib/data/geo/countries";
import {
  COUNTRIES,
  PRODUCT_CATEGORIES,
  UNITS_OF_MEASURE,
  INCOTERMS,
  CURRENCIES,
} from "@/lib/data/reference";
import { cn } from "@/lib/utils";
import type { MarketplacePostType } from "@/lib/supabase/marketplace-types";
import type { AuctionType } from "@/lib/supabase/marketplace-auction-types";
import { AuctionWidget } from "./auction-widget";
import { ContractWidget } from "./contract-widget";
import { PriceTrendChart } from "./price-trend-chart";
import { FreightCalculator } from "./freight-calculator";
import { CustomsCalculator } from "./customs-calculator";
import { ContainerCalculator } from "./container-calculator";
import { CarbonFootprint } from "./carbon-footprint";
import { MarketplacePostCard, type MarketplacePostCardData } from "./marketplace-post-card";

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

const TYPE_BADGE: Record<
  MarketplacePostType,
  { labelKey: string; icon: React.ComponentType<{ className?: string }>; cls: string }
> = {
  buy: { labelKey: "marketplace-buy", icon: TrendingUp, cls: "border-transparent bg-green-500/15 text-green-700 dark:text-green-400" },
  sell: { labelKey: "marketplace-sell", icon: TrendingDown, cls: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  auction: { labelKey: "marketplace-auction", icon: Gavel, cls: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  contract: { labelKey: "marketplace-contract", icon: FileText, cls: "border-transparent bg-violet-500/15 text-violet-700 dark:text-violet-400" },
};

function flagEmoji(code: string | null | undefined): string {
  if (!code) return "🌐";
  return getCountry(code)?.flag || "🌐";
}

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

  // UI-3 step 3 — related posts. Fetch by category, exclude the current post.
  // The marketplace list endpoint accepts a `category` param; we slice 3.
  const relatedQ = useQuery<{ items: MarketplacePostCardData[]; total: number }>({
    queryKey: ["marketplace-related", postId, q.data?.post.product_category],
    queryFn: async () => {
      const cat = q.data?.post.product_category;
      const params = new URLSearchParams({ limit: "4", sort: "recent" });
      if (cat) params.set("category", cat);
      const r = await fetch(`/api/marketplace?${params}`);
      if (!r.ok) return { items: [], total: 0 };
      return r.json();
    },
    enabled: !!q.data?.post,
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
  const country = post.delivery_country ? getCountry(post.delivery_country) : null;
  const origin = post.origin_country ? getCountry(post.origin_country) : null;
  const unit = UNITS_OF_MEASURE.find((u) => u.code === post.unit);
  const incoterm = post.incoterm ? INCOTERMS.find((i) => i.code === post.incoterm) : null;
  const category = post.product_category
    ? PRODUCT_CATEGORIES.find((c) => c.code === post.product_category)
    : null;
  const isOwner = !!post.partner_id;

  // Related posts — same category, exclude current.
  const relatedItems = (relatedQ.data?.items ?? [])
    .filter((p) => p.id !== postId)
    .slice(0, 3);

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

  // Specifications table — render the JSON object as label/value rows.
  // Filter out empty/null values; stringify non-string scalars.
  const specEntries: { label: string; value: string }[] = Object.entries(
    post.specifications || {},
  )
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => ({
      label: k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      value:
        typeof v === "string"
          ? v
          : Array.isArray(v)
            ? v.join(", ")
            : String(v),
    }));

  const qualitySpecs = Array.isArray(post.quality_specs) ? (post.quality_specs as string[]) : [];

  return (
    <div className="space-y-6 pb-24 lg:pb-6">
      {/* Back button + breadcrumb */}
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={() => setSelectedId(null)} className="gap-1">
          <ArrowLeft className="h-4 w-4" />
          {t("marketplace-back-to-list")}
        </Button>
        {category && (
          <nav className="text-xs text-muted-foreground hidden sm:flex items-center gap-1.5">
            <span>{t("marketplace-title")}</span>
            <span className="text-muted-foreground/40">/</span>
            <span>{category.name}</span>
            <span className="text-muted-foreground/40">/</span>
            <span className="text-foreground font-medium truncate max-w-[200px]">{post.product_name}</span>
          </nav>
        )}
      </div>

      {/* ─── Header / overview ─────────────────────────────────────────── */}
      <Card className="overflow-hidden border-border/60 shadow-soft">
        <CardContent className="p-6">
          <div className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className={cn("gap-1 font-medium", meta.cls)}>
                  <TypeIcon className="h-3 w-3" />
                  {t(meta.labelKey)}
                </Badge>
                {post.is_verified && (
                  <Badge
                    variant="outline"
                    className="gap-1 border-transparent bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                  >
                    <ShieldCheck className="h-3 w-3" />
                    {t(`marketplace-verification-${post.verification_level}`)}
                  </Badge>
                )}
                <Badge variant="outline" className="text-xs">
                  {t(`marketplace-status-${post.status}`) || post.status}
                </Badge>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1" title={t("marketplace-card-views")}>
                  <Eye className="h-3 w-3" />
                  <span className="tabular">{post.views_count}</span>
                </span>
                <span className="inline-flex items-center gap-1" title={t("marketplace-card-responses")}>
                  <MessageSquare className="h-3 w-3" />
                  <span className="tabular">{post.responses_count}</span>
                </span>
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {t("marketplace-card-posted-ago").replace("{ago}", fmtRelative(post.created_at))}
                </span>
              </div>
            </div>

            <div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{post.product_name}</h1>
              {post.product_category && (
                <p className="text-sm text-muted-foreground mt-1">
                  {post.product_category}
                  {post.product_subcategory ? ` · ${post.product_subcategory}` : ""}
                </p>
              )}
            </div>

            {/* Headline numbers grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 border-t">
              <HeadlineStat
                icon={Ruler}
                label={t("marketplace-quantity")}
                value={`${post.quantity.toLocaleString()} ${unit?.name || post.unit}`}
              />
              <HeadlineStat
                icon={Coins}
                label={t("marketplace-price")}
                value={fmtPrice()}
                accent="text-emerald-700 dark:text-emerald-400"
              />
              <HeadlineStat
                icon={MapPin}
                label={t("marketplace-delivery")}
                value={
                  country
                    ? `${flagEmoji(post.delivery_country)} ${post.delivery_location ? post.delivery_location + ", " : ""}${country.name}`
                    : (post.delivery_location || "—")
                }
              />
              <HeadlineStat
                icon={Calendar}
                label={t("marketplace-delivery-date")}
                value={post.delivery_date ? fmtDate(post.delivery_date) : "—"}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ─── Left column: detail sections ────────────────────────── */}
        <div className="lg:col-span-2 space-y-6">
          {/* Specifications table */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <ListChecks className="size-4 text-muted-foreground" />
                {t("marketplace-detail-section-specs")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {specEntries.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("marketplace-detail-no-specs")}</p>
              ) : (
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
                  {specEntries.map((s) => (
                    <div key={s.label} className="flex flex-col py-1.5 border-b border-border/40 last:border-0">
                      <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">{s.label}</dt>
                      <dd className="text-sm font-medium mt-0.5">{s.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </CardContent>
          </Card>

          {/* Quality specs as badges */}
          {qualitySpecs.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <CheckCircle2 className="size-4 text-emerald-700 dark:text-emerald-400" />
                  {t("marketplace-quality-specs")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {qualitySpecs.map((s, i) => (
                    <Badge
                      key={i}
                      variant="outline"
                      className="border-border/60 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400 font-normal"
                    >
                      <CheckCircle2 className="size-3 mr-1" />
                      {s}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Trade terms */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="size-4 text-muted-foreground" />
                {t("marketplace-detail-section-trade")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <DetailRow icon={Truck} label={t("marketplace-incoterm")} value={incoterm ? `${incoterm.code} — ${incoterm.name}` : post.incoterm || "—"} />
              <DetailRow icon={Globe2} label={t("marketplace-origin-country")} value={origin ? `${flagEmoji(post.origin_country)} ${origin.name}` : post.origin_country || "—"} />
              <DetailRow icon={Layers} label={t("marketplace-packaging")} value={post.packaging || "—"} />
              <DetailRow icon={FileText} label={t("marketplace-payment-terms")} value={post.payment_terms || "—"} />
              {post.expires_at && (
                <DetailRow icon={Calendar} label={t("marketplace-expires-at")} value={fmtDateTime(post.expires_at)} />
              )}
            </CardContent>
          </Card>

          {/* Description */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{t("marketplace-detail-section-description")}</CardTitle>
            </CardHeader>
            <CardContent>
              {post.description ? (
                <p className="text-sm whitespace-pre-wrap leading-relaxed">{post.description}</p>
              ) : (
                <p className="text-sm text-muted-foreground">{t("marketplace-no-description")}</p>
              )}
            </CardContent>
          </Card>

          {/* Phase 5: AI price prediction + 12-week price trend chart. */}
          <PriceTrendChart postId={post.id} />

          {/* Phase 4: auction widget */}
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

          {/* Phase 4: contract widget */}
          {post.post_type === "contract" && (
            <ContractWidget
              postId={post.id}
              currency={post.currency}
              unit={post.unit}
              isOwner={isOwner}
            />
          )}

          {/* Phase 6: logistics calculators */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <FreightCalculator />
            <CustomsCalculator />
            <ContainerCalculator />
            <CarbonFootprint />
          </div>
        </div>

        {/* ─── Right column: company card + Send Offer CTA ────────── */}
        <div className="lg:col-span-1 space-y-6">
          {/* Posting partner card */}
          <Card className="overflow-hidden border-border/60">
            <div className="relative">
              <div className="absolute inset-0 bg-mesh-portal opacity-50" />
              <div className="absolute top-0 right-0 size-24 bg-emerald-500/10 blur-3xl rounded-full" />
              <CardContent className="relative p-5 space-y-4">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {t("marketplace-detail-company-card")}
                  </p>
                </div>
                <div className="flex items-start gap-3">
                  <div className="size-12 rounded-xl bg-emerald-500/10 flex items-center justify-center shrink-0">
                    <Building2 className="size-6 text-emerald-700 dark:text-emerald-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold truncate">
                      {post.is_verified
                        ? t("marketplace-detail-company-verified")
                        : t("marketplace-detail-company-unverified")}
                    </p>
                    {country && (
                      <p className="text-xs text-muted-foreground mt-0.5 inline-flex items-center gap-1">
                        <span>{flagEmoji(post.delivery_country)}</span>
                        {country.name}
                      </p>
                    )}
                  </div>
                </div>
                {/* Verification level pill */}
                {post.is_verified && (
                  <Badge
                    variant="outline"
                    className="gap-1 border-transparent bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 w-full justify-center"
                  >
                    <ShieldCheck className="size-3.5" />
                    {t(`marketplace-verification-${post.verification_level}`)}
                  </Badge>
                )}
                <p className="text-[11px] text-muted-foreground leading-relaxed border-t border-border/40 pt-3">
                  {t("marketplace-detail-contact-hint")}
                </p>
              </CardContent>
            </div>
          </Card>

          {/* Send Offer CTA */}
          <Card className="border-emerald-500/30 bg-emerald-500/[0.04]">
            <CardContent className="p-5 space-y-4">
              <div>
                <p className="text-sm font-semibold">{t("marketplace-detail-send-offer-cta")}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {post.responses_count > 0
                    ? t("marketplace-responses-received-count").replace("{n}", String(post.responses_count))
                    : t("marketplace-detail-respond-cta")}
                </p>
              </div>
              <Button
                className="w-full gap-1.5 smooth hover:shadow-soft-md"
                size="lg"
                onClick={() => setShowResponseForm((v) => !v)}
              >
                {showResponseForm ? (
                  <>{t("portal-action-cancel")}</>
                ) : (
                  <>
                    <Send className="size-4" />
                    {t("marketplace-detail-respond-cta")}
                  </>
                )}
              </Button>
            </CardContent>

            {showResponseForm && (
            <CardContent className="space-y-4 border-t border-border/40 pt-5">
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
                <Button onClick={() => sendResponse.mutate()} disabled={sendResponse.isPending} className="flex-1 gap-1">
                  {sendResponse.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  {t("marketplace-send-offer")}
                </Button>
                <Button variant="outline" onClick={() => setShowResponseForm(false)}>
                  {t("portal-action-cancel")}
                </Button>
              </div>
            </CardContent>
          )}
          </Card>
        </div>
      </div>

      {/* ─── Related posts ─────────────────────────────────────────────── */}
      <Card className="border-border/60">
        <CardHeader className="pb-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Package className="size-4 text-muted-foreground" />
              {t("marketplace-detail-related-title")}
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">{t("marketplace-detail-related-sub")}</p>
          </div>
        </CardHeader>
        <CardContent>
          {relatedQ.isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : relatedItems.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">{t("marketplace-detail-related-empty")}</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {relatedItems.map((p) => (
                <MarketplacePostCard key={p.id} post={p} onClick={(id) => setSelectedId(id)} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Sticky mobile CTA bar ─────────────────────────────────────── */}
      {/* On small screens, the Send Offer button in the sidebar is below the
          fold. This sticky bottom bar keeps it always accessible. Hidden on
          lg+ where the sidebar card is already visible. */}
      {!showResponseForm && (
        <div className="lg:hidden fixed bottom-0 inset-x-0 z-30 border-t border-border/60 bg-background/95 backdrop-blur-md p-3 shadow-soft-lg">
          <div className="flex items-center justify-between gap-3 max-w-3xl mx-auto">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{t("marketplace-price")}</p>
              <p className="text-sm font-semibold truncate">{fmtPrice()}</p>
            </div>
            <Button
              onClick={() => setShowResponseForm(true)}
              className="gap-1.5 shrink-0"
            >
              <Send className="size-4" />
              {t("marketplace-detail-respond-cta")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function HeadlineStat({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground inline-flex items-center gap-1">
        <Icon className="h-3 w-3" />
        {label}
      </p>
      <p className={cn("font-medium mt-0.5 truncate", accent)}>{value}</p>
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
