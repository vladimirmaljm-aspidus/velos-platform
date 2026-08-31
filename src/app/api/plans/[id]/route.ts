import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, hasPermission, sanitizeError } from "@/lib/api/helpers";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase/client";
import { db } from "@/lib/db";

export const runtime = "nodejs";

function requirePlatformPlans(auth: Awaited<ReturnType<typeof requireAuth>>): NextResponse | null {
  if (auth instanceof NextResponse) return auth;
  if (auth.isSuperAdmin) return null;
  // Non super-admins must carry an explicit platform.plans grant.
  const perms = (auth.user as any).permissions as string[] | null;
  if (perms && (perms.includes("*") || hasPermission(perms, "platform:plans") || perms.includes("platform.plans"))) {
    return null;
  }
  return NextResponse.json({ error: "platform.plans permission required." }, { status: 403 });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    const gate = requirePlatformPlans(auth);
    if (gate) return gate;
    if (auth instanceof NextResponse) return auth;
    // Permission gate (platform.plans.write)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "platform.plans.write"); if (_d) return _d; } /* requirePermission wired */


    const { id } = await ctx.params;
    const body = await req.json();

    if (isSupabaseConfigured()) {
      const sb = getSupabase();
      const { data, error } = await sb.from("plans").update(body).eq("id", id).select().single();
      if (error) throw error;
      await audit(auth.store, auth.user, req, "plan.update", "plan", id, { name: data?.name });
      return NextResponse.json(data);
    }
    const updated = await db.plan.update({ where: { id }, data: body });
    await audit(auth.store, auth.user, req, "plan.update", "plan", id, { name: updated.name });
    return NextResponse.json(updated);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error)}, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    const gate = requirePlatformPlans(auth);
    if (gate) return gate;
    if (auth instanceof NextResponse) return auth;

    const { id } = await ctx.params;
    if (isSupabaseConfigured()) {
      const sb = getSupabase();
      const { error } = await sb.from("plans").delete().eq("id", id);
      if (error) throw error;
    } else {
      await db.plan.delete({ where: { id } });
    }
    await audit(auth.store, auth.user, req, "plan.delete", "plan", id);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error)}, { status: 500 });
  }
}
