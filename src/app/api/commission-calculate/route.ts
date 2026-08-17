import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId } from "@/lib/api/helpers";

export const runtime = "nodejs";

// POST /api/commission-calculate
// Body: { agent_id, deal_value, deal_profit, deal_quantity, deal_unit, currency }
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (commissions.calculate)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "commissions.calculate"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */


    const body = await req.json();
    if (!body.agent_id) {
      return NextResponse.json({ error: "agent_id is required." }, { status: 400 });
    }

    const agent = await auth.store.getCommissionAgent(body.agent_id);
    if (!agent) {
      return NextResponse.json({ error: "Commission agent not found." }, { status: 404 });
    }
    if (!auth.isSuperAdmin && agent.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Commission agent not found." }, { status: 404 });
    }

    const commission = await auth.store.calculateCommission(
      agent.id,
      body.deal_value || 0,
      body.deal_profit || 0,
      body.deal_quantity || 0,
      body.deal_unit || "",
      body.currency || "USD"
    );

    return NextResponse.json({
      agent_id: agent.id,
      commission_type: agent.commission_type,
      commission_rate: agent.commission_rate,
      commission_per_unit: agent.commission_per_unit,
      calculated_commission: commission,
      currency: agent.commission_currency,
      breakdown: {
        deal_value: body.deal_value || 0,
        deal_profit: body.deal_profit || 0,
        deal_quantity: body.deal_quantity || 0,
        formula: getFormulaDescription(agent.commission_type, agent.commission_rate, agent.commission_per_unit),
      },
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}

function getFormulaDescription(type: string, rate: number, perUnit: number): string {
  switch (type) {
    case "profit_percent": return `${rate}% of profit`;
    case "revenue_percent": return `${rate}% of revenue`;
    case "fixed": return `Fixed: ${rate}`;
    case "per_unit": return `${perUnit} per unit`;
    case "custom": return `Custom formula`;
    default: return `Unknown`;
  }
}
