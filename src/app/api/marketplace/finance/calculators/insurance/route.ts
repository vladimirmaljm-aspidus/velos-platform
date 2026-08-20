import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { calculateInsurancePremium } from "@/lib/data/marketplace-finance-store";
import { withApm } from "@/lib/monitoring/apm";
import type { RiskLevel } from "@/lib/supabase/marketplace-finance-types";

export const runtime = "nodejs";

const VALID_RISK_LEVELS: RiskLevel[] = ["low", "medium", "high", "very_high"];

// GET /api/marketplace/finance/calculators/insurance
//   ?amount=100000&coverage=90&risk=medium&currency=USD
// — calculate the annual premium for a trade-credit insurance policy. Pure
// calculation; no DB calls. Returns { premium: InsurancePremium }.
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const url = new URL(req.url);
  const amountParam = url.searchParams.get("amount");
  const coverageParam = url.searchParams.get("coverage");
  const riskParam = url.searchParams.get("risk");
  const currency = url.searchParams.get("currency") || "USD";

  if (!amountParam || !coverageParam || !riskParam) {
    return NextResponse.json(
      { error: "amount, coverage, and risk query parameters are required." },
      { status: 400 },
    );
  }
  const amount = Number(amountParam);
  const coverage = Number(coverageParam);
  const risk = riskParam as RiskLevel;
  if (!Number.isFinite(amount) || amount < 0) {
    return NextResponse.json({ error: "amount must be a non-negative number." }, { status: 400 });
  }
  if (!Number.isFinite(coverage) || coverage < 0 || coverage > 100) {
    return NextResponse.json({ error: "coverage must be in [0, 100]." }, { status: 400 });
  }
  if (!VALID_RISK_LEVELS.includes(risk)) {
    return NextResponse.json({ error: "risk must be one of low|medium|high|very_high." }, { status: 400 });
  }
  if (typeof currency !== "string" || currency.length !== 3) {
    return NextResponse.json({ error: "currency must be a 3-letter ISO code." }, { status: 400 });
  }

  try {
    const premium = calculateInsurancePremium(amount, coverage, risk, currency);
    return NextResponse.json({ premium });
  } catch (e: any) {
    console.error("[marketplace.finance.calculators.insurance]", e);
    return NextResponse.json({ error: "Failed to compute insurance premium." }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/finance/calculators/insurance");
