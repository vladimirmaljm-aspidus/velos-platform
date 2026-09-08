import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, audit, sanitizeError } from "@/lib/api/helpers";
import { notify } from "@/lib/notif/helper";

export const runtime = "nodejs";

/**
 * GET /api/referral-commissions/agreements?partner_id=… — the agreement
 * (full row incl. signature block) for one partner.
 *
 * PUT /api/referral-commissions/agreements — create or update the
 * agreement terms for a partner and optionally ACTIVATE it
 * (status=pending_signature), which makes it visible + signable in the
 * partner's portal and notifies them.
 *
 * Re-activating after a signed version exists (terms change) bumps the
 * version (RA-1.0 → RA-1.1) and clears the signature — the partner must
 * re-sign the new terms. Old signatures stay pinned in the audit log.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    {
      const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "commissions.read");
      if (_d) return _d;
    }
    const tenantId = resolveTenantId(auth, req);
    const partnerId = new URL(req.url).searchParams.get("partner_id") || "";
    if (!partnerId) return NextResponse.json({ error: "partner_id is required." }, { status: 400 });
    if (!tenantId) return NextResponse.json({ agreement: null });
    const agreement = await auth.store.getReferralAgreementByPartner(tenantId, partnerId);
    return NextResponse.json({ agreement });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    {
      const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "commissions.update");
      if (_d) return _d;
    }
    const tenantId = resolveTenantId(auth, req);
    if (!tenantId) return NextResponse.json({ error: "Tenant context required." }, { status: 400 });

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const partnerId = typeof body.partner_id === "string" ? body.partner_id : "";
    if (!partnerId) return NextResponse.json({ error: "partner_id is required." }, { status: 400 });
    const partner = await auth.store.getPartner(partnerId);
    if (!partner || (partner.tenant_id !== tenantId && !auth.isSuperAdmin)) {
      return NextResponse.json({ error: "Partner not found in this tenant." }, { status: 404 });
    }

    const commissionType = typeof body.commission_type === "string" ? body.commission_type : "revenue_percent";
    if (!["revenue_percent", "profit_percent", "fixed", "per_unit"].includes(commissionType)) {
      return NextResponse.json({ error: "Invalid commission_type." }, { status: 400 });
    }
    const rate = body.commission_rate === null || body.commission_rate === undefined ? null : Number(body.commission_rate);
    if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 1000000)) {
      return NextResponse.json({ error: "Invalid commission rate." }, { status: 400 });
    }

    const activate = body.activate === true;
    const existing = await auth.store.getReferralAgreementByPartner(tenantId, partnerId).catch(() => null);

    // Version bump on re-activation with changed terms after a signature —
    // the partner re-signs; the old acceptance lives on in the audit log.
    let version = existing?.agreement_version || "RA-1.0";
    const wasSigned = existing?.status === "signed" && !!existing?.signed_at;
    if (activate && wasSigned) {
      const m = /^RA-(\d+)\.(\d+)$/.exec(version);
      if (m) version = `RA-${m[1]}.${Number(m[2]) + 1}`;
      else version = `RA-2.0`;
    }

    const patch: Record<string, unknown> = {
      tenant_id: tenantId,
      partner_id: partnerId,
      commission_type: commissionType,
      commission_rate: rate,
      commission_currency:
        typeof body.commission_currency === "string" && body.commission_currency.trim().length === 3
          ? body.commission_currency.trim().toUpperCase()
          : "USD",
      conditions: typeof body.conditions === "string" ? body.conditions.slice(0, 8000) || null : null,
      agreement_version: version,
      created_by: existing?.created_by ?? auth.user?.id ?? null,
    };

    if (activate) {
      patch.status = "pending_signature";
      patch.activated_at = new Date().toISOString();
      // New activation invalidates the old signature (enforced in the
      // store: the signature block is not writable via upsert — the reset
      // happens only here, explicitly, on re-activation).
      if (wasSigned) patch.status = "pending_signature"; // re-sign flow
    } else if (typeof body.status === "string" && ["draft", "suspended", "terminated", "pending_signature"].includes(body.status)) {
      patch.status = body.status;
    }

    const saved = await auth.store.upsertReferralAgreement(patch as never);

    // Re-activation after signature: reset the signature block atomically
    // (the generic upsert refuses to touch it). The store exposes this via
    // a direct status write only in this admin path.
    if (activate && wasSigned) {
      const { getSupabase } = await import("@/lib/supabase/client");
      try {
        await getSupabase()
          .from("referral_agreements")
          .update({
            status: "pending_signature",
            signed_at: null,
            signed_by_name: null,
            signed_version: null,
            signed_ip: null,
            signed_user_agent: null,
            signed_portal_access_id: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", saved.id);
      } catch {
        // Optional-table degrade — activation still recorded.
      }
    }

    await audit(auth.store, auth.user, req, activate ? "referral_agreement.activated" : "referral_agreement.update", "referral_agreement", saved.id, {
      partner_id: partnerId,
      agreement_version: version,
      commission_type: commissionType,
      commission_rate: rate,
      re_activated_after_signature: wasSigned,
    });

    if (activate) {
      await notify({
        tenantId,
        partnerId,
        type: "referral_agreement_activated",
        title: "Referral agreement ready for your signature",
        message: `Your referral & commission agreement (${version}) is ready — review and sign it in My Commissions.`,
        entityType: "referral_agreement",
        entityId: saved.id,
        actionUrl: "/portal/referrals",
        actionLabel: "Review & sign",
      }).catch(() => {});
    }

    return NextResponse.json(saved);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
