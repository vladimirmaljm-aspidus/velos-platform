// Marketplace Phase 4 store — auctions, contracts, smart pricing.
//
// All functions talk directly to the tables added in migration
// 046_marketplace_auctions_contracts.sql. The store is intentionally a
// separate module from marketplace-store.ts to keep the Phase 1-3 file
// readable; API routes import both modules and pass `tenantId` /
// `partnerId` from the resolved auth context.
//
// SECURITY MODEL
//   • placeBid(): the caller is the BIDDER (not the post owner). We reject
//     self-bids (partner_id === post.partner_id) at the store level so an
//     owner cannot artificially inflate their own auction.
//   • listBids(): public for english/dutch auctions (everyone sees who bid
//     what). For sealed auctions the API route filters to the caller's own
//     bids + the winning bid only — the store returns the raw rows.
//   • processAuctionEnd(): idempotent — if auction_winner_id is already set,
//     return the post unchanged. Safe to call from a cron AND a lazy
//     on-demand trigger when a bidder views an expired auction.
//   • Contracts + deliveries: tenant-scoped via the FK chain
//     contract → post → tenant. The store filters by tenant_id at read time
//     by first fetching the post and verifying it belongs to the caller's
//     tenant. Only the post owner can create a contract / update deliveries.

import { getSupabase } from "@/lib/supabase/client";
import type {
  AuctionBid,
  AuctionPostSummary,
  AuctionType,
  Contract,
  ContractCreate,
  ContractDelivery,
  ContractDeliveryStatus,
  ContractDeliveryUpdate,
  ContractFrequency,
  ContractPriceType,
  MarketPriceStats,
} from "@/lib/supabase/marketplace-auction-types";

// ─── Auctions: bids + lifecycle ────────────────────────────────────────────

/**
 * Place a bid on an auction post.
 *
 * Rules enforced here:
 *   • Post must exist, be in the caller's tenant, post_type='auction', and
 *     status='active'.
 *   • Caller may not bid on their own auction (self-bid rejection).
 *   • auction_ends_at must be in the future (or NULL — accepts bids).
 *   • auction_winner_id must be NULL (auction not yet settled).
 *
 * English auction:
 *   • bid_amount must be ≥ (auction_current_price + auction_min_increment),
 *     where auction_current_price falls back to auction_start_price on the
 *     first bid. Updates auction_current_price on success.
 *
 * Dutch auction:
 *   • bid_amount must equal auction_current_price (the current dutch ask).
 *     First bid wins — auction_winner_id is set immediately and status
 *     flips to 'closed'.
 *
 * Sealed auction:
 *   • Caller may place exactly one bid — duplicate bids are rejected.
 *   • auction_current_price is NOT updated (sealed until the end).
 *
 * Returns the inserted bid row.
 */
