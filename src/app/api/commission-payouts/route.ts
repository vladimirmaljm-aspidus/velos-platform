import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, audit, sanitizeError } from "@/lib/api/helpers";
// 31-f — shared request-body validation helpers (audit 30-a findings
// 30a-07/30a-08: POST {} → 500 "createCommissionPayoutAtomic: partner_id
// is required" (the RPC's own guard thrown through the generic catch), and
// {total_amount: "four hundred"} → PostgREST 22P02 numeric cast → 500;
// now clean 400s before the DB write).
import { requireFields, assertNumeric } from "@/lib/api/validate";

export const runtime = "nodejs";

// GET /api/commission-payouts?tenant_id=xxx
export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (commissions.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "commissions.read"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    const tenantId = resolveTenantId(auth, req);
    if (!tenantId) return NextResponse.json({ items: [], total: 0 });

    const url = new URL(req.url);
    const search = url.searchParams.get("search") || undefined;
    const limit = url.searchParams.get("limit") ? Math.min(Number(url.searchParams.get("limit")), 500) : undefined;
    const offset = url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : undefined;

    const result = await auth.store.listCommissionPayouts(tenantId, { search, limit, offset });
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error)}, { status: 500 });
  }
}

// POST /api/commission-payouts
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (commissions.payout)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "commissions.payout"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    const tenantId = resolveTenantId(auth, req);
    if (!tenantId) return NextResponse.json({ error: "Tenant ID is required." }, { status: 400 });

    // 31-f — guard the JSON parse (malformed body previously hit the
    // generic catch → 500; mirrors the pattern used by every other
    // high-traffic route).
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    // 31-f — required-field + numeric validation BEFORE the RPC (audit
    // 30a-08: POST {} → 500 "createCommissionPayoutAtomic: partner_id is
    // required"; 30a-07: {total_amount: "four hundred"} → 500). partner_id
    // and agent_id are NOT NULL with no defaults — the store's RPC wrapper
    // only guards partner_id itself, so guard both here for a clean 400.
    // (total_amount / currency / commission_ids / status are defaulted by
    // the store's createCommissionPayoutAtomic.)
    {
      const bad = requireFields(body, ["partner_id", "agent_id"]);
      if (bad) return bad;
    }
    // total_amount is a numeric column — a junk string is a PostgREST
    // 22P02, so coerce-or-400 up front.
    {
      const bad = assertNumeric(body, ["total_amount"]);
      if (bad) return bad;
    }
    body.tenant_id = tenantId;
    body.created_by = auth.user.id;

    // Validate commission ownership BEFORE creating the payout row (prevent TOCTOU)
    if (body.commission_ids && body.status === "completed") {
      for (const commissionId of body.commission_ids) {
        const commission = await auth.store.getDealCommission(commissionId);
        if (!commission) {
          return NextResponse.json({ error: `Commission ${commissionId} not found.` }, { status: 404 });
        }
        if (!auth.isSuperAdmin && commission.tenant_id !== auth.tenantId) {
          return NextResponse.json({ error: "Commission does not belong to tenant." }, { status: 403 });
        }
        // Audit F-6/P1-7: payouts may only cover APPROVED commissions.
        // Without this check, an admin could mark a payout "completed"
        // for a batch that includes pending / cancelled commissions —
        // bypassing the approval workflow and paying out unreviewed
        // amounts. `markDealCommissionPaid` would then flip the
        // commission status straight to "paid", skipping "approved".
        if (commission.status !== "approved") {
          return NextResponse.json(
            {
              error: `Commission ${commissionId} is in status "${commission.status}" — only "approved" commissions can be paid out.`,
              commission_id: commissionId,
              current_status: commission.status,
            },
            { status: 400 }
          );
        }
      }
    }

    // CRITICAL FIX (audit B-1 P3 / C-3): use the atomic
    // `createCommissionPayoutAtomic` store method, which calls the
    // `create_commission_payout` RPC (migration 002) — the payout INSERT
    // and the bulk mark-paid UPDATE run in a single Postgres transaction.
    // Previously, the route did `upsertCommissionPayout` (INSERT) followed
    // by a JS loop of `markDealCommissionPaid`; if the loop failed mid-way,
    // the payout row existed but only some commissions were marked paid.
    // The RPC also skips the mark-paid step when status != 'completed'
    // (patched in 031_erp_rpc_adoption.sql), so pending payouts no longer
    // accidentally transition commissions to 'paid'.
    const commissionIds: string[] = Array.isArray(body.commission_ids) ? body.commission_ids : [];
    const created = await auth.store.createCommissionPayoutAtomic(
      { ...body, commission_ids: commissionIds },
      commissionIds,
    );
    await audit(auth.store, auth.user, req, "commission_payout.create", "commission_payout", created.id, { agent_id: created.agent_id, total_amount: created.total_amount });
    // No follow-up mark-paid loop — the RPC handled it atomically when
    // created.status === 'completed'. For 'pending' payouts, no mark-paid
    // is desired (the payout row is just reserved for later completion via
    // the PUT route, which still uses the non-atomic upsertCommissionPayout
    // + markDealCommissionPaid loop — out of scope for this fix).

    return NextResponse.json(created);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error)}, { status: 500 });
  }
}
