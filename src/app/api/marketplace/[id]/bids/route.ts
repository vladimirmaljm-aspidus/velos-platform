import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { listBids, placeBid, getCurrentHighestBid, processAuctionEnd } from "@/lib/data/marketplace-auction-store";
import { getSupabase } from "@/lib/supabase/client";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { notify } from "@/lib/notif/helper";
import { triggerWebhooks } from "@/lib/webhooks/deliver";
// 8d-7: per-partner+post rate limit on bid placement — without this,
// a malicious partner can spam hundreds of bids in a minute on
// someone else's auction, each triggering an audit log + notification
// + outbound webhook to the auction owner (flood + abuse vector).
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/[id]/bids — list bids on an auction post.
//   • English/dutch: every caller (authenticated) sees the full bid list.
//   • Sealed: the post OWNER sees all bids; a bidder sees only their own
//     bid + the winning bid (after the auction closes).
//   • Non-auction posts: returns 400.
async function _get(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;

  // Fetch the post to verify it's an auction in the caller's tenant.
  const sb = getSupabase();
  const { data: postRow, error: postErr } = await sb
    .from("marketplace_posts")
    .select("tenant_id, partner_id, post_type, auction_type, auction_winner_id, status, auction_ends_at")
    .eq("id", id)
    .maybeSingle();
  if (postErr) {
    console.error("[marketplace.bids.get] post lookup failed:", postErr);
    return NextResponse.json({ error: "Failed to load post." }, { status: 500 });
  }
  if (!postRow) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const post = postRow as {
    tenant_id: string;
    partner_id: string;
    post_type: string;
    auction_type: string | null;
    auction_winner_id: string | null;
    status: string;
    auction_ends_at: string | null;
  };
  if (post.tenant_id !== access.tenant_id) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (post.post_type !== "auction") {
    return NextResponse.json({ error: "Post is not an auction." }, { status: 400 });
  }

  // Lazy settle: if the auction ended but the winner hasn't been set yet,
  // process it now so the bidder sees the final result.
  if (
    post.status === "active" &&
    post.auction_ends_at &&
    new Date(post.auction_ends_at).getTime() <= Date.now()
  ) {
    try {
      await processAuctionEnd(id);
    } catch (e) {
      console.error("[marketplace.bids.get] lazy processAuctionEnd failed:", e);
    }
  }

  try {
    const all = await listBids(id);
    const isOwner = post.partner_id === access.partner_id;
    const isSealed = post.auction_type === "sealed";
    const isClosed = post.status === "closed" || post.auction_winner_id !== null;

    // Sanitise partner_id for non-owner callers (Phase 4 privacy).
    // Owner sees the raw rows. Non-owner: strip partner_id + add an
    // `is_mine` flag so the widget can still show "your bid" without
    // leaking other partners' internal ids.
    const sanitise = (b: typeof all[number]) => {
      const mine = b.partner_id === access.partner_id;
      const { partner_id: _p, ...rest } = b;
      return { ...rest, is_mine: mine } as typeof b & { is_mine: boolean };
    };

    if (isOwner || !isSealed || isClosed) {
      // English / dutch / sealed-closed / owner of sealed: visible.
      // For sealed + non-owner + still-active: filter to caller's own bids.
      const visible = (isSealed && !isOwner && !isClosed)
        ? all.filter((b) => b.partner_id === access.partner_id)
        : all;
      // Highest bid (for the "current bid" display).
      let highest: Awaited<ReturnType<typeof getCurrentHighestBid>> = null;
      try {
        highest = await getCurrentHighestBid(id);
      } catch { /* ignore */ }
      // Owner sees raw rows; non-owners see sanitised shape.
      const out = isOwner ? visible : visible.map(sanitise);
      return NextResponse.json({
        items: out,
        highest: isOwner ? highest : (highest ? sanitise(highest) : null),
        is_owner: isOwner,
        is_sealed: isSealed,
        is_closed: isClosed,
      });
    }

    // Sealed + non-owner + still active: hide every other bid.
    const own = all.filter((b) => b.partner_id === access.partner_id).map(sanitise);
    return NextResponse.json({
      items: own,
      highest: null, // hidden
      is_owner: false,
      is_sealed: true,
      is_closed: false,
    });
  } catch (e: any) {
    console.error("[marketplace.bids.get]", e);
    return NextResponse.json({ error: "Failed to load bids." }, { status: 500 });
  }
}

