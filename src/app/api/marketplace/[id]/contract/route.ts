import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { createContract, getContract } from "@/lib/data/marketplace-auction-store";
import { getSupabase } from "@/lib/supabase/client";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";
import { notifyContractCreated } from "@/lib/notif/helper";
import type { ContractFrequency, ContractPriceType } from "@/lib/supabase/marketplace-auction-types";

export const runtime = "nodejs";

// GET /api/marketplace/[id]/contract — fetch the (single) contract attached
// to a post. Only the post owner sees the full contract; responders get a
// public-friendly shape with delivered_quantity omitted (they see only the
// schedule status, not the totals).
async function _get(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;

  // Verify post exists + is in the caller's tenant + is a contract post.
  const sb = getSupabase();
  const { data: postRow, error: postErr } = await sb
    .from("marketplace_posts")
    .select("tenant_id, partner_id, post_type")
    .eq("id", id)
    .maybeSingle();
  if (postErr) {
    console.error("[marketplace.contract.get] post lookup failed:", postErr);
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

  try {
    const contract = await getContract(id, access.tenant_id);
    if (!contract) return NextResponse.json({ contract: null });
    const isOwner = post.partner_id === access.partner_id;
    if (!isOwner) {
      // Non-owner sees the schedule + status, but not the totals.
      const { delivered_quantity: _dq, ...rest } = contract;
      return NextResponse.json({ contract: rest });
    }
    return NextResponse.json({ contract });
  } catch (e: any) {
    console.error("[marketplace.contract.get]", e);
    return NextResponse.json({ error: "Failed to load contract." }, { status: 500 });
  }
}

// POST /api/marketplace/[id]/contract — create a long-term contract on a
// 'contract' post. Only the post owner can create the contract.
// Body: { total_quantity, frequency?, start_date, end_date, price_type?, auto_generate_schedule? }
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
  const total = Number(body?.total_quantity);
  if (!Number.isFinite(total) || total <= 0 || total > 1_000_000_000) {
    return NextResponse.json({ error: "total_quantity must be a positive number." }, { status: 400 });
  }
  if (!body?.start_date || !body?.end_date) {
    return NextResponse.json({ error: "start_date and end_date are required." }, { status: 400 });
  }
  const startDate = new Date(body.start_date);
  const endDate = new Date(body.end_date);
  if (!Number.isFinite(startDate.getTime())) {
    return NextResponse.json({ error: "Invalid start_date." }, { status: 400 });
  }
  if (!Number.isFinite(endDate.getTime())) {
    return NextResponse.json({ error: "Invalid end_date." }, { status: 400 });
  }
  if (endDate.getTime() <= startDate.getTime()) {
    return NextResponse.json({ error: "end_date must be after start_date." }, { status: 400 });
  }
  const allowedFreq: ContractFrequency[] = ["monthly", "quarterly", "weekly", "custom"];
  const frequency: ContractFrequency =
    body.frequency && allowedFreq.includes(body.frequency) ? body.frequency : "monthly";
  const allowedPrice: ContractPriceType[] = ["fixed", "floating", "indexed"];
  const price_type: ContractPriceType =
    body.price_type && allowedPrice.includes(body.price_type) ? body.price_type : "fixed";

  // Verify post exists + is in caller's tenant + caller is the owner.
  const sb = getSupabase();
  const { data: postRow, error: postErr } = await sb
    .from("marketplace_posts")
    .select("tenant_id, partner_id, post_type")
    .eq("id", id)
    .maybeSingle();
  if (postErr) {
    console.error("[marketplace.contract.post] post lookup failed:", postErr);
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
    return NextResponse.json({ error: "Only the post owner can create a contract." }, { status: 403 });
  }

  try {
    const contract = await createContract(access.tenant_id, {
      post_id: id,
      total_quantity: total,
      frequency,
      start_date: startDate.toISOString(),
      end_date: endDate.toISOString(),
      price_type,
      auto_generate_schedule: body.auto_generate_schedule !== false,
    });
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.contract_created",
        "marketplace_contract",
        contract.id,
        { post_id: id, total_quantity: total, frequency, price_type },
      );
    } catch (e) {
      console.error("[marketplace.contract.post] audit failed:", e);
    }

    // FIX-NOTIF-A11Y: notify the counterparty (the partner whose
    // response was accepted on this post) that the contract has been
    // created. The route already wrote the audit log; this is the
    // in-app signal to the counterparty. Best-effort — failures are
    // caught inside notifyContractCreated and never break the
    // response. We resolve the counterparty's partner_id by querying
    // marketplace_responses for an accepted response on this post.
    // When no accepted response exists yet (the owner is creating
    // the contract speculatively before any response is accepted),
    // there's no counterparty to notify — we skip silently.
    try {
      const sb2 = getSupabase();
      const { data: acceptedResp } = await sb2
        .from("marketplace_responses")
        .select("partner_id")
        .eq("post_id", id)
        .eq("tenant_id", access.tenant_id)
        .eq("status", "accepted")
        .limit(1)
        .maybeSingle();
      const counterpartyPartnerId = (acceptedResp as { partner_id: string } | null)?.partner_id;
      if (counterpartyPartnerId && counterpartyPartnerId !== access.partner_id) {
        // Fetch the post title for the notification body. The post is
        // already known to exist + be in the caller's tenant (verified
        // earlier in the handler), so we re-read just the product_name
        // for the message body.
        const { data: postTitleRow } = await sb2
          .from("marketplace_posts")
          .select("product_name")
          .eq("id", id)
          .maybeSingle();
        const postTitle = (postTitleRow as { product_name: string } | null)?.product_name || "your contract post";
        void notifyContractCreated(access.tenant_id, counterpartyPartnerId, contract.id, postTitle);
      }
    } catch (e) {
      console.error("[marketplace.contract.post] notify failed:", e);
    }
    return NextResponse.json({ contract });
  } catch (e: any) {
    console.error("[marketplace.contract.post]", e);
    const msg = e?.message || "Failed to create contract.";
    const status = /not found|not a contract/i.test(msg) ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/[id]/contract");
export const POST = withApm(_post, "POST /api/marketplace/[id]/contract");
