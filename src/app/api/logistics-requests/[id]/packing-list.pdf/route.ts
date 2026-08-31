import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKey, hasPermission, sanitizeError, getIp } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import { renderPackingListPdf, buildPackingListInput } from "@/lib/pdf/packing-list";
// 8b-8: sanitise the LR number before interpolating into Content-Disposition.
import { safeFilename } from "@/lib/security/safe-filename";
import { checkRateLimit } from "@/lib/security/rate-limiter";

export const runtime = "nodejs";

// Admin: download the professional packing list PDF for a logistics request.
// F-FINAL: allow API key auth (Bearer asp_...) in addition to cookie sessions,
// matching the other PDF routes — unblocks programmatic packing-list archive
// to external storage.
// audit12: uses the shared buildPackingListInput (extracted from this route —
// the portal route carried an identical inline copy) and now rate-limited
// (30/min per IP) like every other PDF route (the pre-audit12 copy was the
// only admin PDF route without a rate limit).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const rl = await checkRateLimit(`pdf:ip:${getIp(req)}`, 30, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many PDF requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rl.retryAfter ?? 60_000) / 1000)) } },
    );
  }

  const auth = await requireAuthOrApiKey(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (logistics.read) — cookie session enforces via requirePermission,
  // API key enforces via hasPermission below.
  { const { requirePermission } = await import("@/lib/permissions/can");
    if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "logistics.read"); if (_d) return _d; } }
  // Feature gate (module_logistics)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(auth.tenantId, "module_logistics", _isSA); if (_f) return _f; }
  if ("apiKeyId" in auth && !hasPermission(auth.permissions, "logistics:read")) {
    return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
  }

  const { id } = await params;
  const sb = getSupabase();
  const { data: lr } = await sb.from("logistics_requests").select("*").eq("id", id).maybeSingle();
  if (!lr) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
  if (!isSuperAdmin && (lr as any).tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const tenant = await auth.store.getTenant((lr as any).tenant_id);
  const buffer = await renderPackingListPdf(buildPackingListInput(lr as any, tenant?.name || "VELOS"));
  const bytes = new Uint8Array(buffer);
  return new Response(bytes as any, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="packing-list-${safeFilename((lr as any).number, id)}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
  } catch (error: any) {
    console.error("[logistics-requests.packing-list.pdf]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
