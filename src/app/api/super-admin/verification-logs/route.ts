import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, sanitizeError } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

/**
 * GET /api/super-admin/verification-logs
 *
 * Cross-tenant viewer for the detailed per-verification log written by the
 * PUBLIC /api/verify/[code] endpoint. Each row records WHO verified a
 * document (IP, country, city, lat/lng, device, browser, OS), WHAT document
 * was verified, and the result (valid | invalid | revoked | modified).
 *
 * Access: super_admin only. RLS on `document_verification_logs` is permissive
 * (USING true) as defense-in-depth — the API layer is the source of truth.
 *
 * Query params:
 *   - code: filter by verification_code (exact match)
 *   - limit: page size (default 100, max 500)
 *   - offset: pagination offset (default 0)
 */
export async function GET(req: NextRequest) {
  try {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const sb = getSupabase();
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") || 100), 500);
  const offset = Number(url.searchParams.get("offset") || 0);
  const code = url.searchParams.get("code");

  let query = sb
    .from("document_verification_logs")
    .select("*", { count: "exact" })
    .order("verified_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (code) query = query.eq("verification_code", code);

  const { data, error, count } = await query;
  if (error) {
    // Most common cause: migration 006 not yet applied (table missing).
    // Return a clear error so the super-admin viewer can show a helpful
    // message rather than a blank screen.
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    items: data || [],
    total: count || 0,
    limit,
    offset,
  });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error)}, { status: 500 });
  }
}
