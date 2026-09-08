import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requirePortalModule } from "@/lib/portal/module-permissions";
import { getStore } from "@/lib/data/store";
import { audit, sanitizeError, getIp } from "@/lib/api/helpers";
import { notify } from "@/lib/notif/helper";
import { encryptField, hmacField } from "@/lib/crypto/field-encryption";

export const runtime = "nodejs";

/**
 * PUT /api/portal/referrals/bank-account — the partner saves/updates the
 * bank account where they want commission payouts sent.
 *
 * Security:
 *   • the IBAN is normalised (strip spaces) and format-validated
 *     (2-letter country + 2 check digits + 10–30 alphanumeric);
 *   • stored ENCRYPTED (encryptField) with a masked display variant and
 *     an HMAC for equality lookup — plaintext IBAN never rests in the DB;
 *   • an update by the partner resets the verification status (admins
 *     must re-verify before payouts) — enforced in the store layer too;
 *   • every submission notifies the tenant admins for verification.
 */
export async function PUT(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  // 099 — module permission gate (referrals).
  const _moduleBlock = await requirePortalModule(access, "referrals");
  if (_moduleBlock) return _moduleBlock;
  const store = await getStore();

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const beneficiary = typeof body.beneficiary_name === "string" ? body.beneficiary_name.trim() : "";
  if (beneficiary.length < 2 || beneficiary.length > 200) {
    return NextResponse.json({ error: "Beneficiary name is required (2–200 characters)." }, { status: 400 });
  }

  const ibanRaw = typeof body.iban === "string" ? body.iban : "";
  const iban = ibanRaw.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(iban)) {
    return NextResponse.json({ error: "Please enter a valid IBAN (15–34 characters, e.g. DE89 3704 0044 0532 0130 00)." }, { status: 400 });
  }

  const bankName = typeof body.bank_name === "string" ? body.bank_name.trim().slice(0, 200) : "";
  const swiftRaw = typeof body.swift_bic === "string" ? body.swift_bic.trim().toUpperCase() : "";
  // Validate the FULL input first — truncating to 11 chars before the check
  // would silently accept 12+-char garbage as a valid-looking BIC.
  if (swiftRaw && !/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(swiftRaw)) {
    return NextResponse.json({ error: "Please enter a valid SWIFT/BIC code (8 or 11 characters) or leave it empty." }, { status: 400 });
  }
  const swift = swiftRaw;

  const currency = typeof body.account_currency === "string" ? body.account_currency.trim().toUpperCase().slice(0, 3) : "";
  const country = typeof body.country === "string" ? body.country.trim().slice(0, 60) : "";
  const instructions = typeof body.additional_instructions === "string" ? body.additional_instructions.trim().slice(0, 500) : "";

  // Masked variant for list surfaces: first 4 + last 4 characters.
  const masked = iban.length > 8 ? `${iban.slice(0, 4)} •••• •••• ${iban.slice(-4)}` : iban;

  try {
    const row = await store.upsertReferralPayoutAccount({
      tenant_id: access.tenant_id,
      partner_id: access.partner_id,
      beneficiary_name: beneficiary,
      bank_name: bankName || null,
      iban_enc: encryptField(iban),
      iban_masked: masked,
      iban_hmac: hmacField(iban),
      swift_bic: swift || null,
      account_currency: currency || null,
      country: country || null,
      additional_instructions: instructions || null,
      status: "submitted", // partner edit always re-submits for verification
    } as never);

    await audit(
      store,
      { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
      req,
      "referral_bank.saved",
      "referral_payout_account",
      row.id,
      { partner_id: access.partner_id, iban_masked: masked, ip: getIp(req) },
    );

    // Admins must verify the (new) details before payouts.
    await notify({
      tenantId: access.tenant_id,
      userId: null,
      type: "referral_bank_submitted",
      title: "Payout bank details submitted",
      message: `A partner submitted bank details for commission payouts (${masked}). Verification required.`,
      entityType: "referral_payout_account",
      entityId: row.id,
      actionLabel: "Review",
    }).catch(() => {});

    return NextResponse.json({
      payout_account: {
        id: row.id,
        status: row.status,
        beneficiary_name: row.beneficiary_name,
        bank_name: row.bank_name,
        iban,
        iban_masked: masked,
        swift_bic: row.swift_bic,
        account_currency: row.account_currency,
        country: row.country,
        additional_instructions: row.additional_instructions,
        verified_at: null,
        updated_at: row.updated_at,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
