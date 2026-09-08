import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requirePortalModule } from "@/lib/portal/module-permissions";
import { getStore } from "@/lib/data/store";
import { audit, sanitizeError, getIp } from "@/lib/api/helpers";
import { linkReferralAttachments, attachmentsForReferrals, MAX_REFERRAL_ATTACHMENTS } from "@/lib/portal/referral-attachments";

export const runtime = "nodejs";

/**
 * POST /api/portal/referrals/attachments — link already-uploaded documents
 * (category "commission", uploaded via /api/portal/upload) to one of the
 * caller's OWN referral commission entries. Ownership of BOTH the entry
 * and every upload row is validated server-side before linking.
 *
 * GET /api/portal/referrals/attachments?referral_id=… — list the documents
 * attached to one of the caller's own entries.
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

  let body: { referral_id?: unknown; attachment_ids?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const referralId = typeof body.referral_id === "string" ? body.referral_id : "";
  if (!referralId) {
    return NextResponse.json({ error: "referral_id is required." }, { status: 400 });
  }
  if (!Array.isArray(body.attachment_ids) || body.attachment_ids.length === 0) {
    return NextResponse.json({ error: "attachment_ids (non-empty array) is required." }, { status: 400 });
  }
  if (body.attachment_ids.length > MAX_REFERRAL_ATTACHMENTS) {
    return NextResponse.json({ error: `At most ${MAX_REFERRAL_ATTACHMENTS} documents per commission entry.` }, { status: 400 });
  }

  // Ownership: the referral entry must belong to the caller's partner.
  const entry = await store.getReferralCommission(referralId);
  if (!entry || entry.partner_id !== access.partner_id || entry.tenant_id !== access.tenant_id) {
    return NextResponse.json({ error: "Referral commission not found." }, { status: 404 });
  }
  // Business rule: once the entry is paid the document set is final.
  if (entry.status === "paid") {
    return NextResponse.json({ error: "This commission is already paid — the document set is closed." }, { status: 409 });
  }

  const linked = await linkReferralAttachments(access.tenant_id, access.partner_id, referralId, body.attachment_ids);
  if (linked === 0) {
    return NextResponse.json({ error: "No valid documents to attach (they must be your own uploads)." }, { status: 400 });
  }

  await audit(
    store,
    { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
    req,
    "referral_documents.linked",
    "referral_commission",
    referralId,
    { partner_id: access.partner_id, linked, ip: getIp(req) },
  );

  const byReferral = await attachmentsForReferrals(access.tenant_id, access.partner_id, [referralId]);
  return NextResponse.json({ linked, items: byReferral.get(referralId) || [] });
}

export async function GET(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  // 099 — module permission gate (referrals).
  const _moduleBlock = await requirePortalModule(access, "referrals");
  if (_moduleBlock) return _moduleBlock;
  const referralId = new URL(req.url).searchParams.get("referral_id") || "";
  if (!referralId) {
    return NextResponse.json({ error: "referral_id is required." }, { status: 400 });
  }
  // Ownership check before listing.
  const store = await getStore();
  const entry = await store.getReferralCommission(referralId);
  if (!entry || entry.partner_id !== access.partner_id || entry.tenant_id !== access.tenant_id) {
    return NextResponse.json({ error: "Referral commission not found." }, { status: 404 });
  }
  const byReferral = await attachmentsForReferrals(access.tenant_id, access.partner_id, [referralId]);
  return NextResponse.json({ items: byReferral.get(referralId) || [] });
}
