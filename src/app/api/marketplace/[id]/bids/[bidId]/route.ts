import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { withdrawBid } from "@/lib/data/marketplace-auction-store";
import { getSupabase } from "@/lib/supabase/client";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/[id]/bids/[bidId] — fetch a single bid. Only the
// bidder themselves or the post owner can read it (for sealed auctions,
// other bidders must not see competing bids — the store returns null).
//
// 8c-1 / 8d-3: the previous implementation fetched the bid by `bidId`
// ALONE — no `eq("post_id", id)` filter, no tenant filter on the bid's
// underlying post. Combined with the gate using `isOwner = POST_X.partner_id
// === access.partner_id` (the URL's post, NOT the bid's post), a caller who
// owned POST_X could read ANY bid in the platform by passing its UUID in the
// URL, including bids on other auctions they didn't own (cross-PARTNER leak)
// or even bids in other tenants (cross-TENANT leak). Now we fetch the bid
// with `.eq("post_id", id)` so a bid not on the URL's post 404s, and we
// derive `isOwner` from the bid's own post partner_id.
async function _get(req: NextRequest, ctx: { params: Promise<{ id: string; bidId: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id, bidId } = await ctx.params;

  const sb = getSupabase();
  // Verify the post is in the caller's tenant + is an auction. Still
  // required so the URL's `id` is a real auction in the caller's tenant —
  // otherwise the gate below would 404 the bid (which is the desired
  // behaviour for cross-tenant probes).
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

  // 8c-1: fetch the bid JOINED to its own post + scoped to the URL's
  // `post_id`. A bid that lives on a different post 404s — closing the
  // cross-tenant / cross-partner leak. The JOIN lets us check the bid's
  // post tenant_id (defense-in-depth — already filtered via post_id, but
  // the FK could be missing on legacy data) and derive `isOwner` from
  // the bid's post partner_id (not the URL's post partner_id).
  const { data: bidRow } = await sb
    .from("marketplace_auction_bids")
    .select(
      "*, post:marketplace_posts!inner(tenant_id, partner_id, auction_type, auction_winner_id, status)",
    )
    .eq("id", bidId)
    .eq("post_id", id)
    .maybeSingle();
  const bid = bidRow as {
    partner_id: string;
    is_winning: boolean;
    post: {
      tenant_id: string;
      partner_id: string;
      auction_type: string | null;
      auction_winner_id: string | null;
      status: string;
    };
  } | null;
  if (!bid || bid.post.tenant_id !== access.tenant_id) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  // 8c-1: derive `isOwner` from the bid's OWN post (not the URL's post —
  // they're now the same post thanks to the `.eq("post_id", id)` filter,
  // but the JOIN makes that explicit and survives future refactors).
  const isOwner = bid.post.partner_id === access.partner_id;
  const isBidder = bid.partner_id === access.partner_id;
  const isSealed = bid.post.auction_type === "sealed";
  const isClosed = bid.post.status === "closed" || bid.post.auction_winner_id !== null;

  // Sealed + active + not mine + not owner → 403 (privacy).
  if (isSealed && !isClosed && !isOwner && !isBidder) {
    return NextResponse.json({ error: "Bid is sealed." }, { status: 403 });
  }
  return NextResponse.json({ bid: bidRow });
}

// DELETE /api/marketplace/[id]/bids/[bidId] — withdraw a bid. Only the
// bidder themselves can withdraw; only on english auctions; only while
// the auction is still active.
//
// 8d-10 / 8d-11: defense-in-depth — the store's `withdrawBid` already
// enforces bidder ownership + auction-type + auction-status, but the
// route layer adds its OWN pre-checks so a future store refactor that
// accidentally weakens one of those gates doesn't expose a delete path.
// The two pre-checks are:
//   • Ownership (8d-10): 404 when `bid.partner_id !== access.partner_id`.
//     Returns 404 (not 403) so a partner probing another bidder's UUID
//     learns nothing — same shape as a missing bid.
//   • Bid-status (8d-11): 409 when `is_winning === true`. The schema
//     (migration 046) intentionally has no `status` column on
//     marketplace_auction_bids — `is_winning` is the analogue of
//     `status === 'accepted'`. A winning bid that has already settled
//     the auction cannot be withdrawn (the settlement flow has already
//     tied the winner_id on the post, notified the loser, etc.).
async function _delete(req: NextRequest, ctx: { params: Promise<{ id: string; bidId: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id, bidId } = await ctx.params;

  // 8d-10 / 8d-11: route-level pre-checks. The bid is fetched JOINED to
  // its own post + scoped to the URL's `post_id` so a bid on a different
  // post 404s (matches the GET handler's behaviour above). The JOIN lets
  // us verify the bid's post tenant_id matches the caller's tenant
  // (defense-in-depth — already filtered via post_id + the RLS layer,
  // but explicit is better).
  const sb = getSupabase();
  const { data: bidRow } = await sb
    .from("marketplace_auction_bids")
    .select(
      "*, post:marketplace_posts!inner(tenant_id, partner_id, auction_type, auction_winner_id, status)",
    )
    .eq("id", bidId)
    .eq("post_id", id)
    .maybeSingle();
  const bid = bidRow as {
    partner_id: string;
    is_winning: boolean;
    post: {
      tenant_id: string;
      partner_id: string;
      auction_type: string | null;
      auction_winner_id: string | null;
      status: string;
    };
  } | null;
  // Cross-tenant probe or non-existent bid → 404 (no information leak).
  if (!bid || bid.post.tenant_id !== access.tenant_id) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  // 8d-10: ownership defense-in-depth — the store re-checks this, but
  // the route layer 404s BEFORE the store call so a future store change
  // can't silently expose the delete path. Returns 404 (not 403) to
  // match the GET handler's "no information leak" stance.
  if (bid.partner_id !== access.partner_id) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  // 8d-11: bid-status defense-in-depth — `is_winning` is the analogue
  // of `status === 'accepted'` per migration 046 (no separate `status`
  // column exists on marketplace_auction_bids). A winning bid has
  // already triggered the post-settlement flow (winner_id was stamped
  // on the post, the loser was notified, escrow / finance milestone may
  // have been initiated) — withdrawing it after settlement would leave
  // the auction in an inconsistent state. 409 surfaces this clearly to
  // the UI so it can disable the "Withdraw" button on settled rows.
  if (bid.is_winning === true) {
    return NextResponse.json(
      { error: "Cannot withdraw a winning bid — the auction has already been settled." },
      { status: 409 },
    );
  }

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
    const msg = sanitizeError(e);
    // 8d-10 / 8d-11: the new route-level pre-checks (ownership 404 +
    // winning-bid 409) short-circuit BEFORE the try block, so the
    // store-level backstop errors here only fire on a race (e.g. the
    // auction settled between the pre-check and the store call). The
    // original mapping is preserved — store ownership / auction-state
    // errors surface as 400 to match the pre-fix behaviour; the new
    // `winning` keyword is added so a future store-side guard surfaces
    // 409 (not 400) for consistency with the route-level pre-check.
    const status = /not found/i.test(msg) ? 404 :
      /winning/i.test(msg) ? 409 :
      /only the bidder|own bid|english|active/i.test(msg) ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/[id]/bids/[bidId]");
export const DELETE = withApm(_delete, "DELETE /api/marketplace/[id]/bids/[bidId]");
