import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireMarketplacePoster, requireMarketplaceEnabled } from "@/lib/portal/marketplace-gate";
import { requirePortalModule } from "@/lib/portal/module-permissions";
import { validateStatusTransition } from "@/lib/api/status-validator";
import {
  getMarketplacePost,
  updateMarketplacePost,
  deleteMarketplacePost,
  getMarketplaceTenantSettings,
  validateAuctionParams,
} from "@/lib/data/marketplace-store";
import { getSupabase } from "@/lib/supabase/client";
import { sanitizeFields } from "@/lib/security/sanitize-input";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";
import { trackPortalEvent } from "@/lib/portal/partner-events";

export const runtime = "nodejs";

// GET /api/marketplace/[id] — fetch a single post (and increment views).
// Returns the sanitised public shape (no partner_id / tenant_id).
async function _get(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  // 099 — module + tenant gates (same as the list route).
  const _moduleBlock = await requirePortalModule(access, "marketplace");
  if (_moduleBlock) return _moduleBlock;
  const { id } = await ctx.params;
  try {
    const post = await getMarketplacePost(id, access.tenant_id, access.partner_id);
    if (!post) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    // 37 — per-partner activity event: which marketplace listings this
    // client actually opened (the global views_count column can't answer
    // "who looked at what"). Fire-and-forget, no-op pre-migration-091.
    void trackPortalEvent(access, req, {
      type: "marketplace_viewed",
      entity_type: "marketplace_post",
      entity_id: id,
      label: (post as any).product_name || (post as any).title || id,
      details: {
        post_type: (post as any).post_type ?? null,
        category: (post as any).category ?? null,
        price: (post as any).price ?? null,
        currency: (post as any).currency ?? null,
      },
    });
    return NextResponse.json({ post });
  } catch (e: any) {
    console.error("[marketplace.get]", e);
    return NextResponse.json({ error: "Failed to load post." }, { status: 500 });
  }
}

