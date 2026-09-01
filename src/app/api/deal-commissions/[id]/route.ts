import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * AUDIT19 / F1 — field whitelist for the generic deal-commission PUT.
 *
 * The three action branches (approve / mark_paid / void) each enforce their
 * own H-4 status guard and set the lifecycle columns server-side. But the
 * fallthrough previously spread `...body` raw into `upsertDealCommission`,
 * so a commissions:update caller could:
 *   - PUT {"status":"paid"} and skip the pending→approved→paid SoD flow,
 *   - forge approved_by / approved_at / paid_at / payout_reference,
 *   - overwrite calculated_commission (the money amount).
 *
 * Allow only business-level editable fields. Lifecycle, audit-trail and
 * identity columns are NOT in this list — they are set exclusively by the
 * action branches (which have their own guards) or server-side.
 * `status` is deliberately NOT whitelisted: every status change must go
 * through the action endpoints so the guards and audit trail apply.
 */
const COMMISSION_EDITABLE_FIELDS = new Set([
  "notes",
  // Commission-config inputs (legitimate to correct before approval):
  "commission_type",
  "commission_rate",
  "commission_per_unit",
  "commission_custom_formula",
  "commission_currency",
]);

function whitelistCommissionFields(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (COMMISSION_EDITABLE_FIELDS.has(key)) result[key] = value;
  }
  return result;
}

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

    // AUDIT19 / F1 — generic field-edit fallthrough (whitelist + guards).
    // Non-whitelisted keys (status, approved_*, paid_*, payout_reference,
    // calculated_commission, ids, timestamps) are silently dropped — exactly
    // like the offers/proformas/invoices PUT whitelists. Status changes MUST
    // use the action branches above (they carry the H-4 guards + audit
    // entries). A body that ONLY tried to set a protected field (e.g. a
    // raw {"status":"paid"}) results in an empty whitelist → no-op 409
    // instead of a silent "success".
    const safeBody = whitelistCommissionFields(body as Record<string, unknown>);
    if (Object.keys(body).some((k) => k !== "action" && !COMMISSION_EDITABLE_FIELDS.has(k))) {
      return NextResponse.json(
        {
          error:
            "Field(s) not editable via generic PUT (use the approve / mark_paid / void actions for lifecycle changes). " +
            `Editable: ${[...COMMISSION_EDITABLE_FIELDS].join(", ")}.`,
        },
        { status: 409 },
      );
    }
    // Once a commission is approved, its config is frozen: the amount was
    // vetted in the approval step. Editing rate/type after approval would
    // silently desync the vetted calculated_commission.
    const nonPendingEdit =
      existing.status !== "pending" &&
      Object.keys(safeBody).some((k) => k !== "notes");
    if (nonPendingEdit && !auth.isSuperAdmin) {
      return NextResponse.json(
        { error: `Commission config is frozen in status '${existing.status}' (only notes remain editable).` },
        { status: 409 },
      );
    }
    const updated = await auth.store.upsertDealCommission({
      ...safeBody,
      id,
      tenant_id: existing.tenant_id,
    });
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
