import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { listMembers, getGroup, getGroupRole } from "@/lib/data/marketplace-community-store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/marketplace/groups/[id]/members — paginated member roster.
// Optional query: ?limit=50&offset=0
// AUDIT16 / MEDIUM-2 — private-group gating: any authenticated portal
// client used to be able to enumerate the member roster of a PRIVATE
// group by UUID (the Q&A store already gates private groups to members —
// this route was the inconsistent one). Public groups keep the open
// roster; private groups answer 404 for non-members (404 not 403 so the
// existence of a private group isn't confirmed).
async function _get(req: NextRequest, ctx: RouteCtx) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    // Gate private groups: only members may view the roster.
    const group = await getGroup(id);
    if (!group) {
      return NextResponse.json({ error: "Group not found." }, { status: 404 });
    }
    if (group.is_private) {
      const role = await getGroupRole(id, access.partner_id);
      if (!role) {
        return NextResponse.json({ error: "Group not found." }, { status: 404 });
      }
    }
    const url = new URL(req.url);
    const limit = url.searchParams.get("limit");
    const offset = url.searchParams.get("offset");
    const items = await listMembers(id, {
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return NextResponse.json(items);
  } catch (e: any) {
    console.error("[marketplace.community.groups.members.list]", e);
    return NextResponse.json({ error: "Failed to load members." }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/groups/[id]/members");
