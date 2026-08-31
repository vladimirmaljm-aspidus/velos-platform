import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId } from "@/lib/api/helpers";
// P0-3 / Feature 2 — field-level encryption. portal_email is encrypted at
// rest with AES-256-GCM (enc: prefix); a deterministic HMAC token
// (portal_email_hmac) is stored alongside for equality search (login,
// duplicate-check). See src/lib/crypto/field-encryption.ts and migration
// 042_field_encryption_hmac.sql.
import { encryptField, decryptField, hmacField, isEncrypted } from "@/lib/crypto/field-encryption";

export const runtime = "nodejs";

// Admin: list portal access for a tenant
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (portal.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "portal.read"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_portal)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_portal", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  if (!auth.isSuperAdmin && auth.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) return NextResponse.json({ items: [], total: 0 });
  const items = await auth.store.listPortalAccess(tenantId);
  // P0-3 / Feature 2: decrypt portal_email for the admin UI so the list
  // renders plaintext emails. Legacy plaintext rows pass through untouched.
  // The HMAC column is internal-only — never returned to the client.
  const safeItems = items.map((p) => {
    const { password_hash, portal_email_hmac, ...safe } = p as any;
    if (safe.portal_email && typeof safe.portal_email === "string") {
      safe.portal_email = decryptField(safe.portal_email);
    }
    return safe;
  });
  return NextResponse.json({ items: safeItems });
}

// Admin: create/update portal access (approve, invite, set tier)
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (portal.create)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "portal.invite"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_portal)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_portal", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  if (!auth.isSuperAdmin && auth.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) return NextResponse.json({ error: "No tenant." }, { status: 400 });
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  body.tenant_id = tenantId;

  // ── P0-3 / Feature 2 — field-level encryption ──────────────────────────
  // Encrypt portal_email at rest (AES-256-GCM, enc: prefix) AND compute a
  // deterministic HMAC token for equality search (login, duplicate-check).
  // The HMAC is keyed with FIELD_HMAC_KEY → FIELD_ENCRYPTION_KEY →
  // SECRET_KEY (see src/lib/crypto/field-encryption.ts). A DB leak alone
  // cannot recover the plaintext email from the HMAC.
  //
  // Idempotent: if body.portal_email is already `enc:...`-prefixed (the
  // caller loaded a row from GET, which decrypted it, and re-submitted
  // without changes), isEncrypted() guards against double-encryption.
  if (body.portal_email && !isEncrypted(body.portal_email)) {
    body.portal_email_hmac = hmacField(body.portal_email);
    body.portal_email = encryptField(body.portal_email);
  }

  // ── AUDIT16 / MEDIUM-5 — partner ownership validation ──────────────────
  // `body.partner_id` was written to the portal_access row WITHOUT checking
  // that the partner belongs to the caller's tenant (the service-role
  // store bypasses RLS). A tenant admin could bind a portal account to a
  // FOREIGN tenant's partner — in the cross-tenant marketplace community
  // (groups/Q&A/reviews) partner_id IS the identity, enabling masquerading.
  if (body.partner_id) {
    const partner = await auth.store.getPartner(body.partner_id);
    if (!partner) {
      return NextResponse.json({ error: "Partner not found." }, { status: 404 });
    }
    if (!auth.isSuperAdmin && partner.tenant_id !== tenantId) {
      return NextResponse.json({ error: "Partner not found." }, { status: 404 });
    }
    // Keep the fetched row for the auto-fill below (avoids a second read).
    (req as any)._partnerRow = partner;
  }

  // ── Fresh-create defaults (id absent) ─────────────────────────────────
  if (!body.id) {
    // Auto-fill portal_email from the partner record if the admin didn't
    // supply one. Portal cannot invite anyone without a working email.
    // NOTE: `partner.email` is the partner's general email (NOT in the
    // P0-3 / Feature 2 encryption set — only `contact_email`, `phone`,
    // and `tax_id` are encrypted at rest on the partners table). So this
    // is read as plaintext directly. If the partner row's email is missing
    // but contact_email is set, fall back to contact_email (which IS
    // encrypted at rest, so decrypt it first).
    if (!body.portal_email && body.partner_id) {
      const partner = ((req as any)._partnerRow as any) || await auth.store.getPartner(body.partner_id);
      if (partner?.email) {
        body.portal_email = partner.email;
      } else if (partner?.contact_email) {
        body.portal_email = decryptField(partner.contact_email);
      }
    }
    if (!body.portal_email) {
      return NextResponse.json({
        error: "Portal email is required. Add an email address to the partner record first, or set portal_email explicitly.",
      }, { status: 400 });
    }
    // Refuse duplicate portal email inside the tenant — this would corrupt
    // login lookups (getPortalAccessByEmail uses .maybeSingle()).
    // P0-3 / Feature 2: getPortalAccessByEmail looks up by HMAC token, so
    // this check works even when portal_email is encrypted at rest.
    const dupeEmail = isEncrypted(body.portal_email)
      ? decryptField(body.portal_email) // the admin's plaintext input, round-tripped
      : body.portal_email;
    const dupe = await auth.store.getPortalAccessByEmail(tenantId, dupeEmail).catch(() => null);
    if (dupe) {
      return NextResponse.json({
        error: `A portal account with email ${dupeEmail} already exists in this tenant.`,
      }, { status: 409 });
    }
    // Compute HMAC + encrypt portal_email if not already done above (the
    // partner.email auto-fill path bypassed the early encrypt block).
    if (!isEncrypted(body.portal_email)) {
      body.portal_email_hmac = hmacField(body.portal_email);
      body.portal_email = encryptField(body.portal_email);
    }
    // Force must_set_password so the invite → setup-password gate stays valid.
    body.must_set_password = true;
    if (body.status === "approved" && !body.approved_by) {
      body.approved_by = auth.user.id;
      body.approved_at = new Date().toISOString();
    }
    // Default status the admin can rely on: "invited" (not "active" — no
    // password yet). The client-facing setup-password flow flips to active.
    if (!body.status) body.status = "invited";
  }
  const created = await auth.store.upsertPortalAccess(body);
  await audit(auth.store, auth.user, req, body.id ? "portal_access.update" : "portal_access.create", "portal_access", created.id, { tier: created.tier, status: created.status });
  // P0-3 / Feature 2: decrypt portal_email for the response so the admin
  // UI shows plaintext, and strip the HMAC column (internal-only).
  const { password_hash: _omit, portal_email_hmac: _omitHmac, ...safeCreated } = created as any;
  if (safeCreated.portal_email && typeof safeCreated.portal_email === "string") {
    safeCreated.portal_email = decryptField(safeCreated.portal_email);
  }
  return NextResponse.json(safeCreated);
}
