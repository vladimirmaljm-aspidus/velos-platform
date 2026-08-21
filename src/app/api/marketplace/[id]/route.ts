import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import {
  getMarketplacePost,
  updateMarketplacePost,
  deleteMarketplacePost,
} from "@/lib/data/marketplace-store";
import { getSupabase } from "@/lib/supabase/client";
import { sanitizeFields } from "@/lib/security/sanitize-input";
import { audit } from "@/lib/api/helpers";
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
  const { id } = await ctx.params;

  // Verify ownership — fetch raw post row (not the sanitised public shape).
  const sb = getSupabase();
  const { data: raw, error: rawErr } = await sb
    .from("marketplace_posts")
    .select("id, tenant_id, partner_id")
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
    return NextResponse.json({ error: e.message || "Failed to update post." }, { status: 500 });
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
    return NextResponse.json({ error: e.message || "Failed to delete post." }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/[id]");
export const PUT = withApm(_put, "PUT /api/marketplace/[id]");
export const DELETE = withApm(_delete, "DELETE /api/marketplace/[id]");
