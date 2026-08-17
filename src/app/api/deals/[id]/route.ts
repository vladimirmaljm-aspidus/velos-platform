import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { validateStatusTransition } from "@/lib/api/status-validator";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(_req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (deals.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "deals.read"); if (_d) return _d; } /* requirePermission wired */

    const { id } = await params;
    const item = await auth.store.getDeal(id);
    if (!item) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && item.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return NextResponse.json(item);
  } catch (error: any) {
    console.error("[deals GET id]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (deals.update)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "deals.update"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_crm)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_crm", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    const { id } = await params;
    const existing = await auth.store.getDeal(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const body = await req.json();
    // FIX-P1-LOGIC Fix 1: enforce valid stage transitions. Deals use the
    // `stage` column (semantically equivalent to `status` for the other
    // doc types). Super-admins bypass so they can correct bad data.
    if (body.stage && body.stage !== existing.stage && !auth.isSuperAdmin) {
      const transition = validateStatusTransition("deal", existing.stage, body.stage);
      if (!transition.valid) {
        return NextResponse.json({ error: transition.error }, { status: 400 });
      }
    }
    // CRITICAL FIX (audit F-1): validate commission_agent_id points to a real
    // commission_agents row in the caller's tenant. Previously, partner_id values
    // were stored here, causing all commissions to silently compute as $0.
    if (body.commission_agent_id) {
      const agent = await auth.store.getCommissionAgent(body.commission_agent_id);
      if (!agent || agent.tenant_id !== auth.tenantId) {
        return NextResponse.json({ error: "Commission agent not found." }, { status: 400 });
      }
    }
    // S-FIX / IDOR prevention: validate every cross-referenced entity in the
    // PATCH body belongs to the caller's tenant. Without these checks, an
    // authenticated user could repoint a deal at another tenant's partner /
    // buyer / supplier / product / contract by PUTting those IDs (the DB has
    // no FK enforcing tenant scoping across these tables). Super-admins
    // bypass so they can remediate cross-tenant references.
    if (!auth.isSuperAdmin) {
      const tid = auth.tenantId!;
      if (body.partner_id) {
        const partner = await auth.store.getPartner(body.partner_id);
        if (!partner || partner.tenant_id !== tid) {
          return NextResponse.json({ error: "Partner not found." }, { status: 404 });
        }
      }
      if (body.buyer_id) {
        const buyer = await auth.store.getPartner(body.buyer_id);
        if (!buyer || buyer.tenant_id !== tid) {
          return NextResponse.json({ error: "Buyer not found." }, { status: 404 });
        }
      }
      if (body.supplier_id) {
        const supplier = await auth.store.getPartner(body.supplier_id);
        if (!supplier || supplier.tenant_id !== tid) {
          return NextResponse.json({ error: "Supplier not found." }, { status: 404 });
        }
      }
      if (body.product_id) {
        const product = await auth.store.getProduct(body.product_id);
        if (!product || product.tenant_id !== tid) {
          return NextResponse.json({ error: "Product not found." }, { status: 404 });
        }
      }
      if (body.contract_id) {
        // Contract field references a Deal (parent deal) — re-use getDeal
        // for ownership verification.
        const contract = await auth.store.getDeal(body.contract_id);
        if (!contract || contract.tenant_id !== tid) {
          return NextResponse.json({ error: "Contract not found." }, { status: 404 });
        }
      }
    }
    const updated = await auth.store.upsertDeal({ ...body, id, tenant_id: existing.tenant_id });
    await audit(auth.store, auth.user, req, "deal.update", "deal", id, { stage: updated.stage });
    return NextResponse.json(updated);
  } catch (error: any) {
    console.error("[deals PUT id]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (deals.delete)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "deals.delete"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_crm)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_crm", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    const { id } = await params;
    const existing = await auth.store.getDeal(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    // FIX-P1: cascade commissions before deleting the deal (D-1).
    try {
      const { cascadeCommissionOnDelete } = await import("@/lib/api/commission-cascade");
      await cascadeCommissionOnDelete(id, existing.tenant_id, "deal deleted");
    } catch (e) {
      console.warn("[deals DELETE] commission cascade failed:", e);
    }
    // FIX-P1: refuse delete when linked offers exist.
    try {
      const { getSupabase } = await import("@/lib/supabase/client");
      const { data: linkedOffers } = await getSupabase().from("offers").select("id").eq("deal_id", id).limit(1).maybeSingle();
      if (linkedOffers) {
        return NextResponse.json(
          { error: "Cannot delete deal — linked offers exist." },
          { status: 409 },
        );
      }
    } catch (depErr) {
      console.warn("[deals DELETE] dependency check failed:", depErr);
    }
    await auth.store.deleteDeal(id);
    await audit(auth.store, auth.user, req, "deal.delete", "deal", id);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("[deals DELETE id]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
