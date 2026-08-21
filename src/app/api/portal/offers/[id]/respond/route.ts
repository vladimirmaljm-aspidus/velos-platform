import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { requireGpsVerified } from "@/lib/portal/require-gps";
import { getStore } from "@/lib/data/store";
import { audit } from "@/lib/api/helpers";
import { notify } from "@/lib/notif/helper";
import { createCommissionOnOfferAccepted } from "@/lib/api/commission-cascade";
import { validateStatusTransition } from "@/lib/api/status-validator";

export const runtime = "nodejs";

/**
 * POST /api/portal/offers/[id]/respond
 *
 * Allows a portal client to accept or reject an offer that has been sent to
 * them. Validates that the offer belongs to the calling portal access record
 * and is in a state where a response is still allowed ("sent" or "viewed").
 *
 * Body: { decision: "accept" | "reject", note?: string, signature?: unknown }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await getPortalSessionAccess();
    if (!access) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    if (!access.can_view_offers) {
      return NextResponse.json({ error: "Not permitted." }, { status: 403 });
    }
    const _kycBlock = await requireKycApproved(access);
    if (_kycBlock) return _kycBlock;
    // F-FINAL / P1: GPS gate — parity with /api/portal/proformas/[id]/respond
    // which already calls requireGpsVerified. Without this, a portal client
    // could accept/reject an offer via direct API call without ever sharing
    // their GPS location (the client-side portal-shell gate is bypassable
    // by hitting the API directly with a valid session cookie).
    const _gpsBlock = await requireGpsVerified(access);
    if (_gpsBlock) return _gpsBlock;

    const { id } = await params;

    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const { decision, note, signature } = body;
    if (!decision || !["accept", "reject"].includes(decision)) {
      return NextResponse.json({ error: "Decision must be 'accept' or 'reject'." }, { status: 400 });
    }

    const store = await getStore();

    // Fetch the offer (global lookup, then verify ownership).
    const offer = await store.getOffer(id);
    if (!offer) {
      return NextResponse.json({ error: "Offer not found." }, { status: 404 });
    }
    if (offer.tenant_id !== access.tenant_id) {
      return NextResponse.json({ error: "Offer not found." }, { status: 404 });
    }
    if (offer.partner_id !== access.partner_id) {
      return NextResponse.json({ error: "Access denied." }, { status: 403 });
    }

    // Only allow responses on offers that are currently "sent" or "viewed".
    const currentStatus = String(offer.status || "").toLowerCase();
    if (currentStatus !== "sent" && currentStatus !== "viewed") {
      return NextResponse.json(
        { error: `Offer cannot be responded to in its current status (${offer.status}).` },
        { status: 409 }
      );
    }

    const newStatus = decision === "accept" ? "accepted" : "rejected";
    const nowIso = new Date().toISOString();

    // Validate the status transition (Re-Audit-2 N4) — portal clients can
    // only respond to offers in "sent" (or "viewed") status. The validator
    // confirms sent→accepted / sent→rejected are allowed by the state machine.
    // Portal clients cannot bypass (no super-admin in the portal context).
    {
      const t = validateStatusTransition(
        "offer",
        currentStatus,
        newStatus,
      );
      if (!t.valid) {
        return NextResponse.json(
          { error: t.error || `Cannot transition offer from ${currentStatus} to ${newStatus}.` },
          { status: 400 },
        );
      }
    }

    await store.upsertOffer({
      id,
      status: newStatus as any,
      responded_at: nowIso,
      client_accepted_at: decision === "accept" ? nowIso : null,
      client_note: note || null,
      client_signature: signature ?? null,
      admin_reviewed_by_client: true,
    } as any);

    // ── Cascade: when the portal client ACCEPTS an offer, auto-create the
    //    pending DealCommission row if the offer's linked deal has a
    //    commission_agent_id. This matches the behaviour of the admin-side
    //    PUT /api/offers/[id] path (route.ts:84-92). Without this branch, an
    //    offer accepted via the portal would silently skip the commission
    //    obligation (DEEP-AUDIT-LOGIC §3.1 / §5.1). Fire-and-forget — failures
    //    are logged but do not block the response.
    if (decision === "accept") {
      try {
        const dealId = (offer as any)?.deal_id || null;
        if (dealId) {
          await createCommissionOnOfferAccepted(
            store,
            dealId,
            access.tenant_id,
          );
        }
      } catch (e) {
        console.error("[portal.respond] commission cascade failed:", e);
      }
    }

    // ── Inventory movement on portal accept (Re-Audit-2 N6) ─────────────
    // Previously only the admin PUT /api/offers/[id] path decremented stock —
    // portal-accepted offers skipped the cascade entirely. Inconsistent state.
    // Now we call the same shared helper the admin path uses
    // (`deductStockForOffer` in `lib/api/inventory-cascade.ts`) so both paths
    // produce identical side effects. The helper is idempotent (skips if a
    // movement already exists for the offer id) so concurrent admin + portal
    // calls cannot double-deduct.
    if (decision === "accept") {
      try {
        const { deductStockForOffer } = await import("@/lib/api/inventory-cascade");
        const items = Array.isArray((offer as any).items) ? (offer as any).items : [];
        if (items.length > 0) {
          await deductStockForOffer({
            tenantId: access.tenant_id,
            offerId: String(id),
            offerNumber: offer.number || null,
            partnerId: offer.partner_id || null,
            items,
            source: "portal",
          });
        }
      } catch (e) {
        console.error("[portal.respond] inventory movement failed:", e);
      }
    }

    // Notify tenant admins (broadcast = user_id null).
    try {
      const partner = offer.partner_id ? await store.getPartner(offer.partner_id) : null;
      const partnerName = partner?.name || "Portal client";
      await notify({
        tenantId: access.tenant_id,
        userId: null,
        type: decision === "accept" ? "offer_accepted" : "offer_rejected",
        title: decision === "accept" ? "Offer Accepted" : "Offer Rejected",
        message:
          decision === "accept"
            ? `${partnerName} accepted offer ${offer.number}.${note ? " Note: " + note : ""}`
            : `${partnerName} rejected offer ${offer.number}.${note ? " Reason: " + note : ""}`,
        entityType: "offer",
        entityId: id,
        actionUrl: `/offers?id=${id}`,
        actionLabel: "View Offer",
      });
    } catch (e) {
      console.error("[portal.respond] notification failed:", e);
    }

    // Audit log — portal client acts as the "user".
    try {
      await audit(
        store,
        {
          id: undefined,
          username: access.portal_email || `portal:${access.id}`,
          tenant_id: access.tenant_id,
        },
        req,
        "portal.offer_responded",
        "offer",
        id,
        { decision, note: note || null }
      );
    } catch (e) {
      console.error("[audit]", e);
    }

    return NextResponse.json({ ok: true, status: newStatus });
  } catch (e: any) {
    console.error("[portal.offer.respond]", e);
    return NextResponse.json({ error: e.message || "Internal server error" }, { status: 500 });
  }
}
