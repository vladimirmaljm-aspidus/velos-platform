import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, audit, sanitizeError } from "@/lib/api/helpers";
import { notify } from "@/lib/notif/helper";

export const runtime = "nodejs";

/**
 * POST /api/referral-commissions/payout-accounts/[id]/verify — admin
 * verifies (or rejects) the partner's payout bank details. Verified bank
 * details are a precondition for paying out commissions (enforced in the
 * admin UI workflow; the paid transition shows the account + status).
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

    let body: { status?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const status = body.status;
    if (status !== "verified" && status !== "rejected") {
      return NextResponse.json({ error: 'status must be "verified" or "rejected".' }, { status: 400 });
    }

    // Fetch via the store's partner lookup to validate tenant ownership:
    // the row id alone must never be trusted cross-tenant.
    const { getSupabase } = await import("@/lib/supabase/client");
    const { data: row } = await getSupabase()
      .from("referral_payout_accounts")
      .select("id, tenant_id, partner_id, status")
      .eq("id", id)
      .maybeSingle();
    if (!row || (!auth.isSuperAdmin && row.tenant_id !== tenantId)) {
      return NextResponse.json({ error: "Payout account not found." }, { status: 404 });
    }

    const updated = await auth.store.verifyReferralPayoutAccount(id, {
      status,
      verified_by: auth.user?.id || "admin",
    });

    await audit(auth.store, auth.user, req, "referral_bank.verified", "referral_payout_account", id, {
      partner_id: row.partner_id,
      status,
    });

    if (status === "verified") {
      await notify({
        tenantId: row.tenant_id,
        partnerId: row.partner_id,
        type: "referral_bank_verified",
        title: "Payout bank details verified",
        message: "Your bank details for commission payouts were verified. Approved commissions can now be paid out.",
        entityType: "referral_payout_account",
        entityId: id,
        actionUrl: "/portal/referrals",
        actionLabel: "View",
      }).catch(() => {});
    }

    return NextResponse.json({ id: updated.id, status: updated.status, verified_by: updated.verified_by, verified_at: updated.verified_at });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
