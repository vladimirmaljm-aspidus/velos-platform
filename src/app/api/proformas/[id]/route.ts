import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";
import { validateStatusTransition } from "@/lib/api/status-validator";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(_req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (proformas.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "proformas.read"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    const { id } = await params;
    const item = await auth.store.getProforma(id);
    if (!item) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && item.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return NextResponse.json(item);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (proformas.update)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "proformas.update"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    const { id } = await params;
    const existing = await auth.store.getProforma(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const body = await req.json();
    // CRITICAL FIX (audit F-2): lock financial fields on paid/accepted proformas.
    // A user with proformas.update permission should NOT be able to change total,
    // items, partner_id, or currency on a proforma that's already been accepted
    // by the customer or paid — that would silently rewrite a binding commercial
    // commitment and could diverge from the originating offer/invoice.
    if (existing.status === "paid" || existing.status === "accepted") {
      if (!auth.isSuperAdmin) {
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
    if (body.status && body.status !== existing.status && !auth.isSuperAdmin) {
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
    try {
      const { recordRevision } = await import("@/lib/api/doc-revisions");
      await recordRevision({
        docType: "proforma", documentId: id, tenantId: existing.tenant_id,
        before: existing as any, after: updated as any,
        userId: auth.user.id, username: auth.user.username,
        changeNote: (body as any)?._changeNote || null,
      });
    } catch (e) { console.warn("[proforma.update] revision failed:", e); }
    await audit(auth.store, auth.user, req, "proforma.update", "proforma", id, { status: updated.status });
    return NextResponse.json(updated);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (proformas.delete)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "proformas.delete"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    const { id } = await params;
    const existing = await auth.store.getProforma(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
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
    await audit(auth.store, auth.user, req, "proforma.delete", "proforma", id);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
