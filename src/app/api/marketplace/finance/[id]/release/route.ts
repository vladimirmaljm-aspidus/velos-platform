import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { releaseEscrow } from "@/lib/data/marketplace-finance-store";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";
import { notifyEscrowReleased } from "@/lib/notif/helper";

export const runtime = "nodejs";

// POST /api/marketplace/finance/[id]/release — release the funds held in an
// escrow instrument. Auth: the owning partner OR the counterparty (when the
// release condition is `both_parties_confirm`). The store validates the
// instrument is an escrow + is in `active` status + the transition to
// `released` is permitted.
//
// No body required — the instrument id is in the URL. The endpoint is
// idempotent in the sense that a second call returns 409 (the instrument is
// already released; the store's status-transition guard rejects
// released → released as a no-op that isn't in the transition map — but
// `from === to` returns true so the store actually allows it; the second
// call is a no-op that re-stamps `released`).
//
// FIX-AUDIT2-CRIT / C4 — when `escrow_release_condition` is
// `both_parties_confirm`, the store now implements a real 2-phase commit:
// the first party's call records the confirmation but does NOT release;
// it returns the instrument with `needs_counterparty_confirm: true` so the
// caller surfaces the "waiting on counterparty" UX. The release only fires
// when the second party confirms. The "released" audit log entry + the
// counterparty notification are deferred to the actual release call, so
// this route branches on `result.needs_counterparty_confirm`.
async function _post(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;

  try {
    const result = await releaseEscrow(id, access.tenant_id, access.partner_id);
    if (!result) {
      return NextResponse.json({ error: "Not found or not authorised." }, { status: 404 });
    }
    const { instrument, needs_counterparty_confirm, confirmed_partner_ids } = result;

    if (needs_counterparty_confirm) {
      // 2-phase commit pending — the store has already added a
      // `marketplace.escrow_release_confirmed` audit log entry. The
      // "released" audit log entry + counterparty notification are
      // deferred until the second party confirms and the store actually
      // flips the status. Return the instrument with the pending flag so
      // the frontend can surface the "waiting on counterparty" UX.
      return NextResponse.json({
        ...instrument,
        needs_counterparty_confirm: true,
        confirmed_partner_ids,
      });
    }

    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.escrow_released",
        "marketplace_financial_instruments",
        instrument.id,
        { amount: instrument.amount, currency: instrument.currency, escrow_release_condition: instrument.escrow_release_condition },
      );
    } catch (e) {
      console.error("[marketplace.finance.release] audit failed:", e);
    }

    // FIX-NOTIF-A11Y: notify the counterparty that the escrow funds
    // have been released. The audit log entry above is the system
    // record; this is the in-app signal to the partner on the other
    // side of the escrow (typically the seller, when the buyer
    // authorises release). When the instrument has no
    // counterparty_partner_id recorded (a standalone escrow), or the
    // counterparty is the caller themselves (release by both-parties
    // confirm where the counterparty initiated), skip silently.
    // Best-effort — failures are caught inside notifyEscrowReleased.
    try {
      const counterpartyPartnerId = instrument.counterparty_partner_id;
      if (counterpartyPartnerId && counterpartyPartnerId !== access.partner_id) {
        void notifyEscrowReleased(
          access.tenant_id,
          counterpartyPartnerId,
          instrument.id,
          instrument.amount,
          instrument.currency,
        );
      }
    } catch (e) {
      console.error("[marketplace.finance.release] notify failed:", e);
    }
    return NextResponse.json(instrument);
  } catch (e: any) {
    console.error("[marketplace.finance.release]", e);
    const msg = sanitizeError(e);
    const status = /cannot release|not an escrow/i.test(msg) ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const POST = withApm(_post, "POST /api/marketplace/finance/[id]/release");