// PUT /api/marketplace/[id] — update a post (only the owner).
async function _put(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  // 099 — module + tenant gates; the posting ladder applies to every
  // mutation (an owner whose tier/KYC was downgraded since creation must
  // not keep editing their listings — mirrors the AUDIT4-PATHS Fix 2
  // rationale).
  const _moduleBlock = await requirePortalModule(access, "marketplace.post");
  if (_moduleBlock) return _moduleBlock;
  const _enabledBlock = await requireMarketplaceEnabled(access);
  if (_enabledBlock) return _enabledBlock;
  const _posterBlock = await requireMarketplacePoster(access);
  if (_posterBlock) return _posterBlock;
  const { id } = await ctx.params;

  // Verify ownership — fetch raw post row (not the sanitised public shape).
  // AUDIT4-PATHS / Fix 3 — also fetch `status` so we can validate the
  // transition below (the previous SELECT only included id / tenant_id /
  // partner_id, so the existing status was unknown at the API layer).
  const sb = getSupabase();
  const { data: raw, error: rawErr } = await sb
    .from("marketplace_posts")
    .select("id, tenant_id, partner_id, status, post_type")
    .eq("id", id)
    .maybeSingle();
  if (rawErr) {
    console.error("[marketplace.put] ownership lookup failed:", rawErr);
    return NextResponse.json({ error: "Failed to load post." }, { status: 500 });
  }
  if (!raw || (raw as any).tenant_id !== access.tenant_id) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if ((raw as any).partner_id !== access.partner_id) {
    return NextResponse.json({ error: "Only the post owner can modify it." }, { status: 403 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Validate enums that may be patched.
  const allowedStatus = ["draft", "pending", "active", "closed", "expired", "flagged"];
  if (body.status && !allowedStatus.includes(body.status)) {
    return NextResponse.json({ error: "Invalid status." }, { status: 400 });
  }
  // AUDIT4-PATHS / Fix 3 — marketplace post state machine. Without
  // this guard, a post owner could revive an expired post (expired →
  // active), re-open a closed post (closed → active), or un-flag a
  // flagged post (flagged → active) without admin review. The graph
  // (defined in status-validator.ts) is: draft → active; active →
  // closed / expired / cancelled / flagged; flagged → active (admin
  // un-flag only); closed / expired / cancelled → terminal. We only
  // validate when the caller is actually changing the status — a
  // no-op PUT (same status) is always valid. Portal clients are
  // never super-admins, so the bypass in status-validator.ts's header
  // does not apply here.
  {
    const _existingStatus = (raw as any)?.status as string | undefined;
    if (body.status && _existingStatus && body.status !== _existingStatus) {
      const _postTransition = validateStatusTransition(
        "marketplace_post",
        _existingStatus,
        body.status,
      );
      if (!_postTransition.valid) {
        return NextResponse.json(
          { error: _postTransition.error },
          { status: 409 },
        );
      }
    }
  }
  const allowedVisibility = ["public", "private"];
  if (body.visibility && !allowedVisibility.includes(body.visibility)) {
    return NextResponse.json({ error: "Invalid visibility." }, { status: 400 });
  }
  if (body.quantity !== undefined && body.quantity !== null) {
    const q = Number(body.quantity);
    if (!Number.isFinite(q) || q <= 0 || q > 1_000_000_000) {
      return NextResponse.json({ error: "Quantity must be a positive number." }, { status: 400 });
    }
    body.quantity = q;
  }
  if (body.target_price !== undefined && body.target_price !== null && body.target_price !== "") {
    const p = Number(body.target_price);
    if (!Number.isFinite(p) || p < 0 || p > 1_000_000_000) {
      return NextResponse.json({ error: "Target price must be a non-negative number." }, { status: 400 });
    }
    body.target_price = p;
  }

  body = sanitizeFields(body, [
    "product_name",
    "product_category",
    "product_subcategory",
    "delivery_location",
    "delivery_country",
    "incoterm",
    "origin_country",
    "packaging",
    "payment_terms",
    "description",
  ]);

  // 100 — auction parameters are writable ONLY while the post has zero
  // bids (pre-bid); once any bid exists every defining field is
  // immutable. Extends the FIX-MARKET-2 lock with auction_type + full
  // route-level validation (shared with the create route so the messages
  // never drift) + the server-owned-field strip + the pre-bid
  // current-price mirror.
  //
  // FIX-MARKET-2 / fix #2 (original): mutating post_type /
  // auction_ends_at / auction_start_price / auction_reserve_price /
  // auction_min_increment after bids are placed would retroactively
  // change the rules of an active auction and let an owner manipulate
  // the outcome. Reject with 400.
  //
  // Server-owned auction lifecycle fields are never writable by callers:
  // auction_current_price mirrors auction_start_price while there are no
  // bids (set below), auction_winner_id is set by processAuctionEnd().
  delete body.auction_winner_id;
  delete body.auction_current_price;

  const auctionParamsPresent =
    body.post_type !== undefined ||
    body.auction_type !== undefined ||
    body.auction_ends_at !== undefined ||
    body.auction_start_price !== undefined ||
    body.auction_reserve_price !== undefined ||
    body.auction_min_increment !== undefined;
  if (auctionParamsPresent) {
    // Auction params only make sense on auction posts — check against the
    // EFFECTIVE type (patched post_type, else the stored one).
    const effectivePostType =
      (body.post_type as string | undefined) ?? (raw as { post_type?: string }).post_type;
    if (effectivePostType !== "auction") {
      return NextResponse.json(
        { error: "Auction parameters can only be set on auction posts." },
        { status: 400 },
      );
    }
    // Shared validator (same rules as POST /api/marketplace): enum,
    // start > 0, reserve ≥ 0, ends_at ISO > now + 1h, min increment ≥ 1.
    const auctionErr = validateAuctionParams(body);
    if (auctionErr) {
      return NextResponse.json({ error: auctionErr }, { status: 400 });
    }
    // The auction lock: any bid on this post freezes every defining param.
    const { data: existingBid } = await sb
      .from("marketplace_auction_bids")
      .select("id")
      .eq("post_id", id)
      .limit(1)
      .maybeSingle();
    if (existingBid) {
      return NextResponse.json(
        { error: "Cannot change auction parameters after bids are placed." },
        { status: 400 },
      );
    }
    // Pre-bid start-price change → keep auction_current_price in sync
    // (with zero bids the current price is still the opening price).
    if (body.auction_start_price !== undefined && body.auction_start_price !== null) {
      body.auction_current_price = body.auction_start_price;
    }
  }

  try {
    // 099 — moderated publishing: when the tenant requires approval, an
    // owner publishing a draft (draft → active) lands on 'pending' instead
    // — the post enters the feed only after an admin approves it. The
    // response carries `pending_approval: true` so the My-Posts UI can
    // show "awaiting approval" instead of "active".
    let effectiveBody = body;
    if (body.status === "active" && (raw as any).status === "draft") {
      try {
        const settings = await getMarketplaceTenantSettings(access.tenant_id);
        if (settings.require_approval) {
          effectiveBody = { ...body, status: "pending" };
        }
      } catch {
        // Settings read failure — keep the requested status.
      }
    }
    const updated = await updateMarketplacePost(id, access.tenant_id, effectiveBody);
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.post_updated",
        "marketplace_post",
        id,
        { status: effectiveBody.status, visibility: effectiveBody.visibility },
      );
    } catch (e) {
      console.error("[marketplace.put] audit failed:", e);
    }
    return NextResponse.json({
      post: updated,
      pending_approval: effectiveBody.status === "pending" && body.status === "active",
    });
  } catch (e: any) {
    console.error("[marketplace.put]", e);
    return NextResponse.json({ error: sanitizeError(e)}, { status: 500 });
  }
}

// DELETE /api/marketplace/[id] — delete a post (owner only). Cascades to
// responses / negotiations / messages.
async function _delete(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  // 100 — gate parity with PUT: the DELETE handler previously had NO
  // gates at all (GET/PUT were fully gated in 099) — a tenant with the
  // marketplace disabled, a module-denied user, or a downgraded
  // tier/KYC could still delete their posts. Same three gates as PUT.
  const _moduleBlock = await requirePortalModule(access, "marketplace.post");
  if (_moduleBlock) return _moduleBlock;
  const _enabledBlock = await requireMarketplaceEnabled(access);
  if (_enabledBlock) return _enabledBlock;
  const _posterBlock = await requireMarketplacePoster(access);
  if (_posterBlock) return _posterBlock;
  const { id } = await ctx.params;

  const sb = getSupabase();
  const { data: raw, error: rawErr } = await sb
    .from("marketplace_posts")
    .select("id, tenant_id, partner_id")
    .eq("id", id)
    .maybeSingle();
  if (rawErr) {
    console.error("[marketplace.delete] ownership lookup failed:", rawErr);
    return NextResponse.json({ error: "Failed to load post." }, { status: 500 });
  }
  if (!raw || (raw as any).tenant_id !== access.tenant_id) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if ((raw as any).partner_id !== access.partner_id) {
    return NextResponse.json({ error: "Only the post owner can delete it." }, { status: 403 });
  }

  try {
    await deleteMarketplacePost(id, access.tenant_id);
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.post_deleted",
        "marketplace_post",
        id,
      );
    } catch (e) {
      console.error("[marketplace.delete] audit failed:", e);
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[marketplace.delete]", e);
    return NextResponse.json({ error: sanitizeError(e)}, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/[id]");
export const PUT = withApm(_put, "PUT /api/marketplace/[id]");
export const DELETE = withApm(_delete, "DELETE /api/marketplace/[id]");
