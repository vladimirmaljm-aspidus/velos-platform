import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, audit, sanitizeError } from "@/lib/api/helpers";
import { notify } from "@/lib/notif/helper";

export const runtime = "nodejs";

/**
 * POST /api/referral-commissions/[id]/mark-paid — records the payout
 * (terminal state). Guards:
 *   • only from status "approved" (the confirm → approve money gates ran);
 *   • paid amount must be a positive number;
 *   • payout reference is strongly recommended (required unless the admin
 *     explicitly passes allow_empty_reference=true).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    {
      const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "commissions.update");
      if (_d) return _d;
    }
    const tenantId = resolveTenantId(auth, req);
    const { id } = await ctx.params;

    let body: { paid_amount?: unknown; payout_reference?: unknown; allow_empty_reference?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const entry = await auth.store.getReferralCommission(id);
    if (!entry) return NextResponse.json({ error: "Referral commission not found." }, { status: 404 });
    if (!auth.isSuperAdmin && entry.tenant_id !== tenantId) {
      return NextResponse.json({ error: "Referral commission not found." }, { status: 404 });
    }
    if (entry.status === "paid") {
      return NextResponse.json({ error: "This commission is already marked as paid." }, { status: 409 });
    }
    if (entry.status !== "approved") {
      return NextResponse.json({ error: `Cannot pay from status "${entry.status}" — approve the commission first.` }, { status: 409 });
    }

    const paidAmount = body.paid_amount === undefined || body.paid_amount === null
      ? Number(entry.commission_amount)
      : Number(body.paid_amount);
    if (!Number.isFinite(paidAmount) || paidAmount <= 0 || paidAmount > 1_000_000_000_000) {
      return NextResponse.json({ error: "Invalid paid amount (must be a positive number)." }, { status: 400 });
    }

    const reference = typeof body.payout_reference === "string" ? body.payout_reference.trim().slice(0, 200) : "";
    if (!reference && body.allow_empty_reference !== true) {
      return NextResponse.json({ error: "A payout reference (bank transfer reference / receipt number) is required." }, { status: 400 });
    }

    const updated = await auth.store.markReferralCommissionPaid(id, {
      payout_reference: reference || undefined,
      paid_amount: paidAmount,
    });

    await audit(auth.store, auth.user, req, "referral_commission.paid", "referral_commission", id, {
      partner_id: entry.partner_id,
      paid_amount: paidAmount,
      currency: updated.currency,
      payout_reference: reference || null,
    });

    await notify({
      tenantId: entry.tenant_id,
      partnerId: entry.partner_id,
      type: "referral_commission_paid",
      title: "Commission paid",
      message: `Your commission of ${paidAmount.toLocaleString()} ${updated.currency} (${entry.referral_company}) was paid${reference ? ` — reference ${reference}` : ""}.`,
      entityType: "referral_commission",
      entityId: id,
      actionUrl: "/portal/referrals",
      actionLabel: "View",
    }).catch(() => {});

    return NextResponse.json(updated);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
