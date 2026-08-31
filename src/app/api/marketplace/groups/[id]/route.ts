import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import {
  deleteGroup,
  getGroup,
  getGroupRole,
  updateGroup,
} from "@/lib/data/marketplace-community-store";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/marketplace/groups/[id] — fetch one group + the caller's role.
async function _get(req: NextRequest, ctx: RouteCtx) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const group = await getGroup(id);
    if (!group) {
      return NextResponse.json({ error: "Group not found." }, { status: 404 });
    }
    const role = await getGroupRole(group.id, access.partner_id);
    return NextResponse.json({ group, your_role: role });
  } catch (e: any) {
    console.error("[marketplace.community.groups.get]", e);
    return NextResponse.json({ error: "Failed to load group." }, { status: 500 });
  }
}

// PUT /api/marketplace/groups/[id] — update group fields. Moderators/admins only.
async function _put(req: NextRequest, ctx: RouteCtx) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Sanity-check inputs at the API layer so the store doesn't have to.
  if (body.name !== undefined && (typeof body.name !== "string" || body.name.length < 2 || body.name.length > 120)) {
    return NextResponse.json({ error: "name must be 2–120 chars." }, { status: 400 });
  }
  if (body.description !== undefined && body.description !== null && (typeof body.description !== "string" || body.description.length > 2000)) {
    return NextResponse.json({ error: "description must be ≤ 2000 chars." }, { status: 400 });
  }

  try {
    const updated = await updateGroup(id, access.partner_id, {
      name: body.name,
      description: body.description ?? undefined,
      category: body.category ?? undefined,
      is_private: typeof body.is_private === "boolean" ? body.is_private : undefined,
    });
    if (!updated) {
      return NextResponse.json({ error: "Group not found." }, { status: 404 });
    }
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.group_updated",
        "marketplace_groups",
        updated.id,
        { name: updated.name },
      );
    } catch (e) {
      console.error("[marketplace.community.groups.update] audit failed:", e);
    }
    return NextResponse.json(updated);
  } catch (e: any) {
    console.error("[marketplace.community.groups.update]", e);
    const msg = sanitizeError(e);
    const status = /authorised/i.test(msg) ? 403 : /invalid|must be/i.test(msg) ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

// DELETE /api/marketplace/groups/[id] — admins only. Cascades to members.
async function _delete(req: NextRequest, ctx: RouteCtx) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const ok = await deleteGroup(id, access.partner_id);
    if (!ok) {
      return NextResponse.json({ error: "Group not found." }, { status: 404 });
    }
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.group_deleted",
        "marketplace_groups",
        id,
        {},
      );
    } catch (e) {
      console.error("[marketplace.community.groups.delete] audit failed:", e);
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[marketplace.community.groups.delete]", e);
    const msg = sanitizeError(e);
    const status = /authorised/i.test(msg) ? 403 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/groups/[id]");
export const PUT = withApm(_put, "PUT /api/marketplace/groups/[id]");
export const DELETE = withApm(_delete, "DELETE /api/marketplace/groups/[id]");