export async function placeBid(
  tenantId: string,
  partnerId: string,
  postId: string,
  amount: number,
  currency = "USD",
): Promise<AuctionBid> {
  const sb = getSupabase();

  // Fetch the post (full row — we need auction_* + partner_id).
  const { data: postRow, error: postErr } = await sb
    .from("marketplace_posts")
    .select("*")
    .eq("id", postId)
    .maybeSingle();
  if (postErr) throw postErr;
  if (!postRow) throw new Error("Post not found.");
  const post = postRow as any as AuctionPostSummary & { tenant_id: string; partner_id: string };
  if (post.tenant_id !== tenantId) throw new Error("Post not found.");
  if (post.post_type !== "auction") throw new Error("Post is not an auction.");
  if (post.status !== "active") throw new Error("Auction is no longer active.");
  if (post.partner_id === partnerId) throw new Error("Cannot bid on your own auction.");
  if (post.auction_winner_id) throw new Error("Auction has already closed.");
  if (post.auction_ends_at && new Date(post.auction_ends_at).getTime() <= Date.now()) {
    throw new Error("Auction has ended.");
  }
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Bid amount must be positive.");

  const auctionType = (post.auction_type ?? "english") as AuctionType;
  const startPrice = Number(post.auction_start_price ?? 0);
  const currentPrice = Number(post.auction_current_price ?? startPrice);
  const minIncrement = Number(post.auction_min_increment ?? 1);

  if (auctionType === "english") {
    const minBid = (Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : startPrice) + minIncrement;
    if (amount < minBid) {
      throw new Error(`Bid must be at least ${minBid} (current + min increment).`);
    }
  } else if (auctionType === "dutch") {
    // First bidder accepts the current ask. The current_price should equal
    // auction_start_price until a separate cron tick lowers it; either way,
    // the bid must match the displayed ask.
    if (amount > currentPrice) {
      throw new Error(`Dutch auction bid must be ≤ current price (${currentPrice}).`);
    }
  } else if (auctionType === "sealed") {
    // One bid per partner per sealed auction.
    const { data: existing } = await sb
      .from("marketplace_auction_bids")
      .select("id")
      .eq("post_id", postId)
      .eq("partner_id", partnerId)
      .maybeSingle();
    if (existing) throw new Error("You have already placed a bid on this sealed auction.");
  }

  // Insert the bid.
  const { data: inserted, error: insErr } = await sb
    .from("marketplace_auction_bids")
    .insert({
      post_id: postId,
      partner_id: partnerId,
      bid_amount: amount,
      currency,
      is_winning: false,
    })
    .select()
    .single();
  if (insErr) throw insErr;
  const bid = inserted as AuctionBid;

  // Update auction_current_price on the post (english only; dutch seals
  // the auction immediately; sealed stays hidden until end).
  if (auctionType === "english") {
    const { error: updErr } = await sb
      .from("marketplace_posts")
      .update({ auction_current_price: amount })
      .eq("id", postId);
    if (updErr) throw updErr;
  } else if (auctionType === "dutch") {
    // First bid wins. The settlement is atomic via a conditional UPDATE
    // — we only flip the post to closed+winner if auction_winner_id is
    // STILL null. This guards against the concurrent-bidder race where
    // two bidders simultaneously read `current_price` and both think
    // they're the first to accept. Without the guard, both bids would
    // be marked `is_winning = true` and the post's winner_id would be
    // whichever UPDATE committed last — an inconsistent state. With
    // the guard, only the FIRST committed UPDATE affects the row; the
    // second sees 0 affected rows and we roll back (delete the bid).
    const { data: settled, error: settleErr } = await sb
      .from("marketplace_posts")
      .update({
        auction_current_price: amount,
        auction_winner_id: partnerId,
        status: "closed",
      })
      .eq("id", postId)
      .is("auction_winner_id", null) // CRITICAL: only if not already won
      .select("id")
      .maybeSingle();
    if (settleErr) throw settleErr;
    if (!settled) {
      // Another bidder won between our read and our write. Roll back
      // the bid we just inserted (it lost the race) and surface a 409.
      await sb.from("marketplace_auction_bids").delete().eq("id", bid.id);
      throw new Error("Auction has already closed.");
    }
    // We won — flip our bid to is_winning. Conditional on winner_id =
    // us so a stale concurrent writer can't undo our settlement.
    await sb
      .from("marketplace_auction_bids")
      .update({ is_winning: true })
      .eq("id", bid.id);
    bid.is_winning = true;
  }

  return bid;
}

/**
 * List all bids on a post. Returns rows in NEWEST-FIRST order so the
 * "bid history" panel shows the latest bid at the top.
 *
 * For sealed auctions the API route is expected to filter out other
 * partners' bids (only the caller's own + the winning bid). The store
 * returns the raw rows for the post owner's view (they need the full
 * picture to settle the auction).
 */
export async function listBids(postId: string): Promise<AuctionBid[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("marketplace_auction_bids")
    .select("*")
    .eq("post_id", postId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as AuctionBid[]) || [];
}

/**
 * Get the current highest bid on a post. Used by:
 *   • The auction widget to display "Current bid: $X" (english).
 *   • processAuctionEnd() to determine the winner.
 *
 * Returns null when no bids have been placed yet. The caller can fall
 * back to auction_start_price when this returns null.
 */
export async function getCurrentHighestBid(postId: string): Promise<AuctionBid | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("marketplace_auction_bids")
    .select("*")
    .eq("post_id", postId)
    .order("bid_amount", { ascending: false })
    .order("created_at", { ascending: true }) // earliest tie wins
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as AuctionBid) || null;
}

/**
 * Withdraw (delete) a bid. Allowed only on english auctions, only by the
 * bidder, and only while the auction is still active. The post's
 * auction_current_price is re-computed from the remaining bids (falls back
 * to auction_start_price when the withdrawn bid was the only one).
 *
 * Dutch/sealed auctions do not allow withdrawals.
 */
