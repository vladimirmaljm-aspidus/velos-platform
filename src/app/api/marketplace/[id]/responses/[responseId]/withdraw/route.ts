import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireMarketplaceCommunicator } from "@/lib/portal/marketplace-gate";
import { withdrawMarketplaceResponse } from "@/lib/data/marketplace-store";
import { getSupabase } from "@/lib/supabase/client";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { notify } from "@/lib/notif/helper";
import { triggerWebhooks } from "@/lib/webhooks/deliver";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// POST /api/marketplace/[id]/responses/[responseId]/withdraw — the
// RESPONDER pulls their own offer before the post owner decides.
//
// 102 (workflow-audit GAP 6): previously a sent offer was immutable from
// the responder's side — a typo'd price or a capacity change left a wrong
// offer sitting in the owner's queue with no remedy except sending
// correction offers (capped at 5/day) that left the stale rows confusing
// the owner. Now the responder can withdraw cleanly:
//
//   • ownership: the caller must be the response AUTHOR (store verifies —
//     the post owner CANNOT withdraw someone's offer; rejecting is the
//     owner's prerogative)
//   • transitions: sent / viewed / countered → withdrawn; terminal states
//     (accepted / rejected / expired / withdrawn) 409 with the validator's
//     message — after the owner decided, the offer can't be pulled
//   • CAS guard: racing owner accept vs. responder withdraw can't both win
//   • side effects: responses_count decremented, audit row, webhook
//     marketplace.response_withdrawn, notification to the POST OWNER (they
//     were mid-review and need to know the offer is off the table)
//
// Body: none.
async function _post(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; responseId: string }> },
) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  // Marketplace communication policy — Standard tier + approved KYC.
  const _commBlock = await requireMarketplaceCommunicator(access);
  if (_commBlock) return _commBlock;
  const { id, responseId } = await ctx.params;

  try {
    const updated = await withdrawMarketplaceResponse(
      responseId,
      access.tenant_id,
      access.partner_id,
    );

    // Audit + webhook (fire-and-forget wrapper — must not block the 200).
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.response_withdrawn",
        "marketplace_response",
        responseId,
        { post_id: id },
      );
      void triggerWebhooks(
        store,
        access.tenant_id,
        "marketplace.response_withdrawn",
        "marketplace_response",
        responseId,
        { id: responseId, post_id: id, withdrawn_by: access.partner_id },
      ).catch(() => {});
    } catch (e) {
      console.error("[marketplace.response.withdraw] audit failed:", e);
    }

    // Notify the POST OWNER that the offer was pulled — they may be
    // mid-review and the row just left their actionable queue.
    // Fire-and-forget. The owner's partner_id + product name are looked
    // up fresh from the post row (the response row carries no post join).
    try {
      const sb = getSupabase();
      const { data: postRow } = await sb
        .from("marketplace_posts")
        .select("partner_id, product_name")
        .eq("id", id)
        .maybeSingle();
      const ownerPartnerId = (postRow as { partner_id?: string } | null)?.partner_id;
      const productName =
        (postRow as { product_name?: string } | null)?.product_name ?? "your post";
      if (ownerPartnerId && ownerPartnerId !== access.partner_id) {
        await notify({
          tenantId: access.tenant_id,
          partnerId: ownerPartnerId,
          type: "marketplace_response_withdrawn",
          title: "Offer withdrawn",
          message: `A partner withdrew their offer on "${productName}". It is no longer actionable.`,
          entityType: "marketplace_post",
          entityId: id,
          actionUrl: `/portal/marketplace/${id}`,
          actionLabel: "View post",
        });
      }
    } catch (e) {
      console.error("[marketplace.response.withdraw] notify failed:", e);
    }

    return NextResponse.json(updated);
  } catch (e: any) {
    // Business-rule rejections (not-author, terminal-state transition,
    // CAS race) are user-facing outcomes — map to their statuses without
    // console.error (keeps the error audit clean of expected outcomes).
    if (e && e.name === "MarketplaceRuleError") {
      return NextResponse.json({ error: e.message }, { status: e.status ?? 409 });
    }
    console.error("[marketplace.response.withdraw]", e);
    const msg = sanitizeError(e);
    const status = /not found/i.test(msg) ? 404 :
      /Allowed transitions|status changed/i.test(msg) ? 409 :
      500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const POST = withApm(
  _post,
  "POST /api/marketplace/[id]/responses/[responseId]/withdraw",
);
