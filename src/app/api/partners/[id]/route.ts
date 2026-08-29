import { NextRequest, NextResponse } from "next/server";
// FIX-ALL-2 / Fix 3 — accept API-key auth on [id] routes so an API-key
// caller fetching /api/partners/<non-existent-id> gets 404 (not 401).
import { requireAuthOrApiKey, hasPermission, audit, sanitizeError } from "@/lib/api/helpers";
// FIX-ALL-2 / Fix 1 — strip KYC / bank / vat / tax fields from API-key responses.
import { redactPartnerFields } from "@/lib/api/redact";
// FIX-ALL-2 / Fix 6 — XSS prevention on free-text fields.
import { sanitizeFields } from "@/lib/security/sanitize-input";
// SEC-M9 — partner mass-assignment whitelist (shared with POST handler).
import { whitelistPartnerFields } from "@/app/api/partners/route";
// P0-3 / Feature 2 — field-level encryption. The partner PII fields
// contact_email, phone, tax_id, vat_number are encrypted at rest (enc:
// prefix). This [id] route decrypts on GET and encrypts on PUT.
import {
  encryptField,
  decryptField,
  hmacField,
  isEncrypted,
} from "@/lib/crypto/field-encryption";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthOrApiKey(_req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (partners.read) — session callers go through
    // requirePermission; API-key callers go through hasPermission.
    { const { requirePermission } = await import("@/lib/permissions/can");
      if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "partners.read"); if (_d) return _d; } }
    if ("apiKeyId" in auth && !hasPermission(auth.permissions, "partners:read")) {
      return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
    }

    const { id } = await params;
    const partner = await auth.store.getPartner(id);
    // FIX-ALL-2 / Fix 3 — not-found returns 404, not 401. Previously an
    // API-key caller hit `requireAuth` first (which rejects Bearer tokens)
    // and got 401 for every [id] lookup, masking the genuine 404 case.
    if (!partner) return NextResponse.json({ error: "Not found." }, { status: 404 });
    // Tenant-ownership check uses `auth.isSuperAdmin` for session callers;
    // API-key callers are scoped to their own tenant and have no
    // `isSuperAdmin` property.
    const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
    if (!isSuperAdmin && partner.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    // CRITICAL FIX (audit D-5 / F-9-1): strip portal_token from the API
    // response. The list route already strips it, but this [id] route was
    // returning the full row including the secret. `portal_token` is a
    // legacy 32+ char secret stored on the partner row — leaking it to any
    // partner:read principal (including API keys) is a credential exposure.
    // P0-3 / Feature 2: decrypt contact_email / phone / tax_id /
    // vat_number for the admin UI; strip the internal HMAC columns.
    const { portal_token: _omit, tax_id_hmac: _omitTid, vat_number_hmac: _omitVn, ...safePartner } = partner as any;
    if (safePartner.contact_email && typeof safePartner.contact_email === "string") {
      safePartner.contact_email = decryptField(safePartner.contact_email);
    }
    if (safePartner.phone && typeof safePartner.phone === "string") {
      safePartner.phone = decryptField(safePartner.phone);
    }
    if (safePartner.tax_id && typeof safePartner.tax_id === "string") {
      safePartner.tax_id = decryptField(safePartner.tax_id);
    }
    if (safePartner.vat_number && typeof safePartner.vat_number === "string") {
      safePartner.vat_number = decryptField(safePartner.vat_number);
    }
    // FIX-ALL-2 / Fix 1 — strip KYC / bank / vat / tax from API-key responses.
    const redactedPartner = redactPartnerFields(safePartner as any, auth);
    return NextResponse.json(redactedPartner);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (partners.update) — session callers use requirePermission,
  // API-key callers use hasPermission (colon format).
  { const { requirePermission } = await import("@/lib/permissions/can");
    if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "partners.update"); if (_d) return _d; } }
  if ("apiKeyId" in auth && !hasPermission(auth.permissions, "partners:write")) {
    return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
  }

    const { id } = await params;
    // Tenant ownership check: fetch existing first
    const existing = await auth.store.getPartner(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
    if (!isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    // FIX-ALL-2 / Fix 6 — XSS prevention on free-text fields (parity with POST).
    body = sanitizeFields(body, [
      "name",
      "legal_name",
      "description",
      "contact_person",
      "address",
      "city",
      "state",
      "country",
      "website",
      "notes",
    ]);
    // SEC-M9 (mass-assignment) — apply the field whitelist BEFORE the
    // encryption step. Strips client-supplied values for privileged
    // columns (approved_by, kyc_status, verification_level, portal_token,
    // *_hmac, …) so a partner:write caller cannot self-approve KYC or
    // mint a portal token via a PUT. tenant_id is intentionally NOT in
    // the whitelist — the upsert spread below overrides it with the
    // existing row's tenant_id, so a tenant-move attempt is silently
    // dropped. The encryption block then SETS the *_hmac columns
    // server-side from the plaintext tax_id / vat_number the whitelist
    // preserved.
    body = whitelistPartnerFields(body);
    // ── P0-3 / Feature 2 — field-level encryption ──────────────────────────
    // Encrypt contact_email, phone, tax_id, vat_number at rest with
    // AES-256-GCM (enc: prefix). tax_id / vat_number ALSO get a
    // deterministic HMAC token (tax_id_hmac / vat_number_hmac) for the
    // duplicate-check on the next create. Idempotent: already-encrypted
    // values (enc: prefix) are left untouched so a re-save of a loaded-but-
    // unmodified row is a no-op.
    if (body.contact_email != null) {
      if (typeof body.contact_email === "string" && body.contact_email !== "" && !isEncrypted(body.contact_email)) {
        body.contact_email = encryptField(body.contact_email);
      }
    }
    if (body.phone != null) {
      if (typeof body.phone === "string" && body.phone !== "" && !isEncrypted(body.phone)) {
        body.phone = encryptField(body.phone);
      }
    }
    if (body.tax_id != null) {
      if (typeof body.tax_id === "string" && body.tax_id !== "" && !isEncrypted(body.tax_id)) {
        body.tax_id_hmac = hmacField(body.tax_id);
        body.tax_id = encryptField(body.tax_id);
      }
    }
    if (body.vat_number != null) {
      if (typeof body.vat_number === "string" && body.vat_number !== "" && !isEncrypted(body.vat_number)) {
        body.vat_number_hmac = hmacField(body.vat_number);
        body.vat_number = encryptField(body.vat_number);
      }
    }
    // Preserve the entity's tenant_id — regular users cannot move it to another tenant
    const updated = await auth.store.upsertPartner({ ...body, id, tenant_id: existing.tenant_id });
    // FIX-ALL-2 / Fix 3 — audit identity for API-key callers (parity with
    // the POST handler's getAuthUser pattern). Session callers pass their
    // full user; API-key callers pass a synthetic identity so the FK shape
    // the audit_logs.user_id column expects is satisfied (NULL id +
    // "api:<name>" username is acceptable per the audit() helper signature).
    const auditUser = "user" in auth ? auth.user : { id: `api:${auth.apiKeyId}`, username: auth.apiKeyName, tenant_id: auth.tenantId };
    await audit(auth.store, auditUser, req, "partner.update", "partner", id, { name: updated.name });
    // Strip portal_token from response (parity with GET / list — audit D-5 / F-9-1).
    // P0-3 / Feature 2: decrypt PII fields + strip the HMAC columns.
    const { portal_token: _omit, tax_id_hmac: _omitTid, vat_number_hmac: _omitVn, ...safeUpdated } = updated as any;
    if (safeUpdated.contact_email && typeof safeUpdated.contact_email === "string") {
      safeUpdated.contact_email = decryptField(safeUpdated.contact_email);
    }
    if (safeUpdated.phone && typeof safeUpdated.phone === "string") {
      safeUpdated.phone = decryptField(safeUpdated.phone);
    }
    if (safeUpdated.tax_id && typeof safeUpdated.tax_id === "string") {
      safeUpdated.tax_id = decryptField(safeUpdated.tax_id);
    }
    if (safeUpdated.vat_number && typeof safeUpdated.vat_number === "string") {
      safeUpdated.vat_number = decryptField(safeUpdated.vat_number);
    }
    // FIX-ALL-2 / Fix 1 — strip KYC / bank / vat / tax from API-key responses.
    const redactedUpdated = redactPartnerFields(safeUpdated as any, auth);
    return NextResponse.json(redactedUpdated);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (partners.delete) — session callers use requirePermission,
  // API-key callers use hasPermission (colon format).
  { const { requirePermission } = await import("@/lib/permissions/can");
    if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "partners.delete"); if (_d) return _d; } }
  if ("apiKeyId" in auth && !hasPermission(auth.permissions, "partners:write")) {
    return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
  }

    const { id } = await params;
    const existing = await auth.store.getPartner(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
    if (!isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    // Dependency check (H-5) — refuse delete if dependent records exist
    // (offers / invoices / proformas / KYC / portal access / trade
    // calculations / demands / deals / shared docs / portal rfqs + the 9
    // marketplace tables — AUDIT2-LOGIC-UX H8). Caller can pass ?force=1 to
    // override (will leave orphans — admin recovery only).
    const sb = (auth.store as any).sb();
    const [
      offers, invoices, proformas, kyc, portal, tradeCalcs, demands, deals, sharedDocs, portalRfqs,
      // AUDIT2-LOGIC-UX H8 — the 9 marketplace tables that reference the
      // partner. Without these, a partner with marketplace activity could
      // be hard-deleted, silently orphaning rows in marketplace_posts,
      // marketplace_responses, marketplace_negotiations, marketplace_contracts,
      // marketplace_auction_bids, marketplace_reviews, marketplace_questions,
      // marketplace_financial_instruments, marketplace_logistics_requests.
      mktPosts, mktResponses, mktNegotiations, mktContracts, mktBids, mktReviews, mktQuestions, mktFinInstruments, mktLogistics,
    ] = await Promise.all([
      sb.from("offers").select("id", { count: "exact", head: true }).eq("partner_id", id),
      sb.from("invoices").select("id", { count: "exact", head: true }).eq("partner_id", id),
      sb.from("proformas").select("id", { count: "exact", head: true }).eq("partner_id", id),
      sb.from("kyc_submissions").select("id", { count: "exact", head: true }).eq("partner_id", id),
      sb.from("portal_access").select("id", { count: "exact", head: true }).eq("partner_id", id),
      sb.from("trade_calculations").select("id", { count: "exact", head: true }).eq("buyer_id", id),
      // FIX-P1: extend dependency check (PT-1) — demands, deals, shared_documents,
      // portal_rfqs all reference the partner.
      sb.from("demands").select("id", { count: "exact", head: true }).eq("partner_id", id),
      sb.from("deals").select("id", { count: "exact", head: true }).eq("partner_id", id),
      sb.from("shared_documents").select("id", { count: "exact", head: true }).eq("partner_id", id),
      sb.from("portal_rfqs").select("id", { count: "exact", head: true }).eq("partner_id", id),
      // Marketplace tables — partner_id references.
      sb.from("marketplace_posts").select("id", { count: "exact", head: true }).eq("partner_id", id),
      sb.from("marketplace_responses").select("id", { count: "exact", head: true }).eq("partner_id", id),
      // marketplace_negotiations stores BOTH partner_id_a AND partner_id_b.
      sb.from("marketplace_negotiations").select("id", { count: "exact", head: true }).or(`partner_id_a.eq.${id},partner_id_b.eq.${id}`),
      sb.from("marketplace_contracts").select("id", { count: "exact", head: true }).eq("partner_id", id),
      sb.from("marketplace_auction_bids").select("id", { count: "exact", head: true }).eq("partner_id", id),
      sb.from("marketplace_reviews").select("id", { count: "exact", head: true }).or(`reviewer_partner_id.eq.${id},reviewed_partner_id.eq.${id}`),
      sb.from("marketplace_questions").select("id", { count: "exact", head: true }).eq("partner_id", id),
      sb.from("marketplace_financial_instruments").select("id", { count: "exact", head: true }).eq("partner_id", id),
      sb.from("marketplace_logistics_requests").select("id", { count: "exact", head: true }).eq("partner_id", id),
    ]);
    const depCount =
      (offers.count || 0) +
      (invoices.count || 0) +
      (proformas.count || 0) +
      (kyc.count || 0) +
      (portal.count || 0) +
      (tradeCalcs.count || 0) +
      (demands.count || 0) +
      (deals.count || 0) +
      (sharedDocs.count || 0) +
      (portalRfqs.count || 0) +
      (mktPosts.count || 0) +
      (mktResponses.count || 0) +
      (mktNegotiations.count || 0) +
      (mktContracts.count || 0) +
      (mktBids.count || 0) +
      (mktReviews.count || 0) +
      (mktQuestions.count || 0) +
      (mktFinInstruments.count || 0) +
      (mktLogistics.count || 0);
    const force = req.nextUrl.searchParams.get("force") === "1";
    if (depCount > 0 && !force) {
      return NextResponse.json({
        error: `Cannot delete partner — ${depCount} dependent record(s) exist.`,
        dependencies: {
          offers: offers.count,
          invoices: invoices.count,
          proformas: proformas.count,
          kyc: kyc.count,
          portal: portal.count,
          trade_calcs: tradeCalcs.count,
          demands: demands.count,
          deals: deals.count,
          shared_documents: sharedDocs.count,
          portal_rfqs: portalRfqs.count,
          marketplace_posts: mktPosts.count,
          marketplace_responses: mktResponses.count,
          marketplace_negotiations: mktNegotiations.count,
          marketplace_contracts: mktContracts.count,
          marketplace_auction_bids: mktBids.count,
          marketplace_reviews: mktReviews.count,
          marketplace_questions: mktQuestions.count,
          marketplace_financial_instruments: mktFinInstruments.count,
          marketplace_logistics_requests: mktLogistics.count,
        },
        hint: "Pass ?force=1 to delete anyway (will leave orphans).",
      }, { status: 409 });
    }

    await auth.store.deletePartner(id);
    const auditUser = "user" in auth ? auth.user : { id: `api:${auth.apiKeyId}`, username: auth.apiKeyName, tenant_id: auth.tenantId };
    await audit(auth.store, auditUser, req, "partner.delete", "partner", id, {
      forced: force,
      dependencies_ignored: force ? depCount : 0,
    });
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