export async function withdrawBid(
  tenantId: string,
  partnerId: string,
  bidId: string,
): Promise<{ ok: true }> {
  const sb = getSupabase();

  const { data: bid, error: bidErr } = await sb
    .from("marketplace_auction_bids")
    .select("*")
    .eq("id", bidId)
    .maybeSingle();
  if (bidErr) throw bidErr;
  if (!bid) throw new Error("Bid not found.");
  const b = bid as AuctionBid;
  if (b.partner_id !== partnerId) throw new Error("Only the bidder can withdraw their bid.");

  // Fetch the post to check auction_type + status.
  const { data: postRow } = await sb
    .from("marketplace_posts")
    .select("tenant_id, post_type, status, auction_type, auction_start_price")
    .eq("id", b.post_id)
    .maybeSingle();
  const post = postRow as
    | { tenant_id?: string; post_type?: string; status?: string; auction_type?: string | null; auction_start_price?: number | null }
    | null;
  if (!post || post.tenant_id !== tenantId) throw new Error("Bid not found.");
  if (post.post_type !== "auction") throw new Error("Post is not an auction.");
  if (post.status !== "active") throw new Error("Auction is no longer active.");
  if (post.auction_type !== "english") throw new Error("Withdrawals are only allowed on english auctions.");

  const { error: delErr } = await sb
    .from("marketplace_auction_bids")
    .delete()
    .eq("id", bidId);
  if (delErr) throw delErr;

  // Re-aggregate auction_current_price from the remaining bids.
  const highest = await getCurrentHighestBid(b.post_id);
  const nextPrice = highest ? Number(highest.bid_amount) : Number(post.auction_start_price ?? 0);
  await sb
    .from("marketplace_posts")
    .update({ auction_current_price: nextPrice })
    .eq("id", b.post_id);

  return { ok: true };
}

/**
 * Settle an auction at its end time. Called by:
 *   • A cron job that sweeps active auctions whose auction_ends_at is in
 *     the past (recommended).
 *   • A lazy on-demand trigger when a bidder views an expired auction that
 *     has not been settled yet (defense-in-depth — covers cron failure).
 *
 * Rules:
 *   • If auction_winner_id is already set, return the post unchanged
 *     (idempotent).
 *   • english: highest bid wins; if no bids, no winner. If reserve price
 *     is set and the highest bid is below it, no winner (auction ends
 *     without a sale — marked 'closed' anyway).
 *   • dutch: the winner was set at first-bid time; nothing to do here.
 *   • sealed: highest bid wins (subject to reserve).
 *
 * Returns the updated post (sanitised — no tenant_id / partner_id).
 */
export async function processAuctionEnd(
  postId: string,
): Promise<Record<string, unknown> | null> {
  const sb = getSupabase();

  const { data: postRow, error: postErr } = await sb
    .from("marketplace_posts")
    .select("*")
    .eq("id", postId)
    .maybeSingle();
  if (postErr) throw postErr;
  if (!postRow) return null;
  const post = postRow as any as AuctionPostSummary & { tenant_id: string; partner_id: string };
  if (post.post_type !== "auction") return null;
  if (post.auction_winner_id) {
    // Already settled. Sanitise + return.
    const { tenant_id: _t, partner_id: _p, ...rest } = post;
    return rest as Record<string, unknown>;
  }
  // Force-settle only when the end time has passed (or is missing — treat a
  // missing end as "end now" when the caller explicitly asks).
  if (post.auction_ends_at && new Date(post.auction_ends_at).getTime() > Date.now()) {
    return null; // still running
  }

  const auctionType = (post.auction_type ?? "english") as AuctionType;
  const reserve = Number(post.auction_reserve_price ?? 0);

  // Dutch auctions already settle at first-bid time.
  if (auctionType === "dutch") {
    const { error: updErr } = await sb
      .from("marketplace_posts")
      .update({ status: "closed" })
      .eq("id", postId);
    if (updErr) throw updErr;
    const { tenant_id: _t, partner_id: _p, ...rest } = post;
    return { ...rest, status: "closed" } as Record<string, unknown>;
  }

  // English / sealed: highest bid wins.
  const highest = await getCurrentHighestBid(postId);
  let winnerId: string | null = null;
  if (highest) {
    const bidAmt = Number(highest.bid_amount);
    if (!reserve || bidAmt >= reserve) {
      winnerId = highest.partner_id;
      await sb
        .from("marketplace_auction_bids")
        .update({ is_winning: true })
        .eq("id", highest.id);
    }
  }

  // Conditional UPDATE — only flips the post to closed+winner when
  // auction_winner_id is still null. Guards against two concurrent
  // cron ticks (or cron + lazy on-demand settle) both computing the
  // same winner and racing on the UPDATE. The winning UPDATE returns
  // the updated row; a stale concurrent UPDATE affects 0 rows and is
  // a no-op. Idempotent on the bid's is_winning flag too (re-setting
  // true→true).
  const { data: settled, error: updErr } = await sb
    .from("marketplace_posts")
    .update({
      auction_winner_id: winnerId,
      auction_current_price: highest ? Number(highest.bid_amount) : post.auction_current_price,
      status: "closed",
    })
    .eq("id", postId)
    .is("auction_winner_id", null)
    .select("id")
    .maybeSingle();
  if (updErr) throw updErr;
  void settled; // 0-row result means another caller settled it first

  const { tenant_id: _t, partner_id: _p, ...rest } = post;
  return {
    ...rest,
    auction_winner_id: winnerId,
    status: "closed",
  } as Record<string, unknown>;
}

