import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { withdrawBid } from "@/lib/data/marketplace-auction-store";
import { getSupabase } from "@/lib/supabase/client";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/[id]/bids/[bidId] — fetch a single bid. Only the
// bidder themselves or the post owner can read it (for sealed auctions,
// other bidders must not see competing bids — the store returns null).
async function _get(req: NextRequest, ctx: { params: Promise<{ id: string; bidId: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id, bidId } = await ctx.params;

  const sb = getSupabase();
  // Verify the post is in the caller's tenant + is an auction.
  const { data: postRow } = await sb
    .from("marketplace_posts")
    .select("tenant_id, partner_id, post_type, auction_type, auction_winner_id, status")
    .eq("id", id)
    .maybeSingle();
  const post = postRow as {
    tenant_id: string;
    partner_id: string;
    post_type: string;
    auction_type: string | null;
    auction_winner_id: string | null;
    status: string;
  } | null;
  if (!post || post.tenant_id !== access.tenant_id) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (post.post_type !== "auction") {
    return NextResponse.json({ error: "Post is not an auction." }, { status: 400 });
  }

  const { data: bidRow } = await sb
    .from("marketplace_auction_bids")
    .select("*")
    .eq("id", bidId)
    .maybeSingle();
  const bid = bidRow as { partner_id: string; is_winning: boolean } | null;
  if (!bid) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const isOwner = post.partner_id === access.partner_id;
  const isBidder = bid.partner_id === access.partner_id;
  const isSealed = post.auction_type === "sealed";
  const isClosed = post.status === "closed" || post.auction_winner_id !== null;

  // Sealed + active + not mine + not owner → 403 (privacy).
  if (isSealed && !isClosed && !isOwner && !isBidder) {
    return NextResponse.json({ error: "Bid is sealed." }, { status: 403 });
  }
  return NextResponse.json({ bid: bidRow });
}

// DELETE /api/marketplace/[id]/bids/[bidId] — withdraw a bid. Only the
// bidder themselves can withdraw; only on english auctions; only while
// the auction is still active.
async function _delete(req: NextRequest, ctx: { params: Promise<{ id: string; bidId: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id, bidId } = await ctx.params;

  try {
    await withdrawBid(access.tenant_id, access.partner_id, bidId);
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.bid_withdrawn",
        "marketplace_auction_bid",
        bidId,
        { post_id: id },
      );
    } catch (e) {
      console.error("[marketplace.bids.delete] audit failed:", e);
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[marketplace.bids.delete]", e);
    const msg = e?.message || "Failed to withdraw bid.";
    const status = /not found/i.test(msg) ? 404 :
      /only the bidder|own bid|english|active/i.test(msg) ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/[id]/bids/[bidId]");
export const DELETE = withApm(_delete, "DELETE /api/marketplace/[id]/bids/[bidId]");
