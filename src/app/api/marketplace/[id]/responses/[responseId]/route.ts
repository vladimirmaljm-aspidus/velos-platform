import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { updateMarketplaceResponseStatus } from "@/lib/data/marketplace-store";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { notify } from "@/lib/notif/helper";
import { triggerWebhooks } from "@/lib/webhooks/deliver";
import { withApm } from "@/lib/monitoring/apm";
import type { MarketplaceResponseStatus } from "@/lib/supabase/marketplace-types";

export const runtime = "nodejs";

// PUT /api/marketplace/[id]/responses/[responseId] — accept / reject /
// counter a response. Only the POST OWNER can do this (the store verifies
// via the inner join responses → posts).
async function _put(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; responseId: string }> },
) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id, responseId } = await ctx.params;

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const status = String(body.status || "").toLowerCase() as MarketplaceResponseStatus;
  const allowed: MarketplaceResponseStatus[] = [
    "sent", "viewed", "accepted", "rejected", "expired", "countered",
  ];
  if (!allowed.includes(status)) {
    return NextResponse.json({ error: "Invalid status." }, { status: 400 });
  }

  try {
    const updated = await updateMarketplaceResponseStatus(
      responseId,
      access.tenant_id,
      access.partner_id,
      status,
    );
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.response_status_changed",
        "marketplace_response",
        responseId,
        { post_id: id, new_status: status },
      );
      // Phase 12 — fire marketplace.response_accepted / rejected webhooks
      // when the owner accepts / rejects a response. The two are the
      // downstream-flow triggers the spec calls out (accept → contract
      // creation, shipment booking, L/C initiation; reject → re-list the
      // post in the browse feed, decrement the open-response counter).
      // Countered / viewed / sent / expired statuses don't fire a webhook
      // — those are intermediate negotiation states with no downstream
      // automation.
      if (status === "accepted") {
        void triggerWebhooks(store, access.tenant_id, "marketplace.response_accepted", "marketplace_response", responseId, {
          id: responseId,
          post_id: id,
          new_status: status,
          responder_partner_id: updated?.partner_id,
        }).catch(() => {});
      } else if (status === "rejected") {
        void triggerWebhooks(store, access.tenant_id, "marketplace.response_rejected", "marketplace_response", responseId, {
          id: responseId,
          post_id: id,
          new_status: status,
          responder_partner_id: updated?.partner_id,
        }).catch(() => {});
      }
    } catch (e) {
      console.error("[marketplace.response.put] audit failed:", e);
    }

    // Notify the responder that their offer was accepted / rejected
    // (Phase 2). The caller is the post owner; `updated.partner_id` is
    // the responder (the original response author). Fire-and-forget.
    try {
      const responderPartnerId = updated?.partner_id;
      if (responderPartnerId && responderPartnerId !== access.partner_id) {
        const isAccept = status === "accepted";
        const isReject = status === "rejected";
        if (isAccept || isReject) {
          await notify({
            tenantId: access.tenant_id,
            partnerId: responderPartnerId,
            type: isAccept
              ? "marketplace_response_accepted"
              : "marketplace_response_rejected",
            title: isAccept
              ? "Your offer was accepted"
              : "Your offer was rejected",
            message: isAccept
              ? "The post owner accepted your marketplace offer."
              : "The post owner rejected your marketplace offer.",
            entityType: "marketplace_post",
            entityId: id,
            actionUrl: `/portal/marketplace/${id}`,
            actionLabel: "View post",
          });
        }
      }
    } catch (e) {
      console.error("[marketplace.response.put] notify failed:", e);
    }

    return NextResponse.json(updated);
  } catch (e: any) {
    console.error("[marketplace.response.put]", e);
    const msg = e?.message || "Failed to update response.";
    // Surface ownership errors as 403, not-found as 404, invalid
    // status-transition errors as 409 (AUDIT4-PATHS / Fix 4 — the store
    // throws an error whose message starts with "Cannot change
    // marketplace_response status from ... Allowed transitions: ...").
    // The transition error is the only one that mentions "Allowed
    // transitions", so that's the discriminator.
    //
    // 8c-7: the TOCTOU CAS guard now also throws
    // "Response status changed; please reload and retry." when 0 rows
    // were affected by the guarded UPDATE — also a 409 (concurrent
    // modification; client should reload and retry).
    const status = /not found/i.test(msg) ? 404 :
      /only the post owner/i.test(msg) ? 403 :
      /Allowed transitions|status changed/i.test(msg) ? 409 :
      500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const PUT = withApm(_put, "PUT /api/marketplace/[id]/responses/[responseId]");