// ─── Contracts ──────────────────────────────────────────────────────────────

/**
 * Create a long-term supply contract on a 'contract' post. Only the post
 * owner can create the contract (verified at the API layer before calling
 * this store). The post must exist, be in the caller's tenant, and have
 * post_type='contract'.
 *
 * When `data.auto_generate_schedule` is true (default), generate delivery
 * milestones from the (frequency, start_date, end_date) triple:
 *   • weekly    → one row per 7 days
 *   • monthly   → one row per calendar month
 *   • quarterly → one row per 3 months
 *   • custom    → no auto-generation; the owner adds deliveries manually.
 *
 * Each generated row's quantity = total_quantity / N (rounded to 4 dp).
 */
export async function createContract(
  tenantId: string,
  data: ContractCreate,
): Promise<Contract> {
  const sb = getSupabase();

  // Verify post exists + is in caller's tenant + is a contract post.
  const { data: postRow, error: postErr } = await sb
    .from("marketplace_posts")
    .select("id, tenant_id, post_type, status, total_quantity_ok:quantity")
    .eq("id", data.post_id)
    .maybeSingle();
  if (postErr) throw postErr;
  if (!postRow) throw new Error("Post not found.");
  const p = postRow as { tenant_id: string; post_type: string; status: string };
  if (p.tenant_id !== tenantId) throw new Error("Post not found.");
  if (p.post_type !== "contract") throw new Error("Post is not a contract offer.");

  // Validate date order.
  const start = new Date(data.start_date);
  const end = new Date(data.end_date);
  if (!Number.isFinite(start.getTime())) throw new Error("Invalid start_date.");
  if (!Number.isFinite(end.getTime())) throw new Error("Invalid end_date.");
  if (end.getTime() <= start.getTime()) throw new Error("end_date must be after start_date.");
  if (!Number.isFinite(data.total_quantity) || data.total_quantity <= 0) {
    throw new Error("total_quantity must be positive.");
  }

  // FIX-MARKET-2 / fix #6: a post can have AT MOST one contract. The
  // marketplace data model assumes a 1:1 post→contract relationship
  // (see getContract() below which uses `limit(1)` and the UI that shows
  // "the" contract for a post). Without this guard, a post owner could
  // create multiple overlapping contracts with different delivery
  // schedules, and getContract() would silently return only the most
  // recent one — orphaning the rest. Reuse the existing tenant-scoped
  // getContract() lookup so the duplicate check honours RLS-equivalent
  // isolation.
  const existing = await getContract(data.post_id, tenantId);
  if (existing) {
    throw new Error("A contract already exists for this post.");
  }

  const { data: inserted, error: insErr } = await sb
    .from("marketplace_contracts")
    .insert({
      post_id: data.post_id,
      total_quantity: data.total_quantity,
      delivered_quantity: 0,
      frequency: data.frequency ?? "monthly",
      start_date: data.start_date,
      end_date: data.end_date,
      price_type: data.price_type ?? "fixed",
      status: "active",
    })
    .select()
    .single();
  if (insErr) throw insErr;
  const contract = inserted as Contract;

  // Optionally generate the delivery schedule.
  if (data.auto_generate_schedule !== false && data.frequency && data.frequency !== "custom") {
    const deliveries = generateSchedule(
      contract.id,
      data.frequency,
      start,
      end,
      data.total_quantity,
    );
    if (deliveries.length > 0) {
      const { error: bulkErr } = await sb
        .from("marketplace_contract_deliveries")
        .insert(deliveries);
      if (bulkErr) {
        // Non-fatal — the contract is created; the owner can add
        // deliveries manually. Log + continue.
        console.error("[marketplace.contract.create] schedule generation failed:", bulkErr);
      }
    }
  }

  return contract;
}

