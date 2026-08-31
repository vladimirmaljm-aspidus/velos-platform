import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { encryptField, hmacField, isEncrypted, decryptField } from "@/lib/crypto/field-encryption";

export const runtime = "nodejs";

/**
 * PUT /api/portal-access/[id]/permissions
 *
 * Admin updates portal access permissions for a client.
 * Body: {
 *   can_view_offers, can_view_documents, can_view_catalog,
 *   can_view_invoices, can_view_profile, can_view_company_info,
 *   can_submit_rfq, can_download_pdf,
 *   exempt_kyc, exempt_document_upload, exempt_location_share,
 *   tier, status
 * }
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (portal.update)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "portal.manage"); if (_d) return _d; } /* requirePermission wired */
    // Feature gate (module_portal)
    { const { requireFeature } = await import("@/lib/api/feature-guard");
      const _f = await requireFeature(auth.tenantId, "module_portal", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    if (!auth.isSuperAdmin && auth.user.role !== "admin") {
      return NextResponse.json({ error: "Admin access required." }, { status: 403 });
    }

    const { id } = await params;
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    // Whitelist permission fields
    // AUDIT16: portal_email was written RAW here (no encryptField, no
    // hmacField) — a plaintext PII write that bypasses at-rest encryption,
    // and worse it left the row's OLD portal_email_hmac STALE: the OLD
    // email kept matching the login lookup while the new one didn't. It
    // is now removed from the raw whitelist and handled explicitly below
    // with encrypt + hmac (parity with the change-email route). Use
    // /api/portal-access/[id]/change-email for a proper change (it also
    // notifies the client).
    const allowedFields = [
      "can_view_offers", "can_view_documents", "can_view_catalog",
      "can_view_invoices", "can_view_profile", "can_view_company_info",
      "can_submit_rfqs", "can_submit_rfq", "can_download_pdf",
      "exempt_kyc", "exempt_document_upload", "exempt_location_share",
      "tier", "status", "portal_level",
    ];

    const update: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        update[field] = body[field];
      }
    }

    // AUDIT16 — explicit, encrypted portal_email handling (see comment
    // above). Idempotent for already-encrypted values.
    let emailChanged = false;
    let emailRoundTrip = false;
    if (typeof body.portal_email === "string" && body.portal_email.trim() !== "") {
      const newEmail = body.portal_email.trim();
      if (!isEncrypted(newEmail)) {
        update.portal_email = encryptField(newEmail);
        update.portal_email_hmac = hmacField(newEmail);
        emailChanged = true;
      } else {
        // Already-encrypted blob passed back unchanged — no-op (the admin
        // UI round-trips the encrypted value it loaded). Do NOT treat the
        // request as empty: other clients send portal_email alone.
        emailRoundTrip = true;
      }
    }

    if (Object.keys(update).length === 0 && !emailRoundTrip) {
      return NextResponse.json({ error: "No valid fields to update." }, { status: 400 });
    }

    try {
      // Tenant ownership check
      const existing = await auth.store.getPortalAccessById(id);
      if (!existing) return NextResponse.json({ error: "Portal access not found." }, { status: 404 });
      if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
        return NextResponse.json({ error: "Portal access not found." }, { status: 404 });
      }
      const updated = await auth.store.upsertPortalAccess({ id, ...update });
      // Audit rows must never carry ciphertext or HMAC tokens (audit15/16
      // pattern) — log the action, not the encrypted blob.
      const { portal_email: _pe, portal_email_hmac: _ph, ...auditDetails } = update;
      await audit(auth.store, auth.user, req, "portal_access.permissions_update", "portal_access", id, {
        ...auditDetails,
        ...(emailChanged ? { portal_email_updated: true } : {}),
      });

      // AUDIT16 — response hygiene: decrypt the email for the admin UI and
      // NEVER leak the internal portal_email_hmac search token (parity with
      // the GET route / portal-access POST).
      const { portal_email_hmac: _leak, password_hash: _pw, ...safe } = updated as any;
      return NextResponse.json({
        ...safe,
        ...(updated.portal_email ? { portal_email: decryptField(updated.portal_email) } : {}),
      });
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
  } catch (e: any) {
    console.error("[portal-access.permissions.PUT]", e);
    return NextResponse.json({ error: sanitizeError(e)}, { status: 500 });
  }
}
