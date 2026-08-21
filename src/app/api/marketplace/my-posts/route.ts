import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { listMyPosts } from "@/lib/data/marketplace-store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/my-posts — list the caller's own posts (any status,
// any visibility — they're the owner).
async function _get(_req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  try {
    const items = await listMyPosts(access.tenant_id, access.partner_id);
    return NextResponse.json({ items });
  } catch (e: any) {
    console.error("[marketplace.my-posts]", e);
    return NextResponse.json({ error: "Failed to load your posts." }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/my-posts");