// POST /api/marketplace/[id]/bids — place a bid on an auction post.
// Body: { amount: number, currency?: string }
async function _post(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;

  // 8d-7: per-partner+post rate limit on bid placement. 10/min is well
  // above a legit pattern (a human takes >5s between bids); bursts above
  // this are almost always script-driven abuse.
  const bidRl = await checkRateLimit(`mkt:bid:${access.partner_id}:${id}`, 10, 60_000);
  if (!bidRl.allowed) {
    return NextResponse.json(
      { error: "Too many bids in a short period. Please slow down." },
      { status: 429 },
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const amount = Number(body?.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
    return NextResponse.json({ error: "Bid amount must be a positive number." }, { status: 400 });
  }
  const currency = typeof body?.currency === "string" && body.currency.length <= 4 ? body.currency : "USD";

  try {
    const bid = await placeBid(access.tenant_id, access.partner_id, id, amount, currency);
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.bid_placed",
        "marketplace_auction_bid",
        bid.id,
        { post_id: id, bid_amount: amount, currency },
      );
    } catch (e) {
      console.error("[marketplace.bids.post] audit failed:", e);
    }

    // Notify the post owner (fire-and-forget). For sealed auctions we
    // don't reveal the bid amount — just that a bid was placed.
    try {
      const sb = getSupabase();
      const { data: postRow } = await sb
        .from("marketplace_posts")
        .select("partner_id, product_name, auction_type")
        .eq("id", id)
        .maybeSingle();
      const ownerPartnerId = (postRow as { partner_id?: string } | null)?.partner_id;
      const productName = (postRow as { product_name?: string } | null)?.product_name ?? "your auction";
      const auctionType = (postRow as { auction_type?: string } | null)?.auction_type ?? "english";
      const isSealed = auctionType === "sealed";
      if (ownerPartnerId && ownerPartnerId !== access.partner_id) {
        await notify({
          tenantId: access.tenant_id,
          partnerId: ownerPartnerId,
          type: "marketplace_response_received", // reuse the existing type
          title: "New bid on your auction",
          message: isSealed
            ? `A partner placed a sealed bid on "${productName}".`
            : `A partner bid ${currency} ${amount} on "${productName}".`,
          entityType: "marketplace_post",
          entityId: id,
          actionUrl: `/portal/marketplace/${id}`,
          actionLabel: "View auction",
        });
      }
      // Phase 12 — fire marketplace.bid_placed webhook (fire-and-forget).
      // For sealed auctions we deliberately omit the bid amount (the
      // payload would leak it to the receiver before the auction closes).
      try {
        const store = await getStore();
        void triggerWebhooks(store, access.tenant_id, "marketplace.bid_placed", "marketplace_auction_bid", bid.id, {
          id: bid.id,
          post_id: id,
          bidder_partner_id: bid.partner_id,
          bid_amount: isSealed ? null : amount,
          currency,
          is_sealed: isSealed,
          created_at: bid.created_at,
        }).catch(() => {});
      } catch (e) {
        console.error("[marketplace.bids.post] webhook failed:", e);
      }
    } catch (e) {
      console.error("[marketplace.bids.post] notify failed:", e);
    }

    return NextResponse.json(bid);
  } catch (e: any) {
    console.error("[marketplace.bids.post]", e);
    const msg = sanitizeError(e);
    const status = /not found|not an auction|own auction/i.test(msg) ? 400 :
      /already (placed|closed|ended)/i.test(msg) ? 409 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/[id]/bids");
export const POST = withApm(_post, "POST /api/marketplace/[id]/bids");
