import { NextRequest, NextResponse } from "next/server";
import { requireAuth, sanitizeError } from "@/lib/api/helpers";
import { listLogisticsEvents } from "@/lib/logistics/events";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

// Admin: read the append-only timeline for a logistics request.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const auth = await requireAuth(_req);
  if (auth instanceof NextResponse) return auth;
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "logistics.read"); if (_d) return _d; }

  const { id } = await params;
  const sb = getSupabase();
  const { data: lr } = await sb.from("logistics_requests").select("tenant_id").eq("id", id).maybeSingle();
  if (!lr) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!auth.isSuperAdmin && (lr as any).tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const events = await listLogisticsEvents((lr as any).tenant_id, id);
  return NextResponse.json({ items: events });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error)}, { status: 500 });
  }
}
