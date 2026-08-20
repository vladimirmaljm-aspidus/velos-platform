import { NextRequest, NextResponse } from "next/server";
// FIX-ALL-2 / Fix 3 — accept API-key auth on [id] routes so an API-key
// caller fetching /api/proformas/<non-existent-id> gets 404 (not 401).
import { requireAuthOrApiKey, hasPermission, audit, sanitizeError } from "@/lib/api/helpers";
import { validateStatusTransition } from "@/lib/api/status-validator";

export const runtime = "nodejs";

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
    // CRITICAL FIX (audit F-2): lock financial fields on paid/accepted proformas.
    // A user with proformas.update permission should NOT be able to change total,
    // items, partner_id, or currency on a proforma that's already been accepted
    // by the customer or paid — that would silently rewrite a binding commercial
    // commitment and could diverge from the originating offer/invoice.
    if (existing.status === "paid" || existing.status === "accepted") {
      if (!isSuperAdmin) {
        const lockedFields = ["total", "subtotal", "items", "tax_total", "discount_total", "partner_id", "currency", "offer_id"];
        for (const k of lockedFields) {
          if (k in body) {
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
    if (body.status && body.status !== existing.status && !isSuperAdmin) {
      const transition = validateStatusTransition("proforma", existing.status, body.status);
      if (!transition.valid) {
        return NextResponse.json({ error: transition.error }, { status: 400 });
      }
    }
    // FIX-P1-LOGIC Fix 5: recompute totals from line items — never trust
    // client-supplied totals (parity with offers PUT). Always overwrite.
    if (Array.isArray(body.items) && body.items.length > 0) {
      let subtotal = 0, discountTotal = 0, taxTotal = 0;
      for (const it of body.items) {
        const line = (Number(it.quantity) || 0) * (Number(it.unit_price) || 0);
        const disc = line * (Number(it.discount) || 0) / 100;
        const net = line - disc;
        const tax = net * (Number(it.tax_rate) || 0) / 100;
        subtotal += line;
        discountTotal += disc;
        taxTotal += tax;
        it.total = Math.round((net + tax) * 100) / 100;
      }
      body.subtotal = Math.round(subtotal * 100) / 100;
      body.discount_total = Math.round(discountTotal * 100) / 100;
      body.tax_total = Math.round(taxTotal * 100) / 100;
      body.total = Math.round((subtotal - discountTotal + taxTotal) * 100) / 100;
    }
    const updated = await auth.store.upsertProforma({ ...body, id, tenant_id: existing.tenant_id });
    const auditUser = "user" in auth ? auth.user : { id: `api:${auth.apiKeyId}`, username: auth.apiKeyName, tenant_id: auth.tenantId };
    try {
      const { recordRevision } = await import("@/lib/api/doc-revisions");
      await recordRevision({
        docType: "proforma", documentId: id, tenantId: existing.tenant_id,
        before: existing as any, after: updated as any,
        userId: auditUser.id, username: auditUser.username,
        changeNote: (body as any)?._changeNote || null,
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
