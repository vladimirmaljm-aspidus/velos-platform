import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getESGScore } from "@/lib/data/marketplace-esg-store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/esg/[partnerId] — fetch a company's ESG score.
//
// Public to any authenticated partner — the ESG score is a public trust
// signal on the company profile (same reasoning as
// /api/marketplace/profiles/[partnerId]).
//
// Returns `{ score: ESGScore | null }`. `null` means the company has no
// assessment yet — the UI surfaces this as "unrated".
async function _get(_req: NextRequest, ctx: { params: Promise<{ partnerId: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { partnerId } = await ctx.params;
  try {
    const score = await getESGScore(partnerId);
    return NextResponse.json({ score });
  } catch (e: any) {
    console.error("[marketplace.esg.get]", e);
    return NextResponse.json({ error: "Failed to load ESG score." }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/esg/[partnerId]");
