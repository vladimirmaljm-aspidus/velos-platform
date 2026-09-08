import { NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requirePortalModule } from "@/lib/portal/module-permissions";
import { getStore } from "@/lib/data/store";
import { decryptField } from "@/lib/crypto/field-encryption";
import { attachmentsForReferrals, attachToReferrals } from "@/lib/portal/referral-attachments";

export const runtime = "nodejs";

/**
 * GET /api/portal/referrals — the partner's own referral-commission
 * workspace in one payload: their commission entries (with document
 * attachments), the agreement (only once activated — drafts stay private
 * to the admin), the payout bank account (owner sees the full IBAN), and
 * headline stats for the KPI cards.
 */
export async function GET() {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  // 099 — module permission gate (referrals).
  const _moduleBlock = await requirePortalModule(access, "referrals");
  if (_moduleBlock) return _moduleBlock;
  const store = await getStore();

  const [items, agreement, account] = await Promise.all([
    store.listReferralCommissionsByPartner(access.partner_id),
    store.getReferralAgreementByPartner(access.tenant_id, access.partner_id).catch(() => null),
    store.getReferralPayoutAccountByPartner(access.tenant_id, access.partner_id).catch(() => null),
  ]);

  // Attach the document checklist metadata to each entry (no-op pre-097).
  const withAttachments = attachToReferrals(
    items,
    await attachmentsForReferrals(access.tenant_id, access.partner_id, items.map((r) => r.id)),
  );

  // Stats for the overview cards.
  const live = items.filter((r) => r.status !== "cancelled");
  const stats = {
    total_entries: live.length,
    total_commission: live.reduce((s, r) => s + (Number(r.commission_amount) || 0), 0),
    paid_commission: live.filter((r) => r.status === "paid").reduce((s, r) => s + (Number(r.paid_amount ?? r.commission_amount) || 0), 0),
    approved_commission: live.filter((r) => r.status === "approved").reduce((s, r) => s + (Number(r.commission_amount) || 0), 0),
    pending_commission: live.filter((r) => r.status === "pending" || r.status === "confirmed").reduce((s, r) => s + (Number(r.commission_amount) || 0), 0),
    currency: live[0]?.currency || "USD",
  };

  // Agreement: hide admin drafts — the partner only sees it once activated.
  const publicAgreement =
    agreement && agreement.status !== "draft"
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
        }
      : null;

  // Payout account: the OWNER sees the full IBAN (they typed it); the
  // ciphertext/hmac never leave the server.
  const publicAccount = account
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
        verified_at: account.verified_at,
        updated_at: account.updated_at,
      }
    : null;

  return NextResponse.json({
    items: withAttachments,
    stats,
    agreement: publicAgreement,
    payout_account: publicAccount,
  });
}
