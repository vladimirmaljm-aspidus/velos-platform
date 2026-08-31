import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, audit, sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

// GET /api/deal-commissions?tenant_id=xxx&deal_id=xxx&agent_id=xxx
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
    const dealId = url.searchParams.get("deal_id");
    const agentId = url.searchParams.get("agent_id");

    if (dealId) {
      // Verify tenant ownership of the deal before listing its commissions
      const deal = await auth.store.getDeal(dealId);
      if (!deal) return NextResponse.json({ items: [], total: 0 });
      if (!auth.isSuperAdmin && deal.tenant_id !== auth.tenantId) {
        return NextResponse.json({ items: [], total: 0 });
      }
      const items = await auth.store.listDealCommissionsByDeal(dealId);
      return NextResponse.json({ items, total: items.length });
    }
    if (agentId) {
      // Verify tenant ownership of the commission agent before listing its commissions
      const agent = await auth.store.getCommissionAgent(agentId);
      if (!agent) return NextResponse.json({ items: [], total: 0 });
      if (!auth.isSuperAdmin && agent.tenant_id !== auth.tenantId) {
        return NextResponse.json({ items: [], total: 0 });
      }
      const items = await auth.store.listDealCommissionsByAgent(agentId);
      return NextResponse.json({ items, total: items.length });
    }

    const search = url.searchParams.get("search") || undefined;
    const limit = url.searchParams.get("limit") ? Math.min(Number(url.searchParams.get("limit")), 500) : undefined;
    const offset = url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : undefined;

    const result = await auth.store.listDealCommissions(tenantId, { search, limit, offset });
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error)}, { status: 500 });
  }
}

// POST /api/deal-commissions
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (commissions.create)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "commissions.create"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    const tenantId = resolveTenantId(auth, req);
    if (!tenantId) return NextResponse.json({ error: "Tenant ID is required." }, { status: 400 });

    const body = await req.json();
    body.tenant_id = tenantId;

    // Normalize field names (same as commission-agents route)
    if (body.rate !== undefined && body.commission_rate === undefined) {
      body.commission_rate = body.rate;
    }
    if (body.currency !== undefined && body.commission_currency === undefined) {
      body.commission_currency = body.currency;
    }
    if (body.per_unit !== undefined && body.commission_per_unit === undefined) {
      body.commission_per_unit = body.per_unit;
    }
    if (body.custom_formula !== undefined && body.commission_custom_formula === undefined) {
      body.commission_custom_formula = body.custom_formula;
    }
    if (!body.commission_currency) body.commission_currency = "USD";
    if (!body.commission_type) body.commission_type = "profit_percent";

    // Validate required fields
    if (!body.deal_id) return NextResponse.json({ error: "deal_id is required." }, { status: 400 });
    if (!body.agent_id) return NextResponse.json({ error: "agent_id is required." }, { status: 400 });
    // CRITICAL FIX (audit F-1): validate agent_id points to a real
    // commission_agents row in the caller's tenant. Previously, partner_id
    // values were accepted here, causing all commissions to compute as $0.
    {
      const agent = await auth.store.getCommissionAgent(body.agent_id);
      if (!agent || agent.tenant_id !== tenantId) {
        return NextResponse.json({ error: "Commission agent not found." }, { status: 400 });
      }
    }
    if (!body.partner_id) {
      // Try to resolve partner_id from the agent
      const agent = await auth.store.getCommissionAgent(body.agent_id);
      if (agent) body.partner_id = agent.partner_id;
    }

    // Auto-calculate commission if agent_id is provided
    if (body.agent_id && !body.calculated_commission) {
      const agent = await auth.store.getCommissionAgent(body.agent_id);
      if (agent) {
        body.commission_type = body.commission_type || agent.commission_type;
        body.commission_rate = body.commission_rate ?? agent.commission_rate;
        body.commission_per_unit = body.commission_per_unit ?? agent.commission_per_unit;
        body.commission_custom_formula = body.commission_custom_formula ?? agent.commission_custom_formula;
        body.commission_currency = body.commission_currency || agent.commission_currency;
        // CRITICAL FIX (audit P1-5): pass the DEAL's currency (not the agent's
        // commission_currency) so calculateCommission can convert correctly.
        // If deal_currency is not in the body, fetch it from the deal record.
        let dealCurrency = body.deal_currency || "";
        if (!dealCurrency && body.deal_id) {
          try {
            const deal = await auth.store.getDeal(body.deal_id);
            if (deal) dealCurrency = deal.currency || "";
          } catch { /* non-fatal */ }
        }
        body.calculated_commission = await auth.store.calculateCommission(
          agent.id,
          body.deal_value || 0,
          body.deal_profit || 0,
          body.deal_quantity || 0,
          body.deal_unit || "",
          dealCurrency || "USD"
        );
      }
    }

    const created = await auth.store.upsertDealCommission(body);
    await audit(auth.store, auth.user, req, "deal_commission.create", "deal_commission", created.id, { deal_id: created.deal_id, agent_id: created.agent_id });

    return NextResponse.json(created);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error)}, { status: 500 });
  }
}
