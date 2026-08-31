import { NextRequest, NextResponse } from "next/server";
// FIX-ALL-2 / Fix 3 — accept API-key auth on [id] routes so an API-key
// caller fetching /api/proformas/<non-existent-id> gets 404 (not 401).
import { requireAuthOrApiKey, hasPermission, audit, sanitizeError } from "@/lib/api/helpers";
import { validateStatusTransition } from "@/lib/api/status-validator";
// FIX-PRODUCTS-DOCS / Fix 2 — XSS prevention on free-text fields (parity
// with offers PUT) + mass-assignment whitelist mirroring whitelistInvoiceFields.
import { sanitizeFields } from "@/lib/security/sanitize-input";

export const runtime = "nodejs";

/**
 * SEC-M10 mirror for proformas PUT (FIX-PRODUCTS-DOCS / Fix 2).
 *
 * The previous PUT handler spread `...body` raw into `upsertProforma`,
 * so a proformas:write caller could forge audit-trail + lifecycle
 * columns (sent_at, responded_at, paid_at, client_signature,
 * counter_offers, pdf_file_url, approved_by, approved_at, verified_at,
 * verified_by, created_by, created_at) by sending them in the PUT
 * body. The "locked fields" check (line ~70) only triggers when
 * status === "paid"/"accepted", so for other statuses there was NO
 * column-shape guard at all.
 *
 * Allow only the business-level editable fields. Audit-trail + lifecycle
 * timestamp columns are intentionally NOT in this list — they are set
 * exclusively by their dedicated endpoints (send, respond, record-
 * payment, etc.).
 *
 * NOTE: `status` is in the allow list because the route still runs
 * `validateStatusTransition` on it (line ~86) before the upsert — the
 * whitelist is a column-shape filter, NOT a value validator.
 *
 * NOTE: `_changeNote` is intentionally NOT in the allow list (it is a
 * per-request meta field used by `recordRevision`, not a DB column).
 * The route captures it into a local var BEFORE the whitelist runs.
 */
