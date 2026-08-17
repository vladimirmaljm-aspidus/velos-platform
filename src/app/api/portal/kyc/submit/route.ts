import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getStore } from "@/lib/data/store";
import { getSupabase } from "@/lib/supabase/client";
import { notifyKycSubmitted } from "@/lib/notif/helper";
import { audit } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * Fields a portal client is allowed to set on their own KYC submission.
 *
 * Audit F-6/P1-4: previously this route spread the entire client body
 * into `upsertKycSubmission({...merged, status: "submitted"})`. While
 * `status` was force-overridden to "submitted", a malicious client could
 * still set admin-only fields like `reviewed_by`, `reviewed_at`,
 * `review_notes`, `rejection_reason`, or `auto_transferred` — letting
 * them fake an approval trail or mark themselves as auto-transferred.
 * They could also rewrite `tenant_id` / `partner_id` / `portal_access_id`
 * to point at another tenant's KYC (cross-tenant forgery, since the
 * upsert is not tenant-scoped at the DB level for service_role).
 *
 * We now whitelist ONLY the form fields the client genuinely fills in.
 * Server-controlled fields (ids, status, audit/review fields, timestamps)
 * are stripped and either re-applied from the session context or left
 * to the DB defaults.
 */
const KYC_CLIENT_SETTABLE_FIELDS: ReadonlySet<string> = new Set([
  // Entity type
  "entity_type",
  "kyc_type", // legacy alias still sent by some portal clients
  // Company / Individual data
  "legal_name",
  "trade_name",
  "registration_number",
  "tax_id",
  "vat_number",
  "company_website",
  // Address
  "address_line",
  "city",
  "state",
  "postal_code",
  "country",
  // Contact person
  "contact_name",
  "contact_email",
  "contact_phone",
  "contact_position",
  // Beneficial owner (AML)
  "owner_name",
  "owner_id_type",
  "owner_id_number",
  "owner_nationality",
  "owner_dob",
  "owner_address",
  // Business details
  "business_activity",
  "expected_monthly_volume",
  "source_of_funds",
  // Bank
  "bank_name",
  "bank_account",
  "bank_iban",
  "bank_swift",
  // Document references (metadata only — actual files live in
  // portal_uploads, validated separately by the document-count check below)
  "document_front",
  "document_back",
  "selfie",
  "additional_docs",
  // Free-form notes the client may attach to their submission
  "notes",
]);

/**
 * Strip the client body down to fields the portal client is allowed to
 * set. Everything else (ids, status, review fields, timestamps) is
 * dropped and either re-applied from the session/server context or left
 * to the DB.
 */
function sanitizeKycClientBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (KYC_CLIENT_SETTABLE_FIELDS.has(key)) out[key] = value;
  }
  return out;
}

// Portal: submit KYC for review (changes status from draft to submitted)
export async function POST(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const store = await getStore();

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const existing = await store.getKycSubmissionByPartner(access.partner_id);
  if (!existing) {
    return NextResponse.json({ error: "No KYC draft found. Save first." }, { status: 400 });
  }

  // Audit F-6/P1-4: strip the client body to the allowlist BEFORE merging
  // it on top of the existing draft. This guarantees a malicious client
  // cannot set admin-only fields (reviewed_by, review_notes,
  // rejection_reason, auto_transferred) or rewrite tenant/partner/portal
  // ids to point at another tenant's records.
  const sanitized = sanitizeKycClientBody(body || {});
  // Merge sanitized client fields on top of the existing draft so the
  // required-field validation below checks the combined data, not just
  // what the client sent in this request.
  const merged = { ...existing, ...sanitized };

  // Validate required fields before submission
  const required = ["legal_name", "tax_id", "address_line", "city", "country", "contact_name", "contact_email"];
  const missing = required.filter((f) => !merged[f as keyof typeof merged]);
  if (missing.length > 0) {
    return NextResponse.json({ error: `Missing required fields: ${missing.join(", ")}` }, { status: 400 });
  }

  // CRITICAL FIX (audit P0-2): validate at least one KYC document was uploaded
  // before allowing submission. Previously a partner could submit the KYC form
  // with zero supporting documents — admins would then have to bounce it back,
  // creating a back-and-forth loop and delaying approval. We require ≥1 active
  // (non-deleted) upload in the "kyc" category for this (partner, tenant).
  const { data: docs } = await getSupabase()
    .from("portal_uploads")
    .select("id, category")
    .eq("partner_id", access.partner_id)
    .eq("tenant_id", access.tenant_id)
    .eq("category", "kyc")
    .is("deleted_at", null) // exclude soft-deleted uploads
    .limit(1);
  if (!docs || docs.length === 0) {
    return NextResponse.json(
      { error: "Please upload at least one KYC document before submitting." },
      { status: 400 },
    );
  }

  // Build the final upsert payload: existing draft + sanitized client
  // fields, then force the server-controlled fields. `status` is always
  // "submitted" on this endpoint; `submitted_at` is now; review fields
  // are explicitly nulled so a re-submission after rejection clears the
  // prior admin trail (the next reviewer starts fresh).
  const updated = await store.upsertKycSubmission({
    ...merged,
    id: existing.id,
    tenant_id: existing.tenant_id,
    partner_id: existing.partner_id,
    portal_access_id: existing.portal_access_id,
    status: "submitted",
    submitted_at: new Date().toISOString(),
    // Clear prior review trail — the admin will re-review from scratch.
    reviewed_by: null,
    reviewed_at: null,
    review_notes: null,
    rejection_reason: null,
    auto_transferred: false,
  } as any);

  // Audit the KYC submission (FLOW-5)
  try {
    await audit(
      store,
      { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
      req,
      "portal.kyc_submitted",
      "kyc_submission",
      updated.id,
      { submission_type: (updated as any)?.entity_type || (sanitized as any)?.entity_type || null },
    );
  } catch (e) { console.error("[audit]", e); }

  // Notify tenant admins
  const partner = await store.getPartner(access.partner_id);
  await notifyKycSubmitted(access.tenant_id, partner?.name || "A client", updated.id);

  return NextResponse.json(updated);
}
