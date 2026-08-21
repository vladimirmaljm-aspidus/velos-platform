import { NextRequest, NextResponse } from "next/server";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase/client";
import { authorizeCron } from "@/lib/api/cron-auth";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { processAuctionEnd } from "@/lib/data/marketplace-auction-store";
import { triggerWebhooks } from "@/lib/webhooks/deliver";

export const runtime = "nodejs";

/**
 * Cron endpoint — periodic marketplace maintenance sweep.
 *
 * Three responsibilities, run in order:
 *
 *   1. Settle ended auctions. For every marketplace_posts row whose
 *      post_type='auction' AND status='active' AND auction_ends_at is in
 *      the past AND auction_winner_id IS NULL, call
 *      processAuctionEnd() — it determines the winner (highest bid ≥
 *      reserve price for english/sealed; already-set for dutch) and
 *      flips status='closed'. Idempotent: a row whose auction_winner_id
 *      is already set is left untouched.
 *
 *   2. Lower Dutch auction prices. For every active Dutch auction whose
 *      auction_ends_at is in the future, drop auction_current_price by the
 *      configured step (5% of auction_start_price, minimum 1 currency
 *      unit). This implements the "descending ask" — the longer an auction
 *      sits unsold, the cheaper it gets. The drop is capped at the
 *      auction_reserve_price so a Dutch auction never prices below the
 *      seller's floor.
 *
 *   3. Expire stale posts. For every active marketplace_posts row whose
 *      expires_at is in the past, flip status='expired'. This is the
 *      soft-delete pattern: the row stays in the table for analytics +
 *      audit, but it disappears from the active list and from search.
 *
 * Authentication: caller must supply `Authorization: Bearer <CRON_TOKEN>`
 * header (preferred), `?token=…` URL query (legacy), OR a valid
 * super_admin session cookie (for manual runs from the browser). The
 * route never modifies rows when unauthenticated — see `authorizeCron`.
 *
 * Scheduling: this cron is meant to run every 5–15 minutes (more often
 * than the daily data-retention cron, because Dutch auctions need to
 * price-step + auctions need to settle within a few minutes of their
 * end time). Configure in pg_cron / Vercel Cron as needed.
 *
 * Safety:
 *   • Each step is wrapped in its own try/catch — a failure on one
 *     sweep does NOT abort the others (e.g. an auction settle failure
 *     on one post still lets Dutch price-drops + expiry run).
 *   • `processAuctionEnd` is itself idempotent (it no-ops on rows
 *     whose auction_winner_id is already set).
 *   • All updates use the service_role client which bypasses RLS —
 *     intentional for a cron, gated behind `authorizeCron`.
 */
