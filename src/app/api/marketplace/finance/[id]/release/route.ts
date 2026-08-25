import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { releaseEscrow } from "@/lib/data/marketplace-finance-store";
import { audit } from "@/lib/api/helpers";
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
async function _post(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;

  try {
    const released = await releaseEscrow(id, access.tenant_id, access.partner_id);
    if (!released) {
      return NextResponse.json({ error: "Not found or not authorised." }, { status: 404 });
    }
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.escrow_released",
        "marketplace_financial_instruments",
        released.id,
        { amount: released.amount, currency: released.currency, escrow_release_condition: released.escrow_release_condition },
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
      const counterpartyPartnerId = released.counterparty_partner_id;
      if (counterpartyPartnerId && counterpartyPartnerId !== access.partner_id) {
        void notifyEscrowReleased(
          access.tenant_id,
          counterpartyPartnerId,
          released.id,
          released.amount,
          released.currency,
        );
      }
    } catch (e) {
      console.error("[marketplace.finance.release] notify failed:", e);
    }
    return NextResponse.json(released);
  } catch (e: any) {
    console.error("[marketplace.finance.release]", e);
    const msg = e?.message || "Failed to release escrow.";
    const status = /cannot release|not an escrow/i.test(msg) ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const POST = withApm(_post, "POST /api/marketplace/finance/[id]/release");
