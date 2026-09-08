import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, audit, sanitizeError } from "@/lib/api/helpers";
import { notify } from "@/lib/notif/helper";

export const runtime = "nodejs";

// GET /api/referral-commissions?partner_id=&status=&search=&limit=&offset=
// Admin list — every referral commission in the tenant, enriched with the
// partner's name + portal email + agreement status + payout account status
// so the admin table has full context in one round-trip.
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
    if (!tenantId) return NextResponse.json({ items: [], total: 0 });

    const url = new URL(req.url);
    const params = {
      partner_id: url.searchParams.get("partner_id") || undefined,
      status: url.searchParams.get("status") || undefined,
      search: url.searchParams.get("search") || undefined,
      limit: url.searchParams.get("limit") ? Math.min(Number(url.searchParams.get("limit")), 500) : undefined,
      offset: url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : undefined,
    };

    const result = await auth.store.listReferralCommissions(tenantId, params);

    // Enrich: partner name/email + agreement + bank status per partner.
    const partnerIds = [...new Set(result.items.map((r) => r.partner_id))];
    const partners = await Promise.all(partnerIds.map((pid) => auth.store.getPartner(pid).catch(() => null)));
    const partnerMap = new Map(partners.filter(Boolean).map((p) => [p!.id, p!]));
    const agreements = await Promise.all(partnerIds.map((pid) => auth.store.getReferralAgreementByPartner(tenantId, pid).catch(() => null)));
    const agreementMap = new Map(agreements.filter(Boolean).map((a) => [a!.partner_id, a!]));
    const accounts = await Promise.all(partnerIds.map((pid) => auth.store.getReferralPayoutAccountByPartner(tenantId, pid).catch(() => null)));
    const accountMap = new Map(accounts.filter(Boolean).map((a) => [a!.partner_id, a!]));

    const items = result.items.map((r) => {
      const partner = partnerMap.get(r.partner_id);
      const agreement = agreementMap.get(r.partner_id);
      const account = accountMap.get(r.partner_id);
      return {
        ...r,
        partner_name: partner?.name || "—",
        partner_email: partner?.contact_email || null,
        agreement_status: agreement?.status || null,
        agreement_signed_at: agreement?.signed_at || null,
        bank_status: account?.status || null,
        iban_masked: account?.iban_masked || null,
      };
    });

    return NextResponse.json({ items, total: result.total });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

// POST /api/referral-commissions — admin records a new referral commission
// for a partner. The partner is NOTIFIED immediately (portal bell) — the
// entry becomes visible in their "My Commissions" section.
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    {
      const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "commissions.create");
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

    const referralCompany = typeof body.referral_company === "string" ? body.referral_company.trim() : "";
    if (referralCompany.length < 2 || referralCompany.length > 300) {
      return NextResponse.json({ error: "Referral company name is required (2–300 characters)." }, { status: 400 });
    }

    const refType = typeof body.ref_type === "string" ? body.ref_type : "manual";
    if (!["deal", "offer", "invoice", "proforma", "loi", "rfq", "manual"].includes(refType)) {
      return NextResponse.json({ error: "Invalid ref_type." }, { status: 400 });
    }

    const commissionType = typeof body.commission_type === "string" ? body.commission_type : "revenue_percent";
    if (!["revenue_percent", "profit_percent", "fixed", "per_unit"].includes(commissionType)) {
      return NextResponse.json({ error: "Invalid commission_type." }, { status: 400 });
    }

    const dealValue = body.deal_value === null || body.deal_value === undefined ? null : Number(body.deal_value);
    if (dealValue !== null && (!Number.isFinite(dealValue) || dealValue < 0 || dealValue > 1_000_000_000_000)) {
      return NextResponse.json({ error: "Invalid deal value." }, { status: 400 });
    }
    const rate = body.commission_rate === null || body.commission_rate === undefined ? null : Number(body.commission_rate);
    if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 1000000)) {
      return NextResponse.json({ error: "Invalid commission rate." }, { status: 400 });
    }
    let amount = Number(body.commission_amount);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000_000) {
      // Auto-calc when the admin didn't enter the final amount.
      if (dealValue !== null && rate !== null) {
        amount = commissionType === "revenue_percent" || commissionType === "profit_percent"
          ? Math.round(dealValue * (rate / 100) * 100) / 100
          : rate;
      } else {
        amount = 0;
      }
    }

    // Cross-tenant IDOR guard: when linking an existing entity, it must
    // belong to this tenant.
    const refId = typeof body.ref_id === "string" && body.ref_id ? body.ref_id : null;
    if (refId && refType !== "manual") {
      const { assertRefEntity } = await import("@/lib/api/referral-refs");
      const refErr = await assertRefEntity(auth.store, tenantId, refType, refId);
      if (refErr) return refErr;
    }

    const agreement = await auth.store.getReferralAgreementByPartner(tenantId, partnerId).catch(() => null);

    const created = await auth.store.upsertReferralCommission({
      tenant_id: tenantId,
      partner_id: partnerId,
      referral_company: referralCompany,
      referral_contact: typeof body.referral_contact === "string" ? body.referral_contact.trim().slice(0, 200) || null : null,
      referral_email: typeof body.referral_email === "string" ? body.referral_email.trim().slice(0, 200) || null : null,
      referral_phone: typeof body.referral_phone === "string" ? body.referral_phone.trim().slice(0, 60) || null : null,
      ref_type: refType,
      ref_id: refId,
      ref_number: typeof body.ref_number === "string" ? body.ref_number.trim().slice(0, 100) || null : null,
      product: typeof body.product === "string" ? body.product.trim().slice(0, 500) || null : null,
      deal_value: dealValue,
      currency: (typeof body.currency === "string" && body.currency.trim().length === 3 ? body.currency.trim().toUpperCase() : "USD"),
      commission_type: commissionType,
      commission_rate: rate,
      commission_amount: amount,
      conditions: typeof body.conditions === "string" ? body.conditions.slice(0, 4000) || null : null,
      admin_notes: typeof body.admin_notes === "string" ? body.admin_notes.slice(0, 4000) || null : null,
      agreement_version: agreement?.agreement_version || null,
      created_by: auth.user?.id || null,
    } as never);

    await audit(auth.store, auth.user, req, "referral_commission.create", "referral_commission", created.id, {
      partner_id: partnerId,
      referral_company: referralCompany,
      amount,
      currency: created.currency,
      ref_type: refType,
      ref_id: refId,
    });

    // Partner notification (portal bell).
    await notify({
      tenantId,
      partnerId,
      type: "referral_commission_created",
      title: "New referral commission recorded",
      message: `A commission of ${amount.toLocaleString()} ${created.currency} (${referralCompany}) was recorded for you.`,
      entityType: "referral_commission",
      entityId: created.id,
      actionUrl: "/portal/referrals",
      actionLabel: "View",
    }).catch(() => {});

    return NextResponse.json(created, { status: 201 });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
