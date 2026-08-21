"use client";

import { useEffect, useMemo, useState } from "react";
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
import { Separator } from "@/components/ui/separator";
import {
  Gavel,
  Loader2,
  TrendingUp,
  Clock,
  Trophy,
  History,
  AlertCircle,
} from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { toast } from "sonner";
import { fmtMoney, fmtDateTime, fmtRelative } from "@/lib/utils/format";
import type { AuctionBid, AuctionType } from "@/lib/supabase/marketplace-auction-types";

interface AuctionWidgetProps {
  postId: string;
  /** The post row from /api/marketplace/[id]. We accept a partial shape so
   *  the MarketplacePostDetail can pass its already-fetched post data
   *  without an extra round-trip. */
  post: {
    id: string;
    post_type: string;
    target_price: number | null;
    currency: string;
    auction_type: AuctionType | null;
    auction_start_price: number | null;
    auction_current_price: number | null;
    auction_reserve_price: number | null;
    auction_ends_at: string | null;
    auction_winner_id: string | null;
    auction_min_increment: number | null;
    status: string;
  };
}

interface BidsResponse {
  items: AuctionBid[];
  highest: AuctionBid | null;
  is_owner: boolean;
  is_sealed: boolean;
  is_closed: boolean;
}

/**
 * AuctionWidget — live auction panel.
 *
 * Shows:
 *   • Current highest bid (english) / current ask (dutch) / sealed-bid
 *     reminder.
 *   • Time-remaining countdown (ticks every second).
 *   • Bid input + "Place Bid" button (disabled while auction closed, on
 *     own auction, or — for sealed — once the caller has already bid).
 *   • Bid history (newest first); for sealed auctions, only the caller's
 *     own bid is visible until the auction closes.
 *
 * Refetches every 5 seconds while the auction is active so the user sees
 * other bidders' bids without manual refresh.
 */
