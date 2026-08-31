import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { requireGpsVerified } from "@/lib/portal/require-gps";
import { getStore } from "@/lib/data/store";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { notify } from "@/lib/notif/helper";
import { createCommissionOnOfferAccepted } from "@/lib/api/commission-cascade";
import { validateStatusTransition } from "@/lib/api/status-validator";

export const runtime = "nodejs";

/**
 * POST /api/portal/offers/[id]/respond
 *
 * Allows a portal client to accept, reject, or counter an offer that has
 * been sent to them. Validates that the offer belongs to the calling
 * portal access record and is in a state where a response is still
 * allowed ("sent", "viewed", or "countered" — countered is allowed
 * because the user may counter again or accept/reject after a counter).
 *
 * Body:
 *   { decision: "accept" | "reject" | "counter", note?: string,
 *     signature?: unknown,
 *     counter_amount?: number, counter_currency?: string, counter_message?: string }
 *
 * FIX-MARKET-UI / FIX 3 — added the "counter" decision. When decision is
 * "counter", the new offer status becomes "countered" and the counter
 * details (amount, currency, message) are appended to the offer's
 * `counter_offers` JSONB column, preserving the full counter history.
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
    if (!decision || !["accept", "reject", "counter"].includes(decision)) {
      return NextResponse.json({ error: "Decision must be 'accept', 'reject', or 'counter'." }, { status: 400 });
    }
    // 8b-6: cap `note` and `signature` length — without these, a portal
    // client could POST a 100MB string and fill the DB / break PDF render.
    // Mirror portal-rfqs' 5000-char cap (matches other portal note fields).
    if (note && typeof note === "string" && note.length > 5000) {
      return NextResponse.json({ error: "Note is too long (max 5000 chars)." }, { status: 400 });
    }
    if (signature && typeof signature === "string" && signature.length > 10_000) {
      return NextResponse.json({ error: "Signature is too long (max 10000 chars)." }, { status: 400 });
    }

    // Counter-specific validation — amount must be a positive number; the
    // currency must be a 3-letter ISO code; the message is optional but
    // capped at 10k chars (matches the message length cap on negotiation
    // messages so the field shapes line up if the seller converts the
    // counter into a negotiation room).
    let counterAmount: number | null = null;
    let counterCurrency: string | null = null;
    let counterMessage: string | null = null;
    if (decision === "counter") {
      const amt = Number(body.counter_amount);
      if (!Number.isFinite(amt) || amt <= 0) {
        return NextResponse.json({ error: "counter_amount must be a positive number." }, { status: 400 });
      }
      counterAmount = amt;
      const ccy = typeof body.counter_currency === "string" ? body.counter_currency.trim().toUpperCase() : "";
      if (!/^[A-Z]{3}$/.test(ccy)) {
        return NextResponse.json({ error: "counter_currency must be a 3-letter ISO code." }, { status: 400 });
      }
      counterCurrency = ccy;
      if (body.counter_message !== undefined && body.counter_message !== null) {
        if (typeof body.counter_message !== "string" || body.counter_message.length > 10_000) {
          return NextResponse.json({ error: "counter_message must be ≤ 10000 chars." }, { status: 400 });
        }
        counterMessage = body.counter_message;
      }
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

    // Only allow responses on offers that are currently "sent", "viewed",
    // or "countered" (the latter so a client can respond to their own
    // previous counter — e.g. accept the seller's amended counter).
    const currentStatus = String(offer.status || "").toLowerCase();
    if (currentStatus !== "sent" && currentStatus !== "viewed" && currentStatus !== "countered") {
      return NextResponse.json(
        { error: `Offer cannot be responded to in its current status (${offer.status}).` },
        { status: 409 }
      );
    }

    const newStatus = decision === "accept" ? "accepted"
      : decision === "reject" ? "rejected"
      : "countered";
    const nowIso = new Date().toISOString();

    // Validate the status transition (Re-Audit-2 N4) — portal clients can
    // only respond to offers in "sent" / "viewed" / "countered" status.
    // The validator confirms sent→accepted / sent→rejected / sent→countered
    // are allowed by the state machine. Portal clients cannot bypass
    // (no super-admin in the portal context).
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

    // FIX-MARKET-UI / FIX 3 — append the counter to the JSONB history
    // column before the upsert. We read the existing array (default to
    // [] when null/missing), prepend the new entry (newest first), and
    // pass the merged array to upsertOffer.
    let mergedCounters: Array<{ amount: number; currency: string; message: string | null; partner_id: string | null; created_at: string }> = [];
    if (decision === "counter") {
      const existing = Array.isArray((offer as any).counter_offers) ? (offer as any).counter_offers : [];
      mergedCounters = [
        {
          amount: counterAmount!,
          currency: counterCurrency!,
          message: counterMessage,
          partner_id: access.partner_id,
          created_at: nowIso,
        },
        ...existing,
      ];
    }

    const upsertPayload: Record<string, unknown> = {
      id,
      status: newStatus,
      responded_at: nowIso,
      admin_reviewed_by_client: true,
      client_note: note || null,
      client_signature: signature ?? null,
    };
    if (decision === "accept") {
      upsertPayload.client_accepted_at = nowIso;
    }
    if (decision === "counter") {
      upsertPayload.counter_offers = mergedCounters;
      // Keep client_accepted_at null while a counter is open.
      upsertPayload.client_accepted_at = null;
    }

    await store.upsertOffer({
      ...upsertPayload,
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
      const notifType =
        decision === "accept" ? "offer_accepted"
        : decision === "reject" ? "offer_rejected"
        : "offer_countered";
      const notifTitle =
        decision === "accept" ? "Offer Accepted"
        : decision === "reject" ? "Offer Rejected"
        : "Offer Countered";
      const notifMessage =
        decision === "accept"
          ? `${partnerName} accepted offer ${offer.number}.${note ? " Note: " + note : ""}`
          : decision === "reject"
            ? `${partnerName} rejected offer ${offer.number}.${note ? " Reason: " + note : ""}`
            : `${partnerName} countered offer ${offer.number} with ${counterAmount} ${counterCurrency}.${counterMessage ? " Message: " + counterMessage : ""}`;
      await notify({
        tenantId: access.tenant_id,
        userId: null,
        type: notifType,
        title: notifTitle,
        message: notifMessage,
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
        {
          decision,
          note: note || null,
          counter_amount: counterAmount,
          counter_currency: counterCurrency,
          counter_message: counterMessage,
        }
      );
    } catch (e) {
      console.error("[audit]", e);
    }

    return NextResponse.json({ ok: true, status: newStatus, counter_offers: mergedCounters });
  } catch (e: any) {
    console.error("[portal.offer.respond]", e);
    return NextResponse.json({ error: sanitizeError(e)}, { status: 500 });
  }
}
