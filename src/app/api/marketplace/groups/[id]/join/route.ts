import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { joinGroup, leaveGroup } from "@/lib/data/marketplace-community-store";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// POST /api/marketplace/groups/[id]/join — join a group. Idempotent.
async function _post(req: NextRequest, ctx: RouteCtx) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const result = await joinGroup(id, access.partner_id);
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.group_joined",
        "marketplace_group_members",
        id,
        { already_member: !result.joined },
      );
    } catch (e) {
      console.error("[marketplace.community.groups.join] audit failed:", e);
    }
    return NextResponse.json({
      joined: result.joined,
      member: result.member,
    });
  } catch (e: any) {
    console.error("[marketplace.community.groups.join]", e);
    const msg = e?.message || "Failed to join group.";
    const status = /not found/i.test(msg) ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

// DELETE /api/marketplace/groups/[id]/join — leave a group. Idempotent.
async function _delete(req: NextRequest, ctx: RouteCtx) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    await leaveGroup(id, access.partner_id);
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.group_left",
        "marketplace_group_members",
        id,
        {},
      );
    } catch (e) {
      console.error("[marketplace.community.groups.leave] audit failed:", e);
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[marketplace.community.groups.leave]", e);
    const msg = e?.message || "Failed to leave group.";
    const status = /authorised/i.test(msg) ? 403 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const POST = withApm(_post, "POST /api/marketplace/groups/[id]/join");
export const DELETE = withApm(_delete, "DELETE /api/marketplace/groups/[id]/join");
