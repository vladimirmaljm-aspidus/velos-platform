import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, audit, sanitizeError } from "@/lib/api/helpers";
import { notify } from "@/lib/notif/helper";

export const runtime = "nodejs";

/**
 * POST /api/referral-commissions/[id]/transition — admin drives the
 * lifecycle state machine:
 *   • confirm           pending|confirmed → confirmed   (deal done)
 *   • approve           confirmed        → approved     (requires: agreement
 *                       signed + documents_complete — the money gates)
 *   • cancel            any non-paid      → cancelled
 *   • reopen_documents  any non-paid      → checklist reset
 */
const ALLOWED = ["confirm", "approve", "cancel", "reopen_documents"] as const;
type Action = (typeof ALLOWED)[number];

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

    let body: { action?: unknown; admin_notes?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const action = body.action as Action;
    if (!ALLOWED.includes(action)) {
      return NextResponse.json({ error: "Invalid action. Use confirm | approve | cancel | reopen_documents." }, { status: 400 });
    }

    const entry = await auth.store.getReferralCommission(id);
    if (!entry) return NextResponse.json({ error: "Referral commission not found." }, { status: 404 });
    if (!auth.isSuperAdmin && entry.tenant_id !== tenantId) {
      return NextResponse.json({ error: "Referral commission not found." }, { status: 404 });
    }

    // ── State-machine guards ──────────────────────────────────────────────
    if (action === "confirm" && !["pending", "confirmed"].includes(entry.status)) {
      return NextResponse.json({ error: `Cannot confirm from status "${entry.status}".` }, { status: 409 });
    }
    if (action === "approve") {
      if (entry.status !== "confirmed") {
        return NextResponse.json({ error: "Confirm the referred business before approving the commission." }, { status: 409 });
      }
      // Money gates: agreement signed + documents complete.
      const agreement = await auth.store.getReferralAgreementByPartner(entry.tenant_id, entry.partner_id).catch(() => null);
      if (!agreement || agreement.status !== "signed" || !agreement.signed_at) {
        return NextResponse.json(
          { error: "The partner must SIGN the referral agreement before a commission can be approved." },
          { status: 409 },
        );
      }
      if (!entry.documents_complete) {
        return NextResponse.json(
          { error: "All documents must be confirmed complete before approving (toggle the documents checklist)." },
          { status: 409 },
        );
      }
    }
    if ((action === "cancel" || action === "reopen_documents") && entry.status === "paid") {
      return NextResponse.json({ error: "A paid commission is final." }, { status: 409 });
    }

    const patch: Record<string, unknown> = {};
    if (typeof body.admin_notes === "string") patch.admin_notes = body.admin_notes.slice(0, 4000);
    if (action === "approve") patch.approved_by = auth.user?.id || null;

    const updated = await auth.store.transitionReferralCommission(id, action, patch);

    await audit(auth.store, auth.user, req, `referral_commission.${action}`, "referral_commission", id, {
      partner_id: entry.partner_id,
      from_status: entry.status,
      to_status: updated.status,
    });

    // Partner notification for the state changes they care about.
    const notifyMap: Record<string, { type: "referral_commission_confirmed" | "referral_commission_approved"; title: string; message: string } | null> = {
      confirm: {
        type: "referral_commission_confirmed",
        title: "Referred business confirmed",
        message: `The business you referred (${entry.referral_company}) was confirmed as completed.`,
      },
      approve: {
        type: "referral_commission_approved",
        title: "Commission approved for payout",
        message: `Your commission of ${Number(updated.commission_amount).toLocaleString()} ${updated.currency} (${entry.referral_company}) is approved for payout.`,
      },
      cancel: null,
      reopen_documents: null,
    };
    const n = notifyMap[action];
    if (n) {
      await notify({
        tenantId: entry.tenant_id,
        partnerId: entry.partner_id,
        type: n.type,
        title: n.title,
        message: n.message,
        entityType: "referral_commission",
        entityId: id,
        actionUrl: "/portal/referrals",
        actionLabel: "View",
      }).catch(() => {});
    }

    return NextResponse.json(updated);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