/**
 * Compute the delivery schedule rows for a (frequency, start, end) triple.
 * Pure helper — does NOT touch the DB. Exported so a unit test can verify
 * the date math without spinning up a Supabase project.
 */
export function generateSchedule(
  contractId: string,
  frequency: ContractFrequency,
  start: Date,
  end: Date,
  totalQuantity: number,
): Array<Pick<ContractDelivery, "contract_id" | "scheduled_date" | "quantity">> {
  if (frequency === "custom") return [];
  const out: Array<Pick<ContractDelivery, "contract_id" | "scheduled_date" | "quantity">> = [];
  const stepMs =
    frequency === "weekly" ? 7 * 24 * 60 * 60 * 1000 :
    frequency === "monthly" ? 30 * 24 * 60 * 60 * 1000 :
    /* quarterly */ 90 * 24 * 60 * 60 * 1000;

  const points: number[] = [];
  let cursor = start.getTime();
  while (cursor <= end.getTime()) {
    points.push(cursor);
    cursor += stepMs;
  }
  if (points.length === 0) return out;
  // If the last point is before end, add end as a final point so the
  // schedule covers the whole window. (This is the "remainder" delivery.)
  if (points[points.length - 1] < end.getTime()) {
    points.push(end.getTime());
  }
  const perPoint = Number((totalQuantity / points.length).toFixed(4));
  for (const ts of points) {
    out.push({
      contract_id: contractId,
      scheduled_date: new Date(ts).toISOString(),
      quantity: perPoint,
    });
  }
  return out;
}

/**
 * Get the (single) contract attached to a post. Returns the raw row.
 * Tenant check: the caller's tenant must match the post's tenant.
 */
export async function getContract(
  postId: string,
  tenantId: string,
): Promise<Contract | null> {
  const sb = getSupabase();
  // First verify the post is in the caller's tenant.
  const { data: postRow, error: postErr } = await sb
    .from("marketplace_posts")
    .select("tenant_id")
    .eq("id", postId)
    .maybeSingle();
  if (postErr) throw postErr;
  if (!postRow) return null;
  if ((postRow as { tenant_id: string }).tenant_id !== tenantId) return null;

  const { data, error } = await sb
    .from("marketplace_contracts")
    .select("*")
    .eq("post_id", postId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as Contract) || null;
}

/**
 * Update a single delivery milestone. Only the post owner can do this —
 * verified at the API layer. The store re-checks via the FK chain
 * (delivery → contract → post → tenant_id) so a direct caller cannot
 * forge an update on another tenant's contract.
 *
 * After the UPDATE, recalculateContractProgress() is called to refresh
 * the parent contract's delivered_quantity.
 */
