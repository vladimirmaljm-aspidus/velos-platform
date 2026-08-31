import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(_req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (commissions.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "commissions.read"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    const { id } = await params;
    const item = await auth.store.getDealCommission(id);
    if (!item) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && item.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return NextResponse.json(item);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error)}, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (commissions.update)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "commissions.update"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    const { id } = await params;
    const existing = await auth.store.getDealCommission(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const body = await req.json();

    // Handle approve action
    if (body.action === "approve") {
      // Status guard (H-4) — only pending commissions can be approved.
      // Prevents re-approving a paid/cancelled/voided commission.
      if (existing.status !== "pending") {
        return NextResponse.json(
          { error: `Cannot approve commission in status '${existing.status}'.` },
          { status: 409 },
        );
      }
      const updated = await auth.store.approveDealCommission(id, auth.user.id);
      await audit(auth.store, auth.user, req, "deal_commission.approve", "deal_commission", id);
      return NextResponse.json(updated);
    }

    // Handle mark as paid action
    if (body.action === "mark_paid") {
      // Status guard (H-4) — only approved commissions can be marked paid.
      // Prevents paying a pending commission directly (skips approval) or
      // resurrecting a cancelled commission.
      if (existing.status !== "approved") {
        return NextResponse.json(
          { error: `Cannot mark commission paid from status '${existing.status}'. Approve first.` },
          { status: 409 },
        );
      }
      const updated = await auth.store.markDealCommissionPaid(id, body.payout_reference);
      await audit(auth.store, auth.user, req, "deal_commission.mark_paid", "deal_commission", id);
      return NextResponse.json(updated);
    }

    // Handle void action
    if (body.action === "void") {
      // Status guard (H-4) — only commissions NOT already cancelled can be
      // voided. Idempotency: a second void call on an already-cancelled
      // commission is a no-op and returns 409.
      if (existing.status === "cancelled") {
        return NextResponse.json(
          { error: `Commission is already cancelled.` },
          { status: 409 },
        );
      }
      const updated = await auth.store.upsertDealCommission({
        id,
        tenant_id: existing.tenant_id,
        status: "cancelled",
        notes: body.reason ? `Voided: ${body.reason}` : "Voided by admin.",
      } as any);
      await audit(auth.store, auth.user, req, "deal_commission.void", "deal_commission", id, { reason: body.reason });
      return NextResponse.json(updated);
    }

    const updated = await auth.store.upsertDealCommission({ ...body, id, tenant_id: existing.tenant_id });
    await audit(auth.store, auth.user, req, "deal_commission.update", "deal_commission", id);
    return NextResponse.json(updated);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error)}, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (commissions.delete)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "commissions.delete"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    const { id } = await params;
    const existing = await auth.store.getDealCommission(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await auth.store.deleteDealCommission(id);
    await audit(auth.store, auth.user, req, "deal_commission.delete", "deal_commission", id);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error)}, { status: 500 });
  }
}
