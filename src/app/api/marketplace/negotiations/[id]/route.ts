import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getNegotiation } from "@/lib/data/marketplace-store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/negotiations/[id] — fetch a single negotiation.
// Caller must be one of the two partners in the negotiation.
async function _get(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const n = await getNegotiation(id, access.tenant_id, access.partner_id);
    if (!n) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return NextResponse.json({ negotiation: n });
  } catch (e: any) {
    console.error("[marketplace.negotiations.get]", e);
    return NextResponse.json({ error: "Failed to load negotiation." }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/negotiations/[id]");
