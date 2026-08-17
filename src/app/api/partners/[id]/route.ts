import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
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
    const auth = await requireAuth(_req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (partners.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "partners.read"); if (_d) return _d; } /* requirePermission wired */

    const { id } = await params;
    const partner = await auth.store.getPartner(id);
    if (!partner) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && partner.tenant_id !== auth.tenantId) {
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
    return NextResponse.json(safePartner);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (partners.update)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "partners.update"); if (_d) return _d; } /* requirePermission wired */

    const { id } = await params;
    // Tenant ownership check: fetch existing first
    const existing = await auth.store.getPartner(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const body = await req.json();
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
    await audit(auth.store, auth.user, req, "partner.update", "partner", id, { name: updated.name });
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
    return NextResponse.json(safeUpdated);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (partners.delete)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "partners.delete"); if (_d) return _d; } /* requirePermission wired */

    const { id } = await params;
    const existing = await auth.store.getPartner(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    // Dependency check (H-5) — refuse delete if dependent records exist
    // (offers / invoices / proformas / KYC / portal access / trade
    // calculations). Caller can pass ?force=1 to override (will leave
    // orphans — admin recovery only).
    const sb = (auth.store as any).sb();
    const [offers, invoices, proformas, kyc, portal, tradeCalcs, demands, deals, sharedDocs, portalRfqs] = await Promise.all([
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
      (portalRfqs.count || 0);
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
        },
        hint: "Pass ?force=1 to delete anyway (will leave orphans).",
      }, { status: 409 });
    }

    await auth.store.deletePartner(id);
    await audit(auth.store, auth.user, req, "partner.delete", "partner", id, {
      forced: force,
      dependencies_ignored: force ? depCount : 0,
    });
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