function whitelistProformaFields(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = new Set([
    "subject",
    "partner_id",
    "offer_id",
    "items",
    "currency",
    "status",
    "due_date",
    "notes",
    "terms",
    "payment_terms",
    "valid_until",
    "bank_details",
    "proforma_no",
    "owner_id",
    "subtotal",
    "discount_total",
    "tax_total",
    "total",
  ]);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (allowed.has(key)) result[key] = value;
  }
  return result;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthOrApiKey(_req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (proformas.read) — session callers use requirePermission,
    // API-key callers use hasPermission (colon format).
    { const { requirePermission } = await import("@/lib/permissions/can");
      if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "proformas.read"); if (_d) return _d; } }
    if ("apiKeyId" in auth && !hasPermission(auth.permissions, "proformas:read")) {
      return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
    }
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_finance", _isSA); if (_f) return _f; } /* requireFeature wired */

    const { id } = await params;
    const item = await auth.store.getProforma(id);
    // FIX-ALL-2 / Fix 3 — not-found returns 404, not 401.
    if (!item) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
    if (!isSuperAdmin && item.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return NextResponse.json(item);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (proformas.update) — session callers use requirePermission,
  // API-key callers use hasPermission (colon format).
  { const { requirePermission } = await import("@/lib/permissions/can");
    if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "proformas.update"); if (_d) return _d; } }
  if ("apiKeyId" in auth && !hasPermission(auth.permissions, "proformas:write")) {
    return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
  }
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_finance", _isSA); if (_f) return _f; } /* requireFeature wired */

    const { id } = await params;
    const existing = await auth.store.getProforma(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
    if (!isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const body = await req.json();
    // FIX-PRODUCTS-DOCS / Fix 6 — ISO 4217 currency validation (PUT). A
    // direct API caller could set body.currency to any string; reject
    // unknown codes before we mutate the proforma. Skip when currency
    // is absent (the route preserves the existing value).
    if (body.currency !== undefined && body.currency !== null && body.currency !== "") {
      const { CURRENCY_CODES } = await import("@/lib/data/reference");
      if (!CURRENCY_CODES.includes(body.currency)) {
        return NextResponse.json(
          { error: `Invalid currency code: ${body.currency}. Must be one of: ${CURRENCY_CODES.join(", ")}.` },
          { status: 400 },
        );
      }
    }
    // FIX-PRODUCTS-DOCS / Fix 2 — XSS prevention on free-text fields
    // (parity with offers PUT). Proforma PDFs render subject/notes/terms
    // via dangerouslySetInnerHTML, so escape <, >, ", ' here.
    const sanitizedBody = sanitizeFields(body, [
      "subject", "notes", "terms", "payment_terms", "bank_details",
    ]);
    if (Array.isArray(sanitizedBody.items)) {
      sanitizedBody.items = sanitizedBody.items.map((it: any) => sanitizeFields(it, [
        "description", "detailed_spec", "brand", "sku", "hs_code",
        "origin_country", "notes", "subject", "unit",
      ]));
    }
    // CRITICAL FIX (audit F-2): lock financial fields on paid/accepted proformas.
    // A user with proformas.update permission should NOT be able to change total,
    // items, partner_id, or currency on a proforma that's already been accepted
    // by the customer or paid — that would silently rewrite a binding commercial
    // commitment and could diverge from the originating offer/invoice.
    if (existing.status === "paid" || existing.status === "accepted") {
      if (!isSuperAdmin) {
        const lockedFields = ["total", "subtotal", "items", "tax_total", "discount_total", "partner_id", "currency", "offer_id"];
        for (const k of lockedFields) {
          if (k in sanitizedBody) {
            return NextResponse.json(
              { error: `Cannot modify ${k} on a ${existing.status} proforma. Super-admin override required.` },
              { status: 409 },
            );
          }
        }
      }
    }
    // FIX-P1-LOGIC Fix 1: enforce valid status transitions. Super-admins
    // bypass so they can correct bad data.
    if (sanitizedBody.status && sanitizedBody.status !== existing.status && !isSuperAdmin) {
      const transition = validateStatusTransition("proforma", existing.status, sanitizedBody.status);
      if (!transition.valid) {
        return NextResponse.json({ error: transition.error }, { status: 400 });
      }
    }
    // FIX-P1-LOGIC Fix 5: recompute totals from line items — never trust
    // client-supplied totals (parity with offers PUT). Always overwrite.
    if (Array.isArray(sanitizedBody.items) && sanitizedBody.items.length > 0) {
      let subtotal = 0, discountTotal = 0, taxTotal = 0;
      // AUDIT17 / F2 — range-validate percentage fields before recomputing
      // (PUT routes previously had NO line validation: a 150% discount or
      // negative tax_rate flowed straight into the stored totals).
      for (let i = 0; i < sanitizedBody.items.length; i++) {
        const it = sanitizedBody.items[i];
        const disc = Number(it.discount);
        if (Number.isFinite(disc) && (disc < 0 || disc > 100)) {
          return NextResponse.json(
            { error: `items[${i}].discount must be between 0 and 100.` },
            { status: 400 },
          );
        }
        const tr = Number(it.tax_rate);
        if (Number.isFinite(tr) && (tr < 0 || tr > 100)) {
          return NextResponse.json(
            { error: `items[${i}].tax_rate must be between 0 and 100.` },
            { status: 400 },
          );
        }
      }
      for (const it of sanitizedBody.items) {
        const line = (Number(it.quantity) || 0) * (Number(it.unit_price) || 0);
        const disc = line * (Number(it.discount) || 0) / 100;
        const net = line - disc;
        const tax = net * (Number(it.tax_rate) || 0) / 100;
        // AUDIT17 / F1 — round each line component to 2dp BEFORE aggregating
        // (header sums the rounded values; see invoices route rationale).
        const rLine = Math.round(line * 100) / 100;
        const rDisc = Math.round(disc * 100) / 100;
        const rTax = Math.round(tax * 100) / 100;
        const rNet = Math.round(net * 100) / 100;
        subtotal += rLine;
        discountTotal += rDisc;
        taxTotal += rTax;
        it.total = Math.round((rNet + rTax) * 100) / 100;
      }
      sanitizedBody.subtotal = Math.round(subtotal * 100) / 100;
      sanitizedBody.discount_total = Math.round(discountTotal * 100) / 100;
      sanitizedBody.tax_total = Math.round(taxTotal * 100) / 100;
      sanitizedBody.total = Math.round((subtotal - discountTotal + taxTotal) * 100) / 100;
    }
    // SEC-M10 mirror (FIX-PRODUCTS-DOCS / Fix 2) — apply the field
    // whitelist AFTER the totals recompute (which writes back
    // subtotal/discount_total/tax_total/total — all in the allow list)
    // and BEFORE the upsert. Strips client-supplied values for
    // audit-trail + lifecycle columns (sent_at, paid_at, client_signature,
    // counter_offers, pdf_file_url, approved_by, approved_at, verified_at,
    // verified_by, created_by, created_at) so a proformas:write caller
    // cannot forge the audit-trail by sending those keys in the PUT body.
    // Capture the per-request `_changeNote` meta field BEFORE the
    // whitelist strips it — it's not a DB column, it's a transient note
    // attached to the audit-trail revision record below.
    const changeNote = (sanitizedBody as any)?._changeNote || null;
    const safeBody = whitelistProformaFields(sanitizedBody as Record<string, unknown>);
    const updated = await auth.store.upsertProforma({ ...safeBody, id, tenant_id: existing.tenant_id } as any);
    const auditUser = "user" in auth ? auth.user : { id: `api:${auth.apiKeyId}`, username: auth.apiKeyName, tenant_id: auth.tenantId };
    try {
      const { recordRevision } = await import("@/lib/api/doc-revisions");
      await recordRevision({
        docType: "proforma", documentId: id, tenantId: existing.tenant_id,
        before: existing as any, after: updated as any,
        userId: auditUser.id, username: auditUser.username,
        changeNote,
      });
    } catch (e) { console.warn("[proforma.update] revision failed:", e); }
    await audit(auth.store, auditUser, req, "proforma.update", "proforma", id, { status: updated.status });
    return NextResponse.json(updated);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (proformas.delete) — session callers use requirePermission,
  // API-key callers use hasPermission (colon format).
  { const { requirePermission } = await import("@/lib/permissions/can");
    if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "proformas.delete"); if (_d) return _d; } }
  if ("apiKeyId" in auth && !hasPermission(auth.permissions, "proformas:write")) {
    return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
  }
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_finance", _isSA); if (_f) return _f; } /* requireFeature wired */

    const { id } = await params;
    const existing = await auth.store.getProforma(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
    if (!isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    // Status guard (H-6) — only draft/cancelled proformas can be
    // hard-deleted. Sent/accepted/paid proformas carry an audit trail.
    if (existing.status && !["draft", "cancelled"].includes(existing.status)) {
      return NextResponse.json(
        { error: `Cannot delete a record in status '${existing.status}'.` },
        { status: 409 },
      );
    }
    await auth.store.deleteProforma(id);
    const auditUser = "user" in auth ? auth.user : { id: `api:${auth.apiKeyId}`, username: auth.apiKeyName, tenant_id: auth.tenantId };
    await audit(auth.store, auditUser, req, "proforma.delete", "proforma", id);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
