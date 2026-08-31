import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getStore } from "@/lib/data/store";
import { audit } from "@/lib/api/helpers";
// FIX-AUDIT4-SEC / Fix 6 + Fix 7 — field-level encryption on the portal
// profile write path, and strip + decrypt on the read path. Mirrors the
// pattern already in /api/partners/[id] (admin side). Without this,
// a portal client editing their own profile caused the platform to
// store contact_email / contact_phone / phone in PLAINTEXT (the admin
// partners POST path was encrypting these, but the portal's PUT was
// bypassing it). The GET handler was also leaking `portal_token` (a
// legacy 32-char secret on the partner row) and returning the
// encrypted `enc:` blobs instead of decrypting them for display.
import { encryptField, decryptField, isEncrypted } from "@/lib/crypto/field-encryption";

export const runtime = "nodejs";

// Portal: get + update own profile
export async function GET() {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  if (!access.can_view_profile) {
    return NextResponse.json({ error: "Not permitted." }, { status: 403 });
  }
  const store = await getStore();
  const partner = await store.getPartner(access.partner_id);
  // FIX-AUDIT4-SEC / Fix 7 — strip the legacy `portal_token` secret AND
  // the internal HMAC search-token columns (mirror partners/[id] GET).
  // Then decrypt the encrypted PII fields (contact_email, phone, tax_id,
  // vat_number) so the portal client sees their own plaintext info.
  // (Mirrors the admin partners/[id] GET handler, lines 55-67.)
  const { portal_token: _omit, tax_id_hmac, vat_number_hmac, ...safePartner } = partner as any;
  if (safePartner.contact_email && typeof safePartner.contact_email === "string") {
    safePartner.contact_email = decryptField(safePartner.contact_email);
  }
  if (safePartner.phone && typeof safePartner.phone === "string") {
    safePartner.phone = decryptField(safePartner.phone);
  }
  // AUDIT16 — contact_phone: this route's own PUT ENCRYPTS it, but the GET
  // never decrypted it — after a client saved their profile, the portal
  // profile page itself rendered the enc: blob back to them.
  if (safePartner.contact_phone && typeof safePartner.contact_phone === "string") {
    safePartner.contact_phone = decryptField(safePartner.contact_phone);
  }
  if (safePartner.tax_id && typeof safePartner.tax_id === "string") {
    safePartner.tax_id = decryptField(safePartner.tax_id);
  }
  if (safePartner.vat_number && typeof safePartner.vat_number === "string") {
    safePartner.vat_number = decryptField(safePartner.vat_number);
  }
  return NextResponse.json({ partner: safePartner, access: { ...access, password_hash: undefined } });
}

export async function PUT(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  if (!access.can_view_profile) {
    return NextResponse.json({ error: "Profile editing not permitted." }, { status: 403 });
  }
  const store = await getStore();
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  // Partner can only update limited fields (contact info)
  //
  // FIX-AUDIT4-SEC / Fix 6 — encrypt the PII fields BEFORE upsert, mirroring
  // the admin partners POST handler (lines 376-397 of partners/route.ts).
  // `encryptField` is idempotent on already-encrypted values (enc: prefix
  // is left untouched) so a re-save of a loaded-but-unmodified row is a
  // no-op. Empty strings are passed through (no degenerate `enc::::`
  // values written for admins who cleared the field).
  const maybeEncrypt = (v: unknown): string | undefined => {
    if (v == null) return undefined;
    if (typeof v !== "string") return String(v);
    if (v === "") return "";
    if (isEncrypted(v)) return v; // already encrypted — idempotent
    return encryptField(v);
  };
  const allowed: Record<string, unknown> = {
    id: access.partner_id,
    contact_name: body.contact_name,
  };
  if (body.contact_email != null) allowed.contact_email = maybeEncrypt(body.contact_email);
  if (body.contact_phone != null) allowed.contact_phone = maybeEncrypt(body.contact_phone);
  if (body.phone != null) allowed.phone = maybeEncrypt(body.phone);

  const updated = await store.upsertPartner(allowed);

  // Audit the profile update
  try {
    await audit(
      store,
      { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
      req,
      "portal.profile_update",
      "portal_access",
      access.id,
      { fields: Object.keys(body || {}) },
    );
  } catch (e) { console.error("[audit]", e); }

  // Strip + decrypt on the response too (parity with the GET handler —
  // the partner row returned by upsertPartner carries the encrypted
  // `enc:` blobs and the internal HMAC columns).
  const { portal_token: _omit, tax_id_hmac, vat_number_hmac, ...safeUpdated } = updated as any;
  if (safeUpdated.contact_email && typeof safeUpdated.contact_email === "string") {
    safeUpdated.contact_email = decryptField(safeUpdated.contact_email);
  }
  if (safeUpdated.contact_phone && typeof safeUpdated.contact_phone === "string") {
    safeUpdated.contact_phone = decryptField(safeUpdated.contact_phone);
  }
  if (safeUpdated.phone && typeof safeUpdated.phone === "string") {
    safeUpdated.phone = decryptField(safeUpdated.phone);
  }
  return NextResponse.json(safeUpdated);
}
