import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, sanitizeError } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

/**
 * GET /api/logistics-requests   → admin list of portal-submitted logistics quotes.
 *   params: partner_id, status, search, limit, offset
 */
export async function GET(req: NextRequest) {
  try {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "logistics.read"); if (_d) return _d; }
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_logistics", auth.isSuperAdmin); if (_f) return _f; }

  const tid = resolveTenantId(auth, req);
  if (!tid) return NextResponse.json({ items: [], total: 0 });

  const sb = getSupabase();
  const url = new URL(req.url);
  const partnerId = url.searchParams.get("partner_id");
  const status = url.searchParams.get("status");
  const search = url.searchParams.get("search");
  const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
  const offset = Number(url.searchParams.get("offset")) || 0;

  let q = sb.from("logistics_requests").select("*", { count: "exact" }).eq("tenant_id", tid);
  if (partnerId) q = q.eq("partner_id", partnerId);
  if (status) q = q.eq("status", status);
  if (search) {
    // Sanitize search to prevent PostgREST .or() filter injection
    // (audit A-3/P0-3): commas separate OR clauses, parens group them.
    const s = search.replace(/[(),\\]/g, " ");
    q = q.or(`number.ilike.%${s}%,cargo_description.ilike.%${s}%,origin_city.ilike.%${s}%,destination_city.ilike.%${s}%`);
  }
  q = q.order("created_at", { ascending: false }).range(offset, offset + limit - 1);
  const { data, count, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ items: data || [], total: count || 0 });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error)}, { status: 500 });
  }
}
