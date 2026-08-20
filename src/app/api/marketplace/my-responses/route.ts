import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { listMyResponses, listReceivedResponses } from "@/lib/data/marketplace-store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/my-responses — list responses the caller sent AND
// received.
//   ?type=sent     → responses the caller sent on others' posts
//   ?type=received → responses received on the caller's posts
//   (default)      → both, in { sent: [...], received: [...] }
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const url = new URL(req.url);
  const type = url.searchParams.get("type") || "all";
  try {
    if (type === "sent") {
      const sent = await listMyResponses(access.tenant_id, access.partner_id);
      return NextResponse.json({ sent });
    }
    if (type === "received") {
      const received = await listReceivedResponses(access.tenant_id, access.partner_id);
      return NextResponse.json({ received });
    }
    const [sent, received] = await Promise.all([
      listMyResponses(access.tenant_id, access.partner_id),
      listReceivedResponses(access.tenant_id, access.partner_id),
    ]);
    return NextResponse.json({ sent, received });
  } catch (e: any) {
    console.error("[marketplace.my-responses]", e);
    return NextResponse.json({ error: "Failed to load responses." }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/my-responses");