export function AuctionWidget({ postId, post }: AuctionWidgetProps) {
  const t = useT();
  const qc = useQueryClient();
  const [amount, setAmount] = useState("");
  const [now, setNow] = useState(Date.now());

  // Tick every 1s for the countdown.
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);

  const bidsQ = useQuery<BidsResponse>({
    queryKey: ["marketplace-bids", postId],
    queryFn: async () => {
      const r = await fetch(`/api/marketplace/${postId}/bids`);
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to load bids.");
      }
      return r.json();
    },
    refetchInterval: 5_000,
  });

  const placeBid = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/marketplace/${postId}/bids`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: Number(amount),
          currency: post.currency,
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to place bid.");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-bid-placed"));
      setAmount("");
      qc.invalidateQueries({ queryKey: ["marketplace-bids", postId] });
      qc.invalidateQueries({ queryKey: ["marketplace-post", postId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const withdraw = useMutation({
    mutationFn: async (bidId: string) => {
      const r = await fetch(`/api/marketplace/${postId}/bids/${bidId}`, {
        method: "DELETE",
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to withdraw bid.");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-bid-withdrawn"));
      qc.invalidateQueries({ queryKey: ["marketplace-bids", postId] });
      qc.invalidateQueries({ queryKey: ["marketplace-post", postId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ─── Derived display state ──────────────────────────────────────────
  const auctionType = (post.auction_type ?? "english") as AuctionType;
  const isActive = post.status === "active" && !post.auction_winner_id;
  const isClosed = !isActive;
  const startPrice = Number(post.auction_start_price ?? post.target_price ?? 0);
  const currentPrice = Number(post.auction_current_price ?? startPrice);
  const minIncrement = Number(post.auction_min_increment ?? 1);

  // Dutch: the ask drops over time (we just display the current_price —
  // the actual decrease is driven by a cron / external scheduler). For
  // the widget we show the current ask as the suggested bid.
  const suggestedBid = useMemo(() => {
    if (auctionType === "english") {
      return currentPrice > 0 ? currentPrice + minIncrement : startPrice + minIncrement;
    }
    if (auctionType === "dutch") return currentPrice || startPrice;
    return null; // sealed: no suggestion
  }, [auctionType, currentPrice, startPrice, minIncrement]);

  // Countdown.
  const endsAt = post.auction_ends_at ? new Date(post.auction_ends_at).getTime() : null;
  const remainingMs = endsAt ? Math.max(0, endsAt - now) : null;
  const remainingLabel = useMemo(() => {
    if (remainingMs === null) return "—";
    const s = Math.floor(remainingMs / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m ${sec}s`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }, [remainingMs]);

  // Whether the caller can bid (server enforces ownership; here we just
  // pre-disable to avoid wasted requests — the store returns 400 otherwise).
  const highestBid = bidsQ.data?.highest ?? null;
  // The API sanitises partner_id for non-owners and stamps an `is_mine`
  // flag on each bid. We use that flag — not the raw partner_id — to
  // detect the caller's own bid (so the withdraw button shows up only
  // for the bidder, without leaking other partners' internal ids).
  const myBid = (bidsQ.data?.items || []).find((b) => (b as { is_mine?: boolean }).is_mine === true) || null;
  const hasBidInSealed = auctionType === "sealed" && !!myBid;

  const canBid = isActive && !hasBidInSealed;

  // ─── Render ─────────────────────────────────────────────────────────
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Gavel className="h-4 w-4" />
          {t("marketplace-auction-title")}
          <Badge variant="outline" className="ml-2 border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400 uppercase">
            {t(`marketplace-auction-type-${auctionType}`)}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Current price */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-xs text-muted-foreground">
              {auctionType === "sealed" ? t("marketplace-auction-start-price") : t("marketplace-auction-current-bid")}
            </p>
            <p className="text-2xl font-bold mt-0.5">
              {fmtMoney(
                auctionType === "sealed" ? startPrice : currentPrice,
                post.currency,
              )}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t("marketplace-auction-time-left")}</p>
            <p className="text-2xl font-bold mt-0.5 flex items-center gap-1">
              <Clock className="h-4 w-4 text-muted-foreground" />
              {isClosed ? <span className="text-muted-foreground">{t("marketplace-auction-ended")}</span> : remainingLabel}
            </p>
          </div>
        </div>

        {/* Closed banner */}
        {isClosed && (
          <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
            <Trophy className="h-4 w-4 shrink-0" />
            {post.auction_winner_id
              ? t("marketplace-auction-winner-announced")
              : t("marketplace-auction-ended-no-winner")}
          </div>
        )}

        {/* Bid input */}
        {isActive && (
          <div className="space-y-2">
            {suggestedBid !== null && (
              <p className="text-xs text-muted-foreground">
                {t("marketplace-auction-min-next-bid").replace("{n}", fmtMoney(suggestedBid, post.currency))}
              </p>
            )}
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                type="number"
                step="0.01"
                placeholder={suggestedBid ? String(suggestedBid) : ""}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={!canBid || placeBid.isPending}
                className="w-full sm:flex-1"
              />
              <Button
                onClick={() => placeBid.mutate()}
                disabled={!canBid || !amount || placeBid.isPending}
                className="w-full sm:w-auto"
              >
                {placeBid.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <TrendingUp className="h-4 w-4 mr-1" />}
                {t("marketplace-auction-place-bid")}
              </Button>
            </div>
            {hasBidInSealed && (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                {t("marketplace-auction-sealed-already-bid")}
              </p>
            )}
          </div>
        )}

        {/* Bid history */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <History className="h-3 w-3" />
              {t("marketplace-auction-bid-history")}
            </p>
            {bidsQ.isLoading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          </div>
          <Separator />
          {bidsQ.data && bidsQ.data.items.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">{t("marketplace-auction-no-bids")}</p>
          ) : (
            <ul className="space-y-1 max-h-48 overflow-y-auto">
              {(bidsQ.data?.items || []).map((b) => (
                <li key={b.id} className="flex items-center justify-between text-xs py-1.5">
                  <span className="text-muted-foreground">
                    {fmtRelative(b.created_at)}
                    {b.is_winning && (
                      <Badge variant="outline" className="ml-2 border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                        {t("marketplace-auction-winning")}
                      </Badge>
                    )}
                  </span>
                  <span className="font-medium">
                    {fmtMoney(Number(b.bid_amount), b.currency)}
                  </span>
                  {auctionType === "english" && (b as { is_mine?: boolean }).is_mine && isActive && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 px-2 text-xs"
                      onClick={() => withdraw.mutate(b.id)}
                      disabled={withdraw.isPending}
                    >
                      {t("marketplace-auction-withdraw")}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Reserve price (owner-only) */}
        {post.auction_reserve_price !== null && post.auction_reserve_price !== undefined && (
          <p className="text-xs text-muted-foreground pt-2 border-t">
            {t("marketplace-auction-reserve-price")}: {fmtMoney(Number(post.auction_reserve_price), post.currency)}
          </p>
        )}

        {post.auction_ends_at && (
          <p className="text-xs text-muted-foreground">
            {t("marketplace-auction-ends-at")}: {fmtDateTime(post.auction_ends_at)}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
