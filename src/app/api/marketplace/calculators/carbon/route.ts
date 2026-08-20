import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { estimateCarbonFootprint } from "@/lib/marketplace/calculators";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/calculators/carbon?port1=cnsah&port2=nlrtm&container=40gp&weight=18
// — estimate the CO2 emissions of a sea shipment, in tonnes.
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const url = new URL(req.url);
  const port1 = url.searchParams.get("port1") || "";
  const port2 = url.searchParams.get("port2") || "";
  const container = url.searchParams.get("container") || "40gp";
  const weightRaw = url.searchParams.get("weight");
  const weight = weightRaw !== null && weightRaw !== "" ? Number(weightRaw) : 0;

  if (!port1 || !port2) {
    return NextResponse.json(
      { error: "port1 and port2 query parameters are required." },
      { status: 400 },
    );
  }
  if (!Number.isFinite(weight) || weight < 0) {
    return NextResponse.json(
      { error: "weight must be a non-negative number (tonnes)." },
      { status: 400 },
    );
  }

  try {
    const estimate = estimateCarbonFootprint(port1, port2, container, weight);
    return NextResponse.json({ estimate });
  } catch (e: any) {
    console.error("[marketplace.calculators.carbon]", e);
    return NextResponse.json({ error: "Failed to compute carbon estimate." }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/calculators/carbon");
