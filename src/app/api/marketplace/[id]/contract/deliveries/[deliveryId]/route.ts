import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { updateContractDelivery } from "@/lib/data/marketplace-auction-store";
import { getSupabase } from "@/lib/supabase/client";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";
import type { ContractDeliveryStatus } from "@/lib/supabase/marketplace-auction-types";

export const runtime = "nodejs";

// PUT /api/marketplace/[id]/contract/deliveries/[deliveryId] — update a
// scheduled delivery milestone. Only the post owner can do this. Body may
// include any subset of: { status, delivered_quantity, notes,
// scheduled_date, quantity }.
async function _put(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; deliveryId: string }> },
) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  // AUDIT2-LOGIC-UX H7 — gate delivery update on KYC approval.
  const _kycBlock = await requireKycApproved(access);
  if (_kycBlock) return _kycBlock;
  const { id, deliveryId } = await ctx.params;

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const patch: {
    status?: ContractDeliveryStatus;
    delivered_quantity?: number;
    notes?: string | null;
    scheduled_date?: string;
    quantity?: number;
  } = {};

  if (body.status) {
    const allowed: ContractDeliveryStatus[] = ["pending", "delivered", "partial", "missed"];
    if (!allowed.includes(body.status)) {
      return NextResponse.json({ error: "Invalid delivery status." }, { status: 400 });
    }
    patch.status = body.status;
  }
  if (body.delivered_quantity !== undefined && body.delivered_quantity !== null) {
    const q = Number(body.delivered_quantity);
    if (!Number.isFinite(q) || q < 0 || q > 1_000_000_000) {
      return NextResponse.json({ error: "delivered_quantity must be a non-negative number." }, { status: 400 });
    }
    patch.delivered_quantity = q;
  }
  if (body.notes !== undefined) {
    patch.notes = typeof body.notes === "string" ? body.notes.slice(0, 5000) : null;
  }
  if (body.scheduled_date) {
    const d = new Date(body.scheduled_date);
    if (!Number.isFinite(d.getTime())) {
      return NextResponse.json({ error: "Invalid scheduled_date." }, { status: 400 });
    }
    patch.scheduled_date = d.toISOString();
  }
  if (body.quantity !== undefined && body.quantity !== null) {
    const q = Number(body.quantity);
    if (!Number.isFinite(q) || q <= 0 || q > 1_000_000_000) {
      return NextResponse.json({ error: "quantity must be a positive number." }, { status: 400 });
    }
    patch.quantity = q;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No updatable fields in body." }, { status: 400 });
  }

  // Verify post is in caller's tenant + caller is the owner.
  const sb = getSupabase();
  const { data: postRow, error: postErr } = await sb
    .from("marketplace_posts")
    .select("tenant_id, partner_id, post_type")
    .eq("id", id)
    .maybeSingle();
  if (postErr) {
    console.error("[marketplace.contract.delivery.put] post lookup failed:", postErr);
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
  if (post.partner_id !== access.partner_id) {
    return NextResponse.json({ error: "Only the post owner can update deliveries." }, { status: 403 });
  }

  // Find the contract for this post so we can pass its id to the store.
  const { data: contractRow } = await sb
    .from("marketplace_contracts")
    .select("id")
    .eq("post_id", id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const contract = contractRow as { id: string } | null;
  if (!contract) {
    return NextResponse.json({ error: "Contract not found." }, { status: 404 });
  }

  try {
    const updated = await updateContractDelivery(
      access.tenant_id,
      contract.id,
      deliveryId,
      patch,
    );
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.delivery_updated",
        "marketplace_contract_delivery",
        deliveryId,
        { post_id: id, contract_id: contract.id, patch },
      );
    } catch (e) {
      console.error("[marketplace.contract.delivery.put] audit failed:", e);
    }
    return NextResponse.json({ delivery: updated });
  } catch (e: any) {
    console.error("[marketplace.contract.delivery.put]", e);
    const msg = sanitizeError(e);
    const status = /not found/i.test(msg) ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const PUT = withApm(_put, "PUT /api/marketplace/[id]/contract/deliveries/[deliveryId]");
