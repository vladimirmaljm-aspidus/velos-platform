import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getNegotiation } from "@/lib/data/marketplace-store";
import { getSupabase } from "@/lib/supabase/client";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/marketplace/negotiations/[id]/cancel
//
// Allows one of the two parties in a negotiation to proactively close it.
// Before this route existed, neither party could end a negotiation that had
// gone stale (only the 48h auto-expiry clock closed it). Partners asked for a
// way to bail out of a negotiation they no longer wanted to pursue (e.g. the
// counterparty went dark, the terms drifted, the deal is dead) without
// waiting up to 48h for the auto-expiry to fire.
//
// Auth: portal session. The caller must be one of the two parties —
// `getNegotiation()` enforces this (returns null when the caller is not a
// party). The cancel action is unilateral — either A or B can cancel.
//
// Body: none. (The route reads nothing from the body.)
//
// Behaviour:
//   1. Verify the negotiation exists AND the caller is a party.
//   2. Gate: if the negotiation already has an accepted offer (status ===
//      "accepted" OR contact_revealed === true OR either side has already
//      sent an `accept` message — partner_a_accepted / partner_b_accepted),
//      REFUSE the cancel. The spec is explicit: an accepted offer must be
//      rejected (so the counterparty sees the rejection in the thread and
//      knows the deal fell through), not silently cancelled.
//   3. Gate: if the negotiation is already in a terminal state (rejected /
//      cancelled / expired), REFUSE — there's nothing to cancel.
//   4. Flip `status` to "cancelled" on the negotiation row.
//   5. Insert a `system` marketplace_message into the thread so the room
//      surfaces the state change in-line (the same pattern the
//      contact-reveal handshake uses). The message text is
//      "Negotiation cancelled by {partner_name}" — we look up the caller's
//      Partner row to get their company name.
//   6. Audit-log the cancellation (action: marketplace.negotiation_cancelled)
//      so admins + the audit trail can see who closed which negotiation.
//   7. Bump `last_message_at` so the negotiation list re-sorts correctly
//      (the cancelled negotiation should float to the top of the recent
//      activity list).
//
// The route returns { ok: true, negotiation: <updated row> } on success.
// ─────────────────────────────────────────────────────────────────────────────
async function _post(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;

  try {
    // Step 1 — verify the negotiation exists + the caller is a party.
    // `getNegotiation()` returns null when either check fails; we surface
    // a 404 (not 403) so the caller cannot tell the difference between
    // "negotiation doesn't exist" and "you're not a party to it" (the
    // standard RLS-style fail-closed response).
    const n = await getNegotiation(id, access.tenant_id, access.partner_id);
    if (!n) {
      return NextResponse.json({ error: "Negotiation not found." }, { status: 404 });
    }

    // Step 2 — accepted-offer gate. The spec says: "if there's an accepted
    // offer in the negotiation, don't allow cancel (must reject the offer
    // instead)". We treat the following as "accepted offer" signals:
    //   • `status === "accepted"` — the DB's authoritative terminal state.
    //   • `contact_revealed === true` — the contact-reveal handshake has
    //     fired, which only happens when BOTH parties sent `accept`.
    //   • `partner_a_accepted || partner_b_accepted` — Phase 2 per-party
    //     accept flags. Either of these being true means at least one
    //     side has accepted; cancelling at this point would silently
    //     retract an accepted offer without the reject-message trail the
    //     counterparty needs to see. The spec explicitly says "must reject
    //     the offer instead" — so we 409 here and tell the caller.
    const status = n.status;
    const contactRevealed = Boolean((n as { contact_revealed?: boolean }).contact_revealed);
    const partnerAAccepted = Boolean(
      (n as { partner_a_accepted?: boolean }).partner_a_accepted,
    );
    const partnerBAccepted = Boolean(
      (n as { partner_b_accepted?: boolean }).partner_b_accepted,
    );
    if (status === "accepted" || contactRevealed || partnerAAccepted || partnerBAccepted) {
      return NextResponse.json(
        {
          error:
            "Cannot cancel a negotiation with an accepted offer — reject the offer instead.",
        },
        { status: 409 },
      );
    }

    // Step 3 — terminal-state gate. A negotiation that is already
    // rejected / cancelled / expired has nothing to cancel. Return 409
    // with a clear message; the UI should not even show the cancel
    // button for these states (the room's `inputDisabled` flag already
    // hides the action row), but the route defends against a stale UI
    // sending the POST anyway.
    if (status === "rejected" || status === "cancelled" || status === "expired") {
      return NextResponse.json(
        { error: `Negotiation is already ${status}.` },
        { status: 409 },
      );
    }

    // Step 4 — look up the caller's Partner row to get their company name
    // for the system message ("Negotiation cancelled by {partner_name}").
    // Fall back to a generic label when the partner row is missing (e.g.
    // hard-deleted) so the system message still inserts.
    const sb = getSupabase();
    let partnerName: string | null = null;
    const { data: partnerRow, error: partnerErr } = await sb
      .from("partners")
      .select("id, name")
      .eq("id", access.partner_id)
      .maybeSingle();
    if (partnerErr) {
      console.error(
        "[marketplace.negotiations.cancel] partner lookup failed:",
        partnerErr,
      );
    }
    if (partnerRow) {
      partnerName = (partnerRow as { name?: string | null }).name ?? null;
    }
    const systemMessageText = `Negotiation cancelled by ${
      partnerName ?? "a party"
    }`;

    // Step 5 — flip the status to "cancelled". The UPDATE is scoped by
    // `id` only (the negotiation's existence + caller-membership were
    // already verified by `getNegotiation()` above). The `last_message_at`
    // bump floats the cancelled negotiation to the top of the
    // recent-activity list (matches the bump the messages route does on
    // every new message).
    const cancelledAt = new Date().toISOString();
    const { data: updated, error: updErr } = await sb
      .from("marketplace_negotiations")
      .update({
        status: "cancelled",
        last_message_at: cancelledAt,
      })
      .eq("id", id)
      .select()
      .maybeSingle();
    if (updErr) {
      console.error(
        "[marketplace.negotiations.cancel] status update failed:",
        updErr,
      );
      return NextResponse.json(
        { error: "Failed to cancel negotiation." },
        { status: 500 },
      );
    }

    // Step 6 — insert the system message announcing the cancellation. The
    // room's MessageBubble renderer treats `message_type === "system"`
    // specially (centered, muted, italic) so the cancellation surfaces
    // in-line at the bottom of the thread. Wrapped in its own try/catch
    // because a failure here must NOT roll back the status update — the
    // negotiation is already cancelled; the system message is a
    // best-effort UX nicety.
    try {
      await sb.from("marketplace_messages").insert({
        negotiation_id: id,
        sender_partner_id: access.partner_id,
        message: systemMessageText,
        message_type: "system",
        offer_data: null,
        attachment_url: null,
      });
    } catch (sysErr) {
      console.error(
        "[marketplace.negotiations.cancel] system-insert failed:",
        sysErr,
      );
    }

    // Step 7 — audit-log the cancellation. The audit row carries the
    // negotiation id, the post id (so admins can pivot from the post to
    // its cancelled negotiation), the previous status, and the partner
    // name used in the system message — so an admin reviewing the audit
    // trail later can reconstruct exactly what the counterparty saw.
    try {
      const store = await getStore();
      await audit(
        store,
        {
          id: undefined,
          username: access.portal_email || `portal:${access.id}`,
          tenant_id: access.tenant_id,
        },
        req,
        "marketplace.negotiation_cancelled",
        "marketplace_negotiation",
        id,
        {
          negotiation_id: id,
          post_id: n.post_id,
          previous_status: status,
          cancelled_by_partner_id: access.partner_id,
          cancelled_by_partner_name: partnerName,
          system_message: systemMessageText,
        },
      );
    } catch (auditErr) {
      console.error(
        "[marketplace.negotiations.cancel] audit failed:",
        auditErr,
      );
    }

    return NextResponse.json({
      ok: true,
      negotiation: updated,
    });
  } catch (e: any) {
    console.error("[marketplace.negotiations.cancel]", e);
    return NextResponse.json(
      { error: "Failed to cancel negotiation." },
      { status: 500 },
    );
  }
}

export const POST = withApm(
  _post,
  "POST /api/marketplace/negotiations/[id]/cancel",
);
