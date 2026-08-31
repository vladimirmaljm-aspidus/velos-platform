import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { validateStatusTransition } from "@/lib/api/status-validator";
import {
  getMarketplacePost,
  updateMarketplacePost,
  deleteMarketplacePost,
} from "@/lib/data/marketplace-store";
import { getSupabase } from "@/lib/supabase/client";
import { sanitizeFields } from "@/lib/security/sanitize-input";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/[id] — fetch a single post (and increment views).
// Returns the sanitised public shape (no partner_id / tenant_id).
async function _get(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const post = await getMarketplacePost(id, access.tenant_id, access.partner_id);
    if (!post) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
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
  // AUDIT4-PATHS / Fix 2 — gate marketplace PUT on KYC approval. A
  // portal client whose KYC has been suspended / rejected must not be
  // able to mutate existing posts (price, quantity, status, visibility).
  // Combined with the missing transition graph (Fix 3 below), an
  // unverified partner could otherwise revive an expired/closed/flagged
  // post by setting status="active". Mirrors the gate on the POST route.
  const _kycBlock = await requireKycApproved(access);
  if (_kycBlock) return _kycBlock;
  const { id } = await ctx.params;

  // Verify ownership — fetch raw post row (not the sanitised public shape).
  // AUDIT4-PATHS / Fix 3 — also fetch `status` so we can validate the
  // transition below (the previous SELECT only included id / tenant_id /
  // partner_id, so the existing status was unknown at the API layer).
  const sb = getSupabase();
  const { data: raw, error: rawErr } = await sb
    .from("marketplace_posts")
    .select("id, tenant_id, partner_id, status")
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
  const allowedStatus = ["draft", "active", "closed", "expired", "flagged"];
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

  // FIX-MARKET-2 / fix #2: if the post already has bids (auction_bids table
  // rows for this post_id), the owner may NOT change auction-defining fields.
  // Mutating post_type / auction_ends_at / auction_start_price /
  // auction_reserve_price / auction_min_increment after bids are placed
  // would retroactively change the rules of an active auction and let an
  // owner manipulate the outcome. Reject with 400.
  const auctionParamsPresent =
    body.post_type !== undefined ||
    body.auction_ends_at !== undefined ||
    body.auction_start_price !== undefined ||
    body.auction_reserve_price !== undefined ||
    body.auction_min_increment !== undefined;
  if (auctionParamsPresent) {
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
  }

  try {
    const updated = await updateMarketplacePost(id, access.tenant_id, body);
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.post_updated",
        "marketplace_post",
        id,
        { status: body.status, visibility: body.visibility },
      );
    } catch (e) {
      console.error("[marketplace.put] audit failed:", e);
    }
    return NextResponse.json({ post: updated });
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