export async function GET(req: NextRequest) {
  try {
    // Auth: shared cron token (header preferred, URL query legacy) OR a
    // super_admin session cookie (for manual runs from the browser).
    const unauth = await authorizeCron(req);
    if (unauth) return unauth;

    if (!isSupabaseConfigured()) {
      return NextResponse.json(
        { error: "Supabase is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." },
        { status: 503 },
      );
    }

    const sb = getSupabase();
    const nowIso = new Date().toISOString();

    // ── Step 1: settle ended auctions ──────────────────────────────────
    // Fetch every active auction whose auction_ends_at is in the past
    // AND auction_winner_id is NULL. processAuctionEnd() will then
    // re-fetch + settle each one. Idempotent — running twice on the
    // same row is a no-op.
    const settlements: Array<{ id: string; ok: boolean; error?: string }> = [];
    try {
      const { data: endedAuctions, error: endedErr } = await sb
        .from("marketplace_posts")
        .select("id")
        .eq("post_type", "auction")
        .eq("status", "active")
        .not("auction_ends_at", "is", null)
        .lt("auction_ends_at", nowIso)
        .is("auction_winner_id", null);
      if (endedErr) throw endedErr;
      const ids = ((endedAuctions as Array<{ id: string }>) || []).map((r) => r.id);
      for (const id of ids) {
        try {
          await processAuctionEnd(id);
          settlements.push({ id, ok: true });
          // Phase 12 — fire marketplace.auction_won webhook when a winner
          // was determined. The settled row is the sanitised post shape
          // (no tenant_id / partner_id) — we re-fetch the post to get
          // the tenant_id (needed for the webhook trigger scope) and
          // the winner_id. Skip when no winner (auction ended with no
          // bids ≥ reserve — a legitimate outcome).
          try {
            const sb2 = getSupabase();
            const { data: postRow } = await sb2
              .from("marketplace_posts")
              .select("tenant_id, auction_winner_id, auction_current_price, currency")
              .eq("id", id)
              .maybeSingle();
            const p = postRow as { tenant_id?: string; auction_winner_id?: string | null; auction_current_price?: number | null; currency?: string | null } | null;
            if (p?.tenant_id && p.auction_winner_id) {
              const store = await getStore();
              void triggerWebhooks(store, p.tenant_id, "marketplace.auction_won", "marketplace_post", id, {
                post_id: id,
                winner_partner_id: p.auction_winner_id,
                winning_bid: p.auction_current_price ?? null,
                currency: p.currency ?? null,
              }).catch(() => {});
            }
          } catch (e) {
            console.error(`[cron/auction-sweep] auction_won webhook failed for ${id}:`, e);
          }
        } catch (e: any) {
          // One failed settlement must not abort the rest.
          console.error(`[cron/auction-sweep] settle failed for ${id}:`, e);
          settlements.push({ id, ok: false, error: e?.message || String(e) });
        }
      }
    } catch (e: any) {
      console.error("[cron/auction-sweep] ended-auctions fetch failed:", e);
    }

    // ── Step 2: lower Dutch auction prices ───────────────────────────
    // For every active Dutch auction still running (auction_ends_at in
    // the future), lower auction_current_price by 5% of
    // auction_start_price (min 1 currency unit). Capped at the reserve
    // price so the ask never falls below the seller's floor.
    //
    // We re-fetch on every cron tick rather than tracking the "last
    // drop time" — the 5-minute cron cadence IS the price-step cadence.
    // That keeps the data model simple (no extra column) and matches
    // the spec's "lower Dutch auction prices" requirement.
    let dutchDropped = 0;
    try {
      const { data: dutchAuctions, error: dutchErr } = await sb
        .from("marketplace_posts")
        .select(
          "id, auction_start_price, auction_current_price, auction_reserve_price, currency",
        )
        .eq("post_type", "auction")
        .eq("status", "active")
        .eq("auction_type", "dutch")
        .or(`auction_ends_at.is.null,auction_ends_at.gt.${nowIso}`);
      if (dutchErr) throw dutchErr;
      const dutchRows = (dutchAuctions as Array<{
        id: string;
        auction_start_price: number | null;
        auction_current_price: number | null;
        auction_reserve_price: number | null;
        currency?: string | null;
      }>) || [];
      for (const row of dutchRows) {
        try {
          const start = Number(row.auction_start_price ?? 0);
          const current = Number(row.auction_current_price ?? start);
          const reserve = Number(row.auction_reserve_price ?? 0);
          if (!Number.isFinite(current) || current <= 0) continue;
          // 5% of the start price, minimum 1 currency unit.
          const step = Math.max(1, start * 0.05);
          let next = current - step;
          // Cap at the reserve (the seller's floor) — a Dutch auction
          // never prices below the floor; if no bidder accepts by then,
          // the auction ends without a sale at auction_ends_at.
          if (reserve > 0 && next < reserve) next = reserve;
          if (next >= current) continue; // no movement (e.g. already at reserve)
          const { error: updErr } = await sb
            .from("marketplace_posts")
            .update({ auction_current_price: Number(next.toFixed(2)) })
            .eq("id", row.id);
          if (updErr) throw updErr;
          dutchDropped += 1;
        } catch (e: any) {
          // One Dutch price-drop failure must not abort the rest.
          console.error(`[cron/auction-sweep] dutch drop failed for ${row.id}:`, e);
        }
      }
    } catch (e: any) {
      console.error("[cron/auction-sweep] dutch-auctions fetch failed:", e);
    }

    // ── Step 3: expire stale posts ────────────────────────────────────
    // Flip status='expired' on every active post whose expires_at is in
    // the past. The row stays in the table for analytics + audit; the
    // marketplace store's listMarketplacePosts() filters on status='active'
    // so expired rows automatically disappear from the browse list.
    let expired = 0;
    try {
      const { data: expiredRows, error: expErr } = await sb
        .from("marketplace_posts")
        .update({ status: "expired" })
        .eq("status", "active")
        .lt("expires_at", nowIso)
        .select("id");
      if (expErr) throw expErr;
      expired = ((expiredRows as Array<{ id: string }>) || []).length;
    } catch (e: any) {
      console.error("[cron/auction-sweep] expire-stale failed:", e);
    }

    const settledOk = settlements.filter((s) => s.ok).length;
    const settledFailed = settlements.filter((s) => !s.ok).length;

    console.info(
      `[cron/auction-sweep] ran_at=${nowIso} ` +
      `auctions_settled=${settledOk} auctions_settle_failed=${settledFailed} ` +
      `dutch_dropped=${dutchDropped} posts_expired=${expired}`,
    );

    // P2 / task C-6 Fix 4: audit-log the sweep outcome so ops can verify
    // the cron is firing and triage per-step failures. The per-step
    // counts + the per-auction settle results go into `details`.
    const store = await getStore();
    await audit(
      store,
      { id: undefined, username: "cron", tenant_id: null },
      req,
      "cron.auction_sweep",
      "system",
      "cron",
      {
        ran_at: nowIso,
        auctions_settled: settledOk,
        auctions_settle_failed: settledFailed,
        dutch_dropped: dutchDropped,
        posts_expired: expired,
        settle_results: settlements,
      },
    );

    return NextResponse.json({
      ok: true,
      ran_at: nowIso,
      auctions_settled: settledOk,
      auctions_settle_failed: settledFailed,
      dutch_dropped: dutchDropped,
      posts_expired: expired,
    });
  } catch (e: any) {
    console.error("[cron/auction-sweep]", e);
    return NextResponse.json({ error: e?.message || "Internal server error" }, { status: 500 });
  }
}
