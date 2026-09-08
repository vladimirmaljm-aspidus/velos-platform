import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, audit, sanitizeError } from "@/lib/api/helpers";
import { decryptField } from "@/lib/crypto/field-encryption";
import { attachmentsForReferrals } from "@/lib/portal/referral-attachments";
import { resolveReferralLinkedEntity } from "@/lib/api/referral-refs";

export const runtime = "nodejs";

// Valid ref types — mirrors the POST route's allowlist (kept local: route
// files must only export handlers + Next config).
const REF_TYPES = ["deal", "offer", "invoice", "proforma", "loi", "rfq", "manual"] as const;

/** Stringify an audit-diff value: null/undefined/"" → "—", booleans → true/false. */
function diffValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** Compute a field-level [{field, from, to}] diff for every patch field
 *  that ACTUALLY changed (numbers tolerate 0.01 — cosmetic rounding from
 *  the client is not a change). Unchanged fields are omitted entirely. */
function diffPatch(
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
): Array<{ field: string; from: string; to: string }> {
  const changes: Array<{ field: string; from: string; to: string }> = [];
  for (const [field, to] of Object.entries(patch)) {
    const from = before[field];
    const changed = typeof to === "number" && typeof from === "number"
      ? Math.abs(to - from) > 0.01
      : to !== from;
    if (changed) changes.push({ field, from: diffValue(from), to: diffValue(to) });
  }
  return changes;
}

// GET /api/referral-commissions/[id] — full admin detail: entry + partner +
// uploaded documents + agreement + payout account (IBAN decrypted for the
// admin — they need it to execute the transfer). 46-b: also a linked_entity
// block with the LIVE deal/offer/invoice/proforma/LOI/RFQ behind the
// (ref_type, ref_id) link, so the admin detail sheet shows what the
// commission is tied to TODAY, not the stale creation snapshot.
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

    // 46-b — live linked-entity business card. Resolved against the entry's
    // own tenant (a super-admin inspecting another tenant sees that tenant's
    // record); degrades to null when nothing is linked / anything throws.
    const linked_entity = await resolveReferralLinkedEntity(auth.store, entry.tenant_id, entry);

    return NextResponse.json({
      ...entry,
      partner_name: partner?.name || "—",
      linked_entity,
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
// checklist toggle — and since 46-b also the (ref_type, ref_id) link to a
// real deal/offer/invoice/proforma/LOI/RFQ, validated cross-tenant exactly
// like POST). Lifecycle status changes go through /transition and
// /mark-paid — the store layer strips status stamps from the generic
// upsert, so they can't be smuggled through this route. Every patch is
// diffed against the pre-update snapshot and logged field-by-field
// (old → new) into the audit trail.
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

    // 46-b — the (ref_type, ref_id) link. ref_type: validate ∈ the same set
    // POST accepts. ref_id: string|null; when non-null AND the effective
    // type isn't manual, assert the entity exists + belongs to the entry's
    // tenant (same guard as POST, so a row from another tenant can never be
    // attached via an edit either). Switching the type to "manual" forces
    // ref_id null — a manual entry never carries a dangling link.
    if (body.ref_type !== undefined) {
      if (typeof body.ref_type !== "string" || !(REF_TYPES as readonly string[]).includes(body.ref_type)) {
        return NextResponse.json({ error: "Invalid ref_type." }, { status: 400 });
      }
      patch.ref_type = body.ref_type;
    }
    if (body.ref_id !== undefined) {
      if (body.ref_id === null) {
        patch.ref_id = null;
      } else if (typeof body.ref_id === "string") {
        patch.ref_id = body.ref_id.trim().slice(0, 100) || null;
      } else {
        return NextResponse.json({ error: "Invalid ref_id." }, { status: 400 });
      }
    }
    const effectiveType = (patch.ref_type as string | undefined) ?? existing.ref_type;
    if (effectiveType === "manual") {
      // Manual entry: the link is severed even when the client didn't send
      // ref_id explicitly (type switch alone must clear it).
      patch.ref_id = null;
    } else {
      // Type switched to a DIFFERENT entity kind without a new ref_id in
      // the same request — the old id points at the wrong table, so sever
      // it (the admin UI clears ref_id on every type switch; this makes the
      // route safe for raw API callers too).
      if (patch.ref_type !== undefined && patch.ref_type !== existing.ref_type && patch.ref_id === undefined) {
        patch.ref_id = null;
      }
      if (patch.ref_id) {
        const { assertRefEntity } = await import("@/lib/api/referral-refs");
        const refErr = await assertRefEntity(auth.store, existing.tenant_id, effectiveType, patch.ref_id as string);
        if (refErr) return refErr;
      }
    }

    // Documents checklist toggle (admin confirms "all documents are in").
    if (body.documents_complete === true || body.documents_complete === false) {
      patch.documents_complete = body.documents_complete;
      patch.documents_checked_by = auth.user?.id || null;
      patch.documents_checked_at = new Date().toISOString();
    }

    const updated = await auth.store.upsertReferralCommission({ id, tenant_id: existing.tenant_id, ...patch } as never);

    // 46-b — field-level edit history: snapshot was taken above (existing);
    // compute [{field, from, to}] for every patch field that actually
    // changed (numbers tolerate 0.01) and stamp it into the audit details so
    // the History panel can show "amount: 100 → 250" instead of just names.
    const changes = diffPatch(existing as unknown as Record<string, unknown>, patch);
    await audit(auth.store, auth.user, req, "referral_commission.update", "referral_commission", id, {
      fields: Object.keys(patch),
      changes: changes.length ? changes : undefined,
    });
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
