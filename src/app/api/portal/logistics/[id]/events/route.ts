import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requirePortalModule } from "@/lib/portal/module-permissions";
import { listLogisticsEvents } from "@/lib/logistics/events";
import { getSupabase } from "@/lib/supabase/client";
import { sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

// Portal client: read the timeline for their OWN logistics request.
// Ownership check: the request must belong to the caller's partner_id.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const access = await getPortalSessionAccess();
  if (!access) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  // 099 — module permission gate (logistics).
  const _moduleBlock = await requirePortalModule(access, "logistics");
  if (_moduleBlock) return _moduleBlock;

  const { id } = await params;
  const sb = getSupabase();
  const { data: lr } = await sb
    .from("logistics_requests")
    .select("tenant_id, partner_id")
    .eq("id", id)
    .maybeSingle();
  if (!lr) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if ((lr as any).partner_id !== access.partner_id || (lr as any).tenant_id !== access.tenant_id) {
    // Do not leak whether the row exists in another tenant.
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const events = await listLogisticsEvents((lr as any).tenant_id, id);
  // Portal view hides admin-only "note" events unless they were explicitly
  // sent to the client. For now we keep everything — admin should use
  // internal notes elsewhere. Filter here later if needed.
  return NextResponse.json({ items: events });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error)}, { status: 500 });
  }
}
