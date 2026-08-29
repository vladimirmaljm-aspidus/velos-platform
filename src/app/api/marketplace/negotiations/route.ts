import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { listNegotiations, createNegotiation } from "@/lib/data/marketplace-store";
import { getSupabase } from "@/lib/supabase/client";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/negotiations — list the caller's negotiations
// (either as partner_a or partner_b).
async function _get(_req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  try {
    const items = await listNegotiations(access.tenant_id, access.partner_id);
    return NextResponse.json({ items });
  } catch (e: any) {
    console.error("[marketplace.negotiations.list]", e);
    return NextResponse.json({ error: "Failed to load negotiations." }, { status: 500 });
  }
}

// POST /api/marketplace/negotiations — create a negotiation room.
// Body:
//   { post_id, response_id?, partner_id_b, tenant_id_b }
// The caller is partner_id_a (the responder, OR the post owner opening a
// chat with a responder). The route resolves partner_id_b/tenant_id_b
// when the caller is the responder by looking up the post owner.
async function _post(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  // AUDIT2-LOGIC-UX H7 — gate negotiation creation on KYC approval.
  const _kycBlock = await requireKycApproved(access);
  if (_kycBlock) return _kycBlock;

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body.post_id) {
    return NextResponse.json({ error: "post_id is required." }, { status: 400 });
  }

  // Resolve the post + the OTHER party (partner_id_b, tenant_id_b).
  // If the caller is the post owner, they need to supply partner_id_b
  // (the responder they want to chat with). If the caller is a responder,
  // the OTHER party is the post owner — resolve it from the post.
  const sb = getSupabase();
  const { data: post, error: postErr } = await sb
    .from("marketplace_posts")
    .select("id, tenant_id, partner_id, status")
    .eq("id", body.post_id)
    .maybeSingle();
  if (postErr) {
    console.error("[marketplace.negotiations.create] post lookup failed:", postErr);
    return NextResponse.json({ error: "Failed to load post." }, { status: 500 });
  }
  if (!post || (post as any).tenant_id !== access.tenant_id) {
    return NextResponse.json({ error: "Post not found." }, { status: 404 });
  }
  const p = post as { id: string; tenant_id: string; partner_id: string; status: string };
  const callerIsOwner = p.partner_id === access.partner_id;

  // FIX-MARKET-2 / fix #5: a negotiation room cannot be opened on a post
  // that is no longer active. Block closed/cancelled/flagged/expired posts
  // — partners who missed the window can ask the owner to repost instead
  // of resurrecting a dead thread. We do NOT honour the "expired with
  // 7-day grace" option because the store's response-creation gate already
  // hard-blocks expired posts, so opening a negotiation would be a no-op
  // anyway (no new responses could be added).
  if (p.status !== "active") {
    return NextResponse.json({ error: "Post is no longer active." }, { status: 400 });
  }

  let partnerIdB: string;
  let tenantIdB: string;
  if (callerIsOwner) {
    // Owner must supply the responder's partner_id.
    if (!body.partner_id_b) {
      return NextResponse.json({ error: "partner_id_b is required." }, { status: 400 });
    }
    partnerIdB = String(body.partner_id_b);
    tenantIdB = access.tenant_id;

    // FIX-MARKET-2 / fix #4: the owner may only open a negotiation with a
    // partner who has ACTUALLY responded to this post. Without this guard,
    // a post owner could open a negotiation with ANY partner_id in the
    // tenant (including partners who never expressed interest), which
    // would leak the negotiation-thread / message surface to arbitrary
    // partners and bypass the "response-first" gate the marketplace UI
    // assumes.
    const { data: responderRows, error: respErr } = await sb
      .from("marketplace_responses")
      .select("partner_id")
      .eq("post_id", body.post_id);
    if (respErr) {
      console.error("[marketplace.negotiations.create] responder lookup failed:", respErr);
      return NextResponse.json({ error: "Failed to verify responder." }, { status: 500 });
    }
    const responderIds = new Set(
      ((responderRows as Array<{ partner_id: string }> | null) ?? []).map(
        (r) => r.partner_id,
      ),
    );
    if (!responderIds.has(partnerIdB)) {
      return NextResponse.json(
        { error: "You can only open a negotiation with a partner who has responded to this post." },
        { status: 400 },
      );
    }
  } else {
    // Responder → the OTHER party is the post owner.
    partnerIdB = p.partner_id;
    tenantIdB = p.tenant_id;
    // The responder must NOT already be the owner of the post (the store
    // checks this too, but we surface a clear error here).
  }

  try {
    const created = await createNegotiation(
      access.tenant_id,
      access.partner_id,
      {
        post_id: body.post_id,
        response_id: body.response_id ?? null,
        partner_id_b: partnerIdB,
        tenant_id_b: tenantIdB,
      },
    );
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.negotiation_created",
        "marketplace_negotiation",
        created.id,
        { post_id: body.post_id, partner_id_b: partnerIdB },
      );
    } catch (e) {
      console.error("[marketplace.negotiations.create] audit failed:", e);
    }
    return NextResponse.json(created);
  } catch (e: any) {
    console.error("[marketplace.negotiations.create]", e);
    const msg = e?.message || "Failed to create negotiation.";
    const status = /not found/i.test(msg) ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/negotiations");
export const POST = withApm(_post, "POST /api/marketplace/negotiations");
