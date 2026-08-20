import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { listContractDeliveries } from "@/lib/data/marketplace-auction-store";
import { getSupabase } from "@/lib/supabase/client";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/[id]/contract/deliveries — list scheduled deliveries
// for the contract attached to a post. Visible to the post owner + the
// counterparty (when there is one). The store filters by tenant via the
// FK chain contract → post → tenant_id.
async function _get(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;

  // Verify post is in caller's tenant + is a contract post.
  const sb = getSupabase();
  const { data: postRow, error: postErr } = await sb
    .from("marketplace_posts")
    .select("tenant_id, partner_id, post_type")
    .eq("id", id)
    .maybeSingle();
  if (postErr) {
    console.error("[marketplace.contract.deliveries.get] post lookup failed:", postErr);
    return NextResponse.json({ error: "Failed to load post." }, { status: 500 });
  }
  if (!postRow) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const post = postRow as { tenant_id: string; partner_id: string; post_type: string };
  if (post.tenant_id !== access.tenant_id) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (post.post_type !== "contract") {
    return NextResponse.json({ error: "Post is not a contract offer." }, { status: 400 });
  }

  // Look up the contract row on this post.
  const { data: contractRow } = await sb
    .from("marketplace_contracts")
    .select("id")
    .eq("post_id", id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const contract = contractRow as { id: string } | null;
  if (!contract) return NextResponse.json({ items: [] });

  try {
    const items = await listContractDeliveries(access.tenant_id, contract.id);
    const isOwner = post.partner_id === access.partner_id;
    return NextResponse.json({
      items: isOwner
        ? items
        : items.map((d) => ({ ...d, notes: d.notes ? "—" : null })), // hide free-text notes for non-owners
      is_owner: isOwner,
    });
  } catch (e: any) {
    console.error("[marketplace.contract.deliveries.get]", e);
    return NextResponse.json({ error: "Failed to load deliveries." }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/[id]/contract/deliveries");
