import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { calculateContainerLoadability } from "@/lib/marketplace/calculators";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/calculators/container?containerType=40gp&pkgWeight=25&pkgVolume=0.05
// — compute how many packages of a fixed weight/volume fit in a container.
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const url = new URL(req.url);
  const containerType = url.searchParams.get("containerType") || "40gp";
  const pkgWeightRaw = url.searchParams.get("pkgWeight");
  const pkgVolumeRaw = url.searchParams.get("pkgVolume");
  const pkgWeight = pkgWeightRaw !== null && pkgWeightRaw !== "" ? Number(pkgWeightRaw) : 0;
  const pkgVolume = pkgVolumeRaw !== null && pkgVolumeRaw !== "" ? Number(pkgVolumeRaw) : 0;

  if (!Number.isFinite(pkgWeight) || pkgWeight < 0) {
    return NextResponse.json(
      { error: "pkgWeight must be a non-negative number." },
      { status: 400 },
    );
  }
  if (!Number.isFinite(pkgVolume) || pkgVolume < 0) {
    return NextResponse.json(
      { error: "pkgVolume must be a non-negative number." },
      { status: 400 },
    );
  }

  try {
    const result = calculateContainerLoadability(containerType, pkgWeight, pkgVolume);
    return NextResponse.json({ result });
  } catch (e: any) {
    console.error("[marketplace.calculators.container]", e);
    return NextResponse.json({ error: "Failed to compute loadability." }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/calculators/container");
