import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requirePortalModule } from "@/lib/portal/module-permissions";
import { getStore } from "@/lib/data/store";
import { audit, sanitizeError, getIp } from "@/lib/api/helpers";
import { notify } from "@/lib/notif/helper";

export const runtime = "nodejs";

/**
 * POST /api/portal/referrals/agreement — the partner SIGNS the referral +
 * commission agreement (typed full name + explicit consent checkbox).
 *
 * Guards (mirroring the legal.consent flow):
 *   • the agreement must belong to the caller's tenant+partner AND be in
 *     status "pending_signature" (drafts/suspended/terminated → 409);
 *   • the typed name must be 3+ chars, ≤200 chars;
 *   • consent must be explicitly true;
 *   • the store signs ATOMICALLY (guarded UPDATE: status=pending_signature
 *     AND signed_at IS NULL) so a double-submit can never stamp twice;
 *   • acceptance is audit-logged with the pinned version + IP/UA.
 */
export async function POST(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  // 099 — module permission gate (referrals).
  const _moduleBlock = await requirePortalModule(access, "referrals");
  if (_moduleBlock) return _moduleBlock;
  const store = await getStore();

  let body: { typed_name?: unknown; consent?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const typedName = typeof body.typed_name === "string" ? body.typed_name.trim() : "";
  if (typedName.length < 3 || typedName.length > 200) {
    return NextResponse.json({ error: "Please type your full legal name (3–200 characters)." }, { status: 400 });
  }
  if (body.consent !== true) {
    return NextResponse.json({ error: "You must explicitly consent to the agreement terms." }, { status: 400 });
  }

  const agreement = await store.getReferralAgreementByPartner(access.tenant_id, access.partner_id);
  if (!agreement) {
    return NextResponse.json({ error: "No agreement has been activated for your account yet." }, { status: 404 });
  }
  if (agreement.status === "signed" && agreement.signed_at) {
    return NextResponse.json({ error: "The agreement is already signed." }, { status: 409 });
  }
  if (agreement.status !== "pending_signature") {
    return NextResponse.json({ error: "The agreement is not open for signature." }, { status: 409 });
  }

  try {
    const signed = await store.signReferralAgreement(agreement.id, {
      signed_by_name: typedName,
      signed_version: agreement.agreement_version,
      signed_ip: getIp(req),
      signed_user_agent: req.headers.get("user-agent")?.slice(0, 400) || undefined,
      signed_portal_access_id: access.id,
    });

    await audit(
      store,
      { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
      req,
      "referral_agreement.signed",
      "referral_agreement",
      signed.id,
      {
        partner_id: access.partner_id,
        agreement_version: signed.agreement_version,
        signed_version: signed.signed_version,
        signed_by_name: typedName,
        signed_at: signed.signed_at,
        ip: getIp(req),
      },
    );

    // Notify tenant admins (broadcast) that the partner signed.
    await notify({
      tenantId: access.tenant_id,
      userId: null,
      type: "referral_agreement_signed",
      title: "Referral agreement signed",
      message: `Partner signed the referral & commission agreement (${signed.signed_version}) as "${typedName}".`,
      entityType: "referral_agreement",
      entityId: signed.id,
      actionLabel: "View",
    }).catch(() => {});

    return NextResponse.json({ agreement: { id: signed.id, status: signed.status, signed_at: signed.signed_at, signed_by_name: signed.signed_by_name, signed_version: signed.signed_version } });
  } catch (error) {
    // The guarded UPDATE fails with PGRST116 when a concurrent request
    // already signed it — surface a clean 409 instead of a raw 500.
    const msg = String((error as { message?: string })?.message || "");
    if (msg.includes("multiple") || msg.includes("no rows") || msg.includes("PGRST116")) {
      return NextResponse.json({ error: "The agreement is already signed." }, { status: 409 });
    }
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
