import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { calculateFactoringCost } from "@/lib/data/marketplace-finance-store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/finance/calculators/factoring
//   ?amount=50000&discountRate=2.5&advanceRate=80&currency=USD
// — calculate the cost of factoring an invoice. Pure calculation; no DB
// calls. Returns { cost: FactoringCost }.
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const url = new URL(req.url);
  const amountParam = url.searchParams.get("amount");
  const discountParam = url.searchParams.get("discountRate");
  const advanceParam = url.searchParams.get("advanceRate");
  const currency = url.searchParams.get("currency") || "USD";

  if (!amountParam || !discountParam || !advanceParam) {
    return NextResponse.json(
      { error: "amount, discountRate, and advanceRate query parameters are required." },
      { status: 400 },
    );
  }
  const amount = Number(amountParam);
  const discountRate = Number(discountParam);
  const advanceRate = Number(advanceParam);
  if (!Number.isFinite(amount) || amount < 0) {
    return NextResponse.json({ error: "amount must be a non-negative number." }, { status: 400 });
  }
  if (!Number.isFinite(discountRate) || discountRate < 0 || discountRate > 100) {
    return NextResponse.json({ error: "discountRate must be in [0, 100]." }, { status: 400 });
  }
  if (!Number.isFinite(advanceRate) || advanceRate < 0 || advanceRate > 100) {
    return NextResponse.json({ error: "advanceRate must be in [0, 100]." }, { status: 400 });
  }
  if (typeof currency !== "string" || currency.length !== 3) {
    return NextResponse.json({ error: "currency must be a 3-letter ISO code." }, { status: 400 });
  }

  try {
    const cost = calculateFactoringCost(amount, discountRate, advanceRate, currency);
    return NextResponse.json({ cost });
  } catch (e: any) {
    console.error("[marketplace.finance.calculators.factoring]", e);
    return NextResponse.json({ error: "Failed to compute factoring cost." }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/finance/calculators/factoring");
