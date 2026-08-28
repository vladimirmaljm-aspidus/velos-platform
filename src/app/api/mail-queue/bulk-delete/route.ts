import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

/**
 * POST /api/mail-queue/bulk-delete
 *
 * Body: { status?: string } — filter by status (e.g. "failed", "pending").
 * If no status provided, deletes ALL non-sent emails.
 *
 * Auth: admin or super_admin. Super_admin without tenant context deletes
 * across ALL tenants. Regular admin only deletes their own tenant's emails.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;

    const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "mail-queue.delete");
    if (_d) return _d;

    const tid = resolveTenantId(auth, req);
    const body = await req.json().catch(() => ({}));
    const statusFilter = body?.status as string | undefined;

    const sb = getSupabase();
    let query = sb.from("mail_queue").delete();
    if (tid) {
      query = query.eq("tenant_id", tid);
    }
    if (statusFilter) {
      query = query.eq("status", statusFilter);
    } else {
      // Delete all non-sent emails
      query = query.neq("status", "sent");
    }

    const { count, error } = await query;
    if (error) throw error;

    return NextResponse.json({ ok: true, deleted: count || 0 });
  } catch (e: any) {
    console.error("[mail-queue bulk-delete]", e);
    return NextResponse.json({ error: e?.message || "Failed" }, { status: 500 });
  }
}
