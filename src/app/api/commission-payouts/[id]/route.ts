import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";
import { assertNoSoDViolation } from "@/lib/permissions/sod-matrix";

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
    const item = await auth.store.getCommissionPayout(id);
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
  // Permission gate (commissions.update)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "commissions.update"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    const { id } = await params;
    const existing = await auth.store.getCommissionPayout(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const body = await req.json();

    // ── P1-1 / Feature 2: Separation-of-Duties check ─────────────────
    // Transitioning a payout to "completed" is the approval step
    // (it triggers the cascade that marks linked commissions as
    // "paid" — that's the binding financial commitment). The creator
    // (`existing.created_by`) cannot approve their own payout unless
    // they are a super_admin. `assertNoSoDViolation` short-circuits
    // for super_admin before consulting the SoD rules.
    if (body.status === "completed" && existing.status !== "completed") {
      const sod = await assertNoSoDViolation(auth, (existing as any).created_by, {
        create_perm: "commissions.payout",
        approve_perm: "commissions.update",
      });
      if (sod) return sod;
    }

    // ── Audit F-6/P1-7: validate commissions are approved before marking
    //    a payout as completed ───────────────────────────────────────────
    // Without this check, an admin could mark a payout "completed" for a
    // batch that includes pending / cancelled commissions — bypassing the
    // approval workflow. `markDealCommissionPaid` would then flip those
    // commissions straight to "paid", skipping "approved". We check
    // BEFORE the upsert so the payout row itself is never persisted in
    // a "completed" state for an unapproved batch.
    if (body.status === "completed" && existing.status !== "completed") {
      const commissionIds = Array.isArray(body.commission_ids) && body.commission_ids.length > 0
        ? body.commission_ids
        : (Array.isArray(existing.commission_ids) ? existing.commission_ids : []);
      if (commissionIds.length > 0) {
        const unapproved: { id: string; status: string }[] = [];
        for (const commissionId of commissionIds) {
          const commission = await auth.store.getDealCommission(commissionId);
          if (!commission) {
            // Orphan reference — can't pay a commission that no longer exists.
            unapproved.push({ id: commissionId, status: "missing" });
          } else if (!auth.isSuperAdmin && commission.tenant_id !== auth.tenantId) {
            // Defense-in-depth — should never happen (the payout row is
            // already tenant-checked above), but a malicious body could
            // inject commission_ids belonging to another tenant.
            return NextResponse.json({ error: "Commission does not belong to tenant." }, { status: 403 });
          } else if (commission.status !== "approved") {
            unapproved.push({ id: commissionId, status: commission.status });
          }
        }
        if (unapproved.length > 0) {
          return NextResponse.json(
            {
              error: `${unapproved.length} commission(s) are not yet approved. Only "approved" commissions can be paid out.`,
              unapproved,
            },
            { status: 400 }
          );
        }
      }
    }

    const updated = await auth.store.upsertCommissionPayout({ ...body, id, tenant_id: existing.tenant_id });
    // FIX-P1-LOGIC Fix 3: cascade payout completion → mark all linked
    // DealCommissions as paid. Only fires on a real transition INTO
    // "completed" — re-saving an already-completed payout is a no-op so we
    // don't clobber paid_at on idempotent retries.
    if (body.status === "completed" && existing.status !== "completed") {
      if (Array.isArray(updated.commission_ids) && updated.commission_ids.length > 0) {
        for (const commissionId of updated.commission_ids) {
          try {
            await auth.store.markDealCommissionPaid(
              commissionId,
              updated.payment_reference || undefined,
            );
          } catch (e) {
            console.warn(`[commission_payout.update] markDealCommissionPaid failed for ${commissionId}:`, e);
          }
        }
      }
    }
    await audit(auth.store, auth.user, req, "commission_payout.update", "commission_payout", id);
    return NextResponse.json(updated);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
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
    const existing = await auth.store.getCommissionPayout(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await auth.store.deleteCommissionPayout(id);
    await audit(auth.store, auth.user, req, "commission_payout.delete", "commission_payout", id);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
