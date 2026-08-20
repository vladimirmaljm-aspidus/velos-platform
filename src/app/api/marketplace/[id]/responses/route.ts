import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import {
  listMarketplaceResponses,
  createMarketplaceResponse,
} from "@/lib/data/marketplace-store";
import { getSupabase } from "@/lib/supabase/client";
import { sanitizeFields } from "@/lib/security/sanitize-input";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { notify } from "@/lib/notif/helper";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/[id]/responses — list responses to a post.
// Only the POST OWNER sees all responses; responders see only their own
// (handled by the my-responses route). Here we filter by ownership.
async function _get(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;

  // Only the post owner can list all responses — responders use the
  // /my-responses endpoint.
  const { getSupabase } = await import("@/lib/supabase/client");
  const sb = getSupabase();
  const { data: post, error: postErr } = await sb
    .from("marketplace_posts")
    .select("id, tenant_id, partner_id")
    .eq("id", id)
    .maybeSingle();
  if (postErr) {
    console.error("[marketplace.responses.get] post lookup failed:", postErr);
    return NextResponse.json({ error: "Failed to load post." }, { status: 500 });
  }
  if (!post || (post as any).tenant_id !== access.tenant_id) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if ((post as any).partner_id !== access.partner_id) {
    return NextResponse.json({ error: "Only the post owner can list responses." }, { status: 403 });
  }

  try {
    const items = await listMarketplaceResponses(id, access.tenant_id);
    return NextResponse.json({ items });
  } catch (e: any) {
    console.error("[marketplace.responses.get]", e);
    return NextResponse.json({ error: "Failed to load responses." }, { status: 500 });
  }
}

// POST /api/marketplace/[id]/responses — create a response (offer).
// The caller is the RESPONDER (not the post owner). The store verifies
// the post is active and not owned by the caller.
async function _post(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Validate numeric fields if provided.
  if (body.quantity !== undefined && body.quantity !== null && body.quantity !== "") {
    const q = Number(body.quantity);
    if (!Number.isFinite(q) || q <= 0 || q > 1_000_000_000) {
      return NextResponse.json({ error: "Quantity must be a positive number." }, { status: 400 });
    }
    body.quantity = q;
  }
  if (body.unit_price !== undefined && body.unit_price !== null && body.unit_price !== "") {
    const p = Number(body.unit_price);
    if (!Number.isFinite(p) || p < 0 || p > 1_000_000_000) {
      return NextResponse.json({ error: "Unit price must be a non-negative number." }, { status: 400 });
    }
    body.unit_price = p;
  }

  body = sanitizeFields(body, [
    "delivery_location",
    "incoterm",
    "payment_terms",
    "message",
    "currency",
  ]);

  // Strip caller-supplied identity fields — stamped from auth context.
  delete body.id;
  delete body.tenant_id;
  delete body.partner_id;
  delete body.portal_access_id;
  delete body.status;
  delete body.contact_revealed;
  delete body.created_at;
  delete body.updated_at;

  try {
    const created = await createMarketplaceResponse(
      access.tenant_id,
      access.partner_id,
      access.id,
      {
        post_id: id,
        ...body,
      },
    );
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.response_created",
        "marketplace_response",
        created.id,
        { post_id: id, unit_price: created.unit_price },
      );
    } catch (e) {
      console.error("[marketplace.response.create] audit failed:", e);
    }
    // Notify the post owner that a new response arrived (Phase 2). The
    // notification is fire-and-forget — a failure here must not block the
    // responder's HTTP response. We look up the post owner's partner_id
    // via the supabase client (the store strips it from the response row
    // before returning).
    try {
      const sb = getSupabase();
      const { data: postRow } = await sb
        .from("marketplace_posts")
        .select("partner_id, product_name")
        .eq("id", id)
        .maybeSingle();
      const ownerPartnerId = (postRow as { partner_id?: string } | null)?.partner_id;
      const productName = (postRow as { product_name?: string } | null)?.product_name ?? "your post";
      if (ownerPartnerId && ownerPartnerId !== access.partner_id) {
        await notify({
          tenantId: access.tenant_id,
          partnerId: ownerPartnerId,
          type: "marketplace_response_received",
          title: "New marketplace response",
          message: `A partner responded to "${productName}".`,
          entityType: "marketplace_post",
          entityId: id,
          actionUrl: `/portal/marketplace/${id}`,
          actionLabel: "View post",
        });
      }
    } catch (e) {
      console.error("[marketplace.response.create] notify failed:", e);
    }

    return NextResponse.json(created);
  } catch (e: any) {
    console.error("[marketplace.response.create]", e);
    const msg = e?.message || "Failed to create response.";
    // Surface "post not found" / "post expired" as 400 instead of 500.
    const status = /not found|expired|not active|own post/i.test(msg) ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/[id]/responses");
export const POST = withApm(_post, "POST /api/marketplace/[id]/responses");
