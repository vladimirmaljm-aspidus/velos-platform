import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { estimateCustoms } from "@/lib/marketplace/calculators";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/calculators/customs?hsCode=7204&origin=DE&dest=RS&value=25000
// — estimate customs duty + VAT for a declared-value import.
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const url = new URL(req.url);
  const hsCode = url.searchParams.get("hsCode") || "";
  const origin = url.searchParams.get("origin") || "";
  const dest = url.searchParams.get("dest") || "";
  const valueRaw = url.searchParams.get("value");
  const value = valueRaw !== null && valueRaw !== "" ? Number(valueRaw) : NaN;

  if (!hsCode || !origin || !dest) {
    return NextResponse.json(
      { error: "hsCode, origin, and dest query parameters are required." },
      { status: 400 },
    );
  }
  if (!Number.isFinite(value) || value < 0) {
    return NextResponse.json(
      { error: "value must be a non-negative number." },
      { status: 400 },
    );
  }

  try {
    const estimate = estimateCustoms(hsCode, origin, dest, value);
    return NextResponse.json({ estimate });
  } catch (e: any) {
    console.error("[marketplace.calculators.customs]", e);
    return NextResponse.json({ error: "Failed to compute customs estimate." }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/calculators/customs");