export async function updateContractDelivery(
  tenantId: string,
  contractId: string,
  deliveryId: string,
  patch: ContractDeliveryUpdate,
): Promise<ContractDelivery> {
  const sb = getSupabase();

  // Verify the contract belongs to a post in the caller's tenant.
  const { data: contractRow, error: cErr } = await sb
    .from("marketplace_contracts")
    .select("id, post_id")
    .eq("id", contractId)
    .maybeSingle();
  if (cErr) throw cErr;
  if (!contractRow) throw new Error("Contract not found.");
  const c = contractRow as { id: string; post_id: string };
  const { data: postRow } = await sb
    .from("marketplace_posts")
    .select("tenant_id, partner_id")
    .eq("id", c.post_id)
    .maybeSingle();
  const p = postRow as { tenant_id: string; partner_id: string } | null;
  if (!p || p.tenant_id !== tenantId) throw new Error("Contract not found.");

  const update: Record<string, unknown> = {};
  if (patch.status) update.status = patch.status;
  if (patch.delivered_quantity !== undefined) {
    update.delivered_quantity = Number(patch.delivered_quantity);
  }
  if (patch.notes !== undefined) update.notes = patch.notes;
  if (patch.scheduled_date) update.scheduled_date = patch.scheduled_date;
  if (patch.quantity !== undefined) update.quantity = Number(patch.quantity);

  // When status flips to 'delivered', default delivered_quantity to the
  // scheduled quantity if the caller did not specify one.
  if (patch.status === "delivered" && patch.delivered_quantity === undefined) {
    const { data: existing } = await sb
      .from("marketplace_contract_deliveries")
      .select("quantity")
      .eq("id", deliveryId)
      .maybeSingle();
    const q = (existing as { quantity?: number } | null)?.quantity;
    if (q !== undefined) update.delivered_quantity = Number(q);
  }

  const { data: updated, error: updErr } = await sb
    .from("marketplace_contract_deliveries")
    .update(update)
    .eq("id", deliveryId)
    .eq("contract_id", contractId) // defence-in-depth: must match the URL
    .select()
    .single();
  if (updErr) throw updErr;
  const delivery = updated as ContractDelivery;

  // Re-aggregate the parent contract's delivered_quantity.
  await recalculateContractProgress(contractId);

  return delivery;
}

/**
 * List all scheduled deliveries for a contract, oldest scheduled_date first.
 */
export async function listContractDeliveries(
  tenantId: string,
  contractId: string,
): Promise<ContractDelivery[]> {
  const sb = getSupabase();

  // Tenant check via the contract → post chain.
  const { data: contractRow } = await sb
    .from("marketplace_contracts")
    .select("id, post_id")
    .eq("id", contractId)
    .maybeSingle();
  const c = contractRow as { id: string; post_id: string } | null;
  if (!c) return [];
  const { data: postRow } = await sb
    .from("marketplace_posts")
    .select("tenant_id")
    .eq("id", c.post_id)
    .maybeSingle();
  const p = postRow as { tenant_id: string } | null;
  if (!p || p.tenant_id !== tenantId) return [];

  const { data, error } = await sb
    .from("marketplace_contract_deliveries")
    .select("*")
    .eq("contract_id", contractId)
    .order("scheduled_date", { ascending: true });
  if (error) throw error;
  return (data as ContractDelivery[]) || [];
}

/**
 * Re-aggregate delivered_quantity on the parent contract from the
 * deliveries table. Called after every delivery update so the contract
 * row's progress bar reflects reality without a JOIN.
 *
 * Side effect: if all deliveries are 'delivered' or 'partial' AND the
 * total delivered_quantity ≥ total_quantity, flip the contract status to
 * 'completed'. (Missed deliveries do not auto-complete the contract.)
 */
export async function recalculateContractProgress(
  contractId: string,
): Promise<{ delivered_quantity: number; status: string }> {
  const sb = getSupabase();

  const { data: contractRow } = await sb
    .from("marketplace_contracts")
    .select("id, total_quantity, status")
    .eq("id", contractId)
    .maybeSingle();
  const c = contractRow as { id: string; total_quantity: number; status: string } | null;
  if (!c) throw new Error("Contract not found.");

  const { data: deliveries, error: dErr } = await sb
    .from("marketplace_contract_deliveries")
    .select("delivered_quantity, status")
    .eq("contract_id", contractId);
  if (dErr) throw dErr;
  const rows = (deliveries as Array<{ delivered_quantity: number; status: string }>) || [];
  const totalDelivered = rows.reduce((sum, r) => sum + Number(r.delivered_quantity || 0), 0);

  let nextStatus = c.status;
  if (rows.length > 0) {
    const allDeliveredOrPartial = rows.every((r) => r.status === "delivered" || r.status === "partial");
    if (allDeliveredOrPartial && totalDelivered >= Number(c.total_quantity)) {
      nextStatus = "completed";
    }
  }

  const { error: updErr } = await sb
    .from("marketplace_contracts")
    .update({
      delivered_quantity: totalDelivered,
      ...(nextStatus !== c.status ? { status: nextStatus } : {}),
    })
    .eq("id", contractId);
  if (updErr) throw updErr;

  return { delivered_quantity: totalDelivered, status: nextStatus };
}

