import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, audit, sanitizeError } from "@/lib/api/helpers";
import { decryptField } from "@/lib/crypto/field-encryption";
import { attachmentsForReferrals } from "@/lib/portal/referral-attachments";

export const runtime = "nodejs";

// GET /api/referral-commissions/[id] — full admin detail: entry + partner +
// uploaded documents + agreement + payout account (IBAN decrypted for the
// admin — they need it to execute the transfer).
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    {
      const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "commissions.read");
      if (_d) return _d;
    }
    const tenantId = resolveTenantId(auth, req);
    const { id } = await ctx.params;

    const entry = await auth.store.getReferralCommission(id);
    if (!entry) return NextResponse.json({ error: "Referral commission not found." }, { status: 404 });
    if (!auth.isSuperAdmin && entry.tenant_id !== tenantId) {
      return NextResponse.json({ error: "Referral commission not found." }, { status: 404 });
    }

    const [partner, agreement, account, uploadsMap] = await Promise.all([
      auth.store.getPartner(entry.partner_id).catch(() => null),
      auth.store.getReferralAgreementByPartner(entry.tenant_id, entry.partner_id).catch(() => null),
      auth.store.getReferralPayoutAccountByPartner(entry.tenant_id, entry.partner_id).catch(() => null),
      attachmentsForReferrals(entry.tenant_id, null, [entry.id]),
    ]);

    return NextResponse.json({
      ...entry,
      partner_name: partner?.name || "—",
      partner_email: partner?.contact_email || null,
      attachments: uploadsMap.get(entry.id) || [],
      agreement: agreement
        ? {
            id: agreement.id,
            status: agreement.status,
            commission_type: agreement.commission_type,
            commission_rate: agreement.commission_rate,
            commission_currency: agreement.commission_currency,
            conditions: agreement.conditions,
            agreement_version: agreement.agreement_version,
            activated_at: agreement.activated_at,
            signed_at: agreement.signed_at,
            signed_by_name: agreement.signed_by_name,
            signed_version: agreement.signed_version,
            signed_ip: agreement.signed_ip,
            signed_user_agent: agreement.signed_user_agent,
          }
        : null,
      payout_account: account
        ? {
            id: account.id,
            status: account.status,
            beneficiary_name: account.beneficiary_name,
            bank_name: account.bank_name,
            iban: account.iban_enc ? decryptField(account.iban_enc) : "",
            iban_masked: account.iban_masked,
            swift_bic: account.swift_bic,
            account_currency: account.account_currency,
            country: account.country,
            additional_instructions: account.additional_instructions,
            verified_by: account.verified_by,
            verified_at: account.verified_at,
          }
        : null,
    });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

// PUT /api/referral-commissions/[id] — admin edits the editable fields
// (referral details, product, values, conditions, notes, the documents
// checklist toggle). Lifecycle status changes go through /transition and
// /mark-paid — the store layer strips status stamps from the generic
// upsert, so they can't be smuggled through this route.
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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

    const existing = await auth.store.getReferralCommission(id);
    if (!existing) return NextResponse.json({ error: "Referral commission not found." }, { status: 404 });
    if (!auth.isSuperAdmin && existing.tenant_id !== tenantId) {
      return NextResponse.json({ error: "Referral commission not found." }, { status: 404 });
    }
    if (existing.status === "paid") {
      return NextResponse.json({ error: "A paid commission is read-only." }, { status: 409 });
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const patch: Record<string, unknown> = {};
    if (typeof body.referral_company === "string" && body.referral_company.trim().length >= 2) patch.referral_company = body.referral_company.trim().slice(0, 300);
    if (typeof body.referral_contact === "string") patch.referral_contact = body.referral_contact.trim().slice(0, 200) || null;
    if (typeof body.referral_email === "string") patch.referral_email = body.referral_email.trim().slice(0, 200) || null;
    if (typeof body.referral_phone === "string") patch.referral_phone = body.referral_phone.trim().slice(0, 60) || null;
    if (typeof body.ref_number === "string") patch.ref_number = body.ref_number.trim().slice(0, 100) || null;
    if (typeof body.product === "string") patch.product = body.product.trim().slice(0, 500) || null;
    if (body.deal_value !== undefined) {
      const v = body.deal_value === null ? null : Number(body.deal_value);
      if (v !== null && (!Number.isFinite(v) || v < 0)) return NextResponse.json({ error: "Invalid deal value." }, { status: 400 });
      patch.deal_value = v;
    }
    if (typeof body.currency === "string" && body.currency.trim().length === 3) patch.currency = body.currency.trim().toUpperCase();
    if (typeof body.commission_type === "string" && ["revenue_percent", "profit_percent", "fixed", "per_unit"].includes(body.commission_type)) patch.commission_type = body.commission_type;
    if (body.commission_rate !== undefined) {
      const v = body.commission_rate === null ? null : Number(body.commission_rate);
      if (v !== null && (!Number.isFinite(v) || v < 0)) return NextResponse.json({ error: "Invalid rate." }, { status: 400 });
      patch.commission_rate = v;
    }
    if (body.commission_amount !== undefined) {
      const v = Number(body.commission_amount);
      if (!Number.isFinite(v) || v < 0) return NextResponse.json({ error: "Invalid commission amount." }, { status: 400 });
      patch.commission_amount = v;
    }
    if (typeof body.conditions === "string") patch.conditions = body.conditions.slice(0, 4000) || null;
    if (typeof body.admin_notes === "string") patch.admin_notes = body.admin_notes.slice(0, 4000) || null;
    // Documents checklist toggle (admin confirms "all documents are in").
    if (body.documents_complete === true || body.documents_complete === false) {
      patch.documents_complete = body.documents_complete;
      patch.documents_checked_by = auth.user?.id || null;
      patch.documents_checked_at = new Date().toISOString();
    }

    const updated = await auth.store.upsertReferralCommission({ id, tenant_id: existing.tenant_id, ...patch } as never);
    await audit(auth.store, auth.user, req, "referral_commission.update", "referral_commission", id, { fields: Object.keys(patch) });
    return NextResponse.json(updated);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

// DELETE /api/referral-commissions/[id] — remove a wrongly created entry.
// Blocked once money moved (paid) — history must survive an audit.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    {
      const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "commissions.delete");
      if (_d) return _d;
    }
    const tenantId = resolveTenantId(auth, req);
    const { id } = await ctx.params;

    const existing = await auth.store.getReferralCommission(id);
    if (!existing) return NextResponse.json({ error: "Referral commission not found." }, { status: 404 });
    if (!auth.isSuperAdmin && existing.tenant_id !== tenantId) {
      return NextResponse.json({ error: "Referral commission not found." }, { status: 404 });
    }
    if (existing.status === "paid") {
      return NextResponse.json({ error: "A paid commission cannot be deleted — cancel is final for paid history only via support." }, { status: 409 });
    }

    await auth.store.deleteReferralCommission(id);
    await audit(auth.store, auth.user, req, "referral_commission.delete", "referral_commission", id, {
      partner_id: existing.partner_id,
      referral_company: existing.referral_company,
      amount: existing.commission_amount,
    });
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
