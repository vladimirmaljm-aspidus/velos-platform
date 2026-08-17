import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getStore } from "@/lib/data/store";
import { audit } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * Fields a portal client is allowed to set on their own KYC draft.
 *
 * Audit F-6/P1-4: same fix as /api/portal/kyc/submit/route.ts — the
 * previous version spread the entire client body into `upsertKycSubmission`,
 * letting a malicious client set admin-only fields (status="approved",
 * reviewed_by, review_notes, rejection_reason, auto_transferred) or
 * rewrite tenant_id / partner_id / portal_access_id to point at another
 * tenant's records. We now strip everything that isn't on this allowlist
 * and force the identity fields from the session context.
 */
const KYC_CLIENT_SETTABLE_FIELDS: ReadonlySet<string> = new Set([
  "entity_type",
  "kyc_type",
  "legal_name", "trade_name", "registration_number", "tax_id", "vat_number", "company_website",
  "address_line", "city", "state", "postal_code", "country",
  "contact_name", "contact_email", "contact_phone", "contact_position",
  "owner_name", "owner_id_type", "owner_id_number", "owner_nationality", "owner_dob", "owner_address",
  "business_activity", "expected_monthly_volume", "source_of_funds",
  "bank_name", "bank_account", "bank_iban", "bank_swift",
  "document_front", "document_back", "selfie", "additional_docs",
  "notes",
]);

function sanitizeKycClientBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (KYC_CLIENT_SETTABLE_FIELDS.has(key)) out[key] = value;
  }
  return out;
}

// Portal: get partner's KYC submission
export async function GET() {
  try {
    const access = await getPortalSessionAccess();
    if (!access) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

    // Premium clients are exempt — return exempt status
    if (access.exempt_kyc) {
      return NextResponse.json({ submission: null, exempt: true });
    }

    // Portal accounts must be linked to a partner before KYC can be loaded.
    if (!access.partner_id) {
      return NextResponse.json({ submission: null, exempt: false, unlinked: true });
    }

    const store = await getStore();
    const sub = await store.getKycSubmissionByPartner(access.partner_id);
    return NextResponse.json({ submission: sub, exempt: false });
  } catch (e: any) {
    console.error("[portal.kyc.GET]", e);
    return NextResponse.json(
      { error: "Could not load KYC status. Please refresh in a moment.", detail: e?.message || null },
      { status: 500 },
    );
  }
}

// Portal: save/update KYC submission (draft or submit)
export async function POST(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  if (!access.partner_id) {
    return NextResponse.json({ error: "Account not linked to a partner." }, { status: 400 });
  }
  const store = await getStore();

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  // Audit F-6/P1-4: strip the client body to the allowlist, then force
  // the identity fields from the session context. The client cannot set
  // status, reviewed_by, reviewed_at, review_notes, rejection_reason,
  // auto_transferred, tenant_id, partner_id, portal_access_id, or any
  // timestamp — only the form fields they actually fill in.
  const sanitized = sanitizeKycClientBody(body || {});
  // Force identity fields from the authenticated session — never trust
  // the client to tell us who they are.
  sanitized.partner_id = access.partner_id;
  sanitized.tenant_id = access.tenant_id;
  sanitized.portal_access_id = access.id;

  const existing = await store.getKycSubmissionByPartner(access.partner_id);
  if (existing) {
    sanitized.id = existing.id;
    // Preserve the existing status — a draft save must NOT silently
    // promote to "submitted"/"approved"/etc. The dedicated /submit
    // endpoint is the only way to flip draft → submitted.
    sanitized.status = existing.status;
    // Also preserve any prior review trail — only admins (via the CRM
    // KYC review endpoints) can write these fields.
    sanitized.reviewed_by = existing.reviewed_by;
    sanitized.reviewed_at = existing.reviewed_at;
    sanitized.review_notes = existing.review_notes;
    sanitized.rejection_reason = existing.rejection_reason;
    sanitized.auto_transferred = existing.auto_transferred;
    sanitized.submitted_at = existing.submitted_at;
  } else if (!sanitized.id) {
    // New draft — force status to "draft" (the only legitimate value
    // for a portal-side creation). The /submit endpoint flips it later.
    sanitized.status = "draft";
  }

  const saved = await store.upsertKycSubmission(sanitized as any);

  // Audit the KYC update
  try {
    await audit(
      store,
      { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
      req,
      "portal.kyc_updated",
      "kyc_submission",
      (saved as any)?.id,
      { fields: Object.keys(sanitized || {}) },
    );
  } catch (e) { console.error("[audit]", e); }

  return NextResponse.json(saved);
}