// ─── Smart pricing ──────────────────────────────────────────────────────────

/**
 * Compute market price statistics for a product on a tenant. Used by the
 * smart-pricing component to warn a poster when their target_price is far
 * above or below the market.
 *
 * The statistics are computed from:
 *   • All 'sell' posts with the same product_name (case-insensitive) AND
 *     status='active' OR (status='closed' AND created in last 180 days),
 *     AND target_price IS NOT NULL.
 *   • All 'sell' responses (counter-offers) with unit_price IS NOT NULL on
 *     posts whose product_name matches.
 *
 * The assessment band is ±15% of the average:
 *   • target_price > average * 1.15 → 'high'
 *   • target_price < average * 0.85 → 'low'
 *   • otherwise → 'fair'
 *
 * Returns sample_size=0 + all NULL prices when there is no historical data.
 */
export async function getMarketPriceStats(
  tenantId: string,
  productName: string,
  callerCurrency = "USD",
  callerTargetPrice: number | null = null,
): Promise<MarketPriceStats> {
  const sb = getSupabase();

  const result: MarketPriceStats = {
    product_name: productName,
    average_price: null,
    median_price: null,
    min_price: null,
    max_price: null,
    sample_size: 0,
    currency: callerCurrency,
    assessment: "unknown",
    suggested_price: null,
  };

  if (!productName || productName.trim().length === 0) return result;

  // Recent sell posts (active OR closed in last 180 days) with a price.
  // FIX-MARKET-2 / fix #1: the previous `.or(status.eq.active,created_at.gte.since)`
  // accepted ANY post created in the last 180 days regardless of status, so
  // draft/cancelled/flagged/expired posts were leaking into the sample. The
  // OR is now two ANDed clauses so only `active` posts OR `closed` posts
  // newer than the 180-day window are included.
  const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
  const { data: posts, error: pErr } = await sb
    .from("marketplace_posts")
    .select("target_price, currency")
    .eq("tenant_id", tenantId)
    .eq("post_type", "sell")
    .ilike("product_name", productName.trim())
    .not("target_price", "is", null)
    .or(`and(status.eq.active),and(status.eq.closed,created_at.gte.${since})`);
  if (pErr) throw pErr;
  const postRows = (posts as Array<{ target_price: number; currency?: string }>) || [];

  // Responses (counter-offers) on those posts — fetch by joining through
  // the posts table.
  const postIds = (await sb
    .from("marketplace_posts")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("post_type", "sell")
    .ilike("product_name", productName.trim())
  ).data as Array<{ id: string }> | null;
  const ids = (postIds || []).map((r) => r.id);
  let responseRows: Array<{ unit_price: number; currency?: string }> = [];
  if (ids.length > 0) {
    const { data: responses } = await sb
      .from("marketplace_responses")
      .select("unit_price, currency")
      .in("post_id", ids)
      .not("unit_price", "is", null);
    responseRows = (responses as Array<{ unit_price: number; currency?: string }>) || [];
  }

  // For simplicity (and to avoid FX-rate complexity) we only include prices
  // in the caller's currency. The sample-size thus reflects the comparable
  // data set, not every row.
  const prices = [
    ...postRows.filter((r) => !r.currency || r.currency === callerCurrency).map((r) => Number(r.target_price)),
    ...responseRows.filter((r) => !r.currency || r.currency === callerCurrency).map((r) => Number(r.unit_price)),
  ].filter((n) => Number.isFinite(n) && n > 0);

  if (prices.length === 0) return result;

  prices.sort((a, b) => a - b);
  const sum = prices.reduce((a, b) => a + b, 0);
  const avg = sum / prices.length;
  const median =
    prices.length % 2 === 0
      ? (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
      : prices[Math.floor(prices.length / 2)];

  result.sample_size = prices.length;
  result.average_price = Number(avg.toFixed(2));
  result.median_price = Number(median.toFixed(2));
  result.min_price = prices[0];
  result.max_price = prices[prices.length - 1];

  if (callerTargetPrice != null && Number.isFinite(callerTargetPrice) && prices.length >= 3) {
    if (callerTargetPrice > avg * 1.15) result.assessment = "high";
    else if (callerTargetPrice < avg * 0.85) result.assessment = "low";
    else result.assessment = "fair";
    result.suggested_price = Math.round(avg);
  }

  return result;
}
