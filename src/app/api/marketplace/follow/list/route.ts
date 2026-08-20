import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { listFollowing, listFollowers } from "@/lib/data/marketplace-profile-store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/follow/list?type=following|followers
//
//   ?type=following   → who I follow (caller is follower_partner_id).
//   ?type=followers   → who follows ME (caller is followed_partner_id;
//                       the store verifies followed_partner_id === caller
//                       so a partner can't enumerate its competitors'
//                       follower lists).
//
// Returns { items: [{ partner_id, created_at }] } — the API layer does NOT
// JOIN the partners table here because the caller's UI can resolve names
// on demand (e.g. when the user clicks on one of the followers). This
// keeps the response small for partners with large follow graphs.
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const url = new URL(req.url);
  const type = url.searchParams.get("type") || "following";

  try {
    if (type === "followers") {
      // listFollowers throws if caller !== followed_partner_id, which is
      // the only legitimate way to enumerate followers (a partner can
      // only see their OWN followers).
      const items = await listFollowers(access.partner_id, access.partner_id);
      return NextResponse.json({
        items: items.map((r) => ({ partner_id: r.follower_partner_id, created_at: r.created_at })),
      });
    }
    // Default: following.
    const items = await listFollowing(access.partner_id);
    return NextResponse.json({
      items: items.map((r) => ({ partner_id: r.followed_partner_id, created_at: r.created_at })),
    });
  } catch (e: any) {
    console.error("[marketplace.follow.list]", e);
    return NextResponse.json({ error: e.message || "Failed to load follows." }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/follow/list");
