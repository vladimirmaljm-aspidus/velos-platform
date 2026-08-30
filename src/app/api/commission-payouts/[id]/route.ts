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
    // approval workflow. The mark_commission_payout_paid RPC below also
    // filters status='approved' as defense-in-depth, but we reject at the
    // route layer first so the caller gets a clear 400 error.
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

    // ── ATOMIC PAYOUT COMPLETION (audit 2d2-F3 + 2d2-F20) ───────────────
    // Previously the PUT did `upsertCommissionPayout({status:"completed"})`
    // followed by a JS for-loop calling `markDealCommissionPaid` per
    // commission_id, each in its own try/catch. If the Nth call failed,
    // the loop continued silently — final state: payout.status="completed"
    // but commissions #1..#N-1="paid", #N="approved", #N+1..M="paid".
    // The user saw "completed" in the UI while commissions were in
    // inconsistent states (2d2-F3). The same loop pattern in
    // markCommissionsEarnedOnInvoicePaid (commission-cascade.ts) is closed
    // by migration 071's record_invoice_payment RPC (F20).
    //
    // Now we delegate the completion to the `mark_commission_payout_paid`
    // SECURITY DEFINER RPC (migration 072), which performs the payout
    // UPDATE + the bulk deal_commissions UPDATE inside ONE Postgres
    // transaction. The bulk UPDATE is a single statement — atomic, no
    // loop. The RPC raises on any error → no partial completion.
    //
    // For non-completion PUTs (status="pending" / status unchanged /
    // other fields), we fall through to the regular upsert path.
    if (body.status === "completed" && existing.status !== "completed") {
      // Try the atomic RPC. Fall back to the legacy non-atomic loop if
      // the migration 072 RPC is not yet applied.
      type RpcResult = {
        payout_id?: string;
        status?: string;
        commission_count?: number;
        already_paid_count?: number;
        total_count?: number;
        idempotent_replay?: boolean;
      };
      let rpcResult: RpcResult | null = null;
      let rpcError: string | null = null;
      try {
        const { getSupabase } = await import("@/lib/supabase/client");
        const sb = getSupabase();
        const { data, error } = await sb.rpc("mark_commission_payout_paid", {
          p_payout_id: id,
          p_tenant_id: existing.tenant_id,
          p_payment_reference: body.payment_reference || null,
        });
        if (error) {
          rpcError = error.message || String(error);
        } else {
          rpcResult = (data ?? null) as RpcResult | null;
        }
      } catch (e: any) {
        rpcError = e?.message || String(e);
      }

      if (rpcError && /could not find|does not exist|function/i.test(rpcError) && rpcResult === null) {
        // Migration 072 not applied — fall back to the legacy non-atomic
        // path. A warning is logged so ops notice the atomicity guarantee
        // is degraded. The legacy path retains the 2d2-F3 bug.
        console.warn(
          "[commission_payout.update] mark_commission_payout_paid RPC not available — falling back to non-atomic loop. Apply migration 072 to close 2d2-F3.",
        );
        const updated = await auth.store.upsertCommissionPayout({ ...body, id, tenant_id: existing.tenant_id });
        if (Array.isArray(updated.commission_ids) && updated.commission_ids.length > 0) {
          for (const commissionId of updated.commission_ids) {
            try {
              await auth.store.markDealCommissionPaid(
                commissionId,
                updated.payment_reference || undefined,
              );
            } catch (e) {
              console.warn(`[commission_payout.update:legacy] markDealCommissionPaid failed for ${commissionId}:`, e);
            }
          }
        }
        await audit(auth.store, auth.user, req, "commission_payout.update", "commission_payout", id, {
          status: "completed",
          legacy_path: true,
        });
        return NextResponse.json(updated);
      }

      if (rpcError) {
        console.error("[commission_payout.update] RPC failed:", rpcError);
        return NextResponse.json(
          { error: `Failed to complete payout: ${rpcError}` },
          { status: 500 },
        );
      }

      // Refresh the payout row from the DB so we return the current
      // state (the RPC updated status, paid_at, payment_reference).
      const updated = await auth.store.getCommissionPayout(id);
      await audit(auth.store, auth.user, req, "commission_payout.update", "commission_payout", id, {
        status: "completed",
        commission_count: rpcResult?.commission_count,
        already_paid_count: rpcResult?.already_paid_count,
        total_count: rpcResult?.total_count,
      });
      return NextResponse.json(updated ?? { ok: true, ...rpcResult });
    }

    // Non-completion PUT (e.g. setting fields on a pending payout, or
    // updating a payout that's already "completed" — idempotent retry).
    const updated = await auth.store.upsertCommissionPayout({ ...body, id, tenant_id: existing.tenant_id });
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
