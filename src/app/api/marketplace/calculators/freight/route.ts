import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { estimateFreight } from "@/lib/marketplace/calculators";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/calculators/freight?port1=cnsah&port2=nlrtm&container=40gp
// — estimate the freight cost range + transit time for a port pair.
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const url = new URL(req.url);
  const port1 = url.searchParams.get("port1") || "";
  const port2 = url.searchParams.get("port2") || "";
  const container = url.searchParams.get("container") || "40gp";

  if (!port1 || !port2) {
    return NextResponse.json(
      { error: "port1 and port2 query parameters are required." },
      { status: 400 },
    );
  }

  try {
    const quote = estimateFreight(port1, port2, container);
    return NextResponse.json({ quote });
  } catch (e: any) {
    console.error("[marketplace.calculators.freight]", e);
    return NextResponse.json({ error: "Failed to compute freight estimate." }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/calculators/freight");
