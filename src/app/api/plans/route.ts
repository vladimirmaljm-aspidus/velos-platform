import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase/client";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(_req: NextRequest) {
  try {
    // Any authenticated user (including tenant users on trial) needs to see
    // the public plan catalog so they can pick an upgrade. Non-public plans
    // and admin-only plans stay hidden for anyone who isn't super_admin.
    const auth = await requireAuth(_req);
    if (auth instanceof NextResponse) return auth;

    if (isSupabaseConfigured()) {
      const sb = getSupabase();
      let q = sb.from("plans").select("*").eq("is_active", true).order("sort_order", { ascending: true });
      if (!auth.isSuperAdmin) q = q.eq("is_public", true);
      const { data, error } = await q;
      if (error) throw error;
      return NextResponse.json({ items: data || [] });
    }
    const plans = await db.plan.findMany({
      where: auth.isSuperAdmin ? { is_active: true } : { is_active: true, is_public: true },
      orderBy: { sort_order: "asc" },
    });
    return NextResponse.json({ items: plans });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (platform.plans.write)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "platform.plans.write"); if (_d) return _d; } /* requirePermission wired */

    if (!auth.isSuperAdmin) return NextResponse.json({ error: "Super-admin access required." }, { status: 403 });
    const body = await req.json();
    if (isSupabaseConfigured()) {
      const sb = getSupabase();
      const { data, error } = await sb.from("plans").insert(body).select().single();
      if (error) throw error;
      await audit(auth.store, auth.user, req, "plan.create", "plan", data.id, { name: data.name });
      return NextResponse.json(data);
    }
    const created = await db.plan.create({ data: body });
    await audit(auth.store, auth.user, req, "plan.create", "plan", created.id, { name: created.name });
    return NextResponse.json(created);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
