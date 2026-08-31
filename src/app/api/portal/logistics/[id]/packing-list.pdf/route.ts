import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { requireGpsVerified } from "@/lib/portal/require-gps";
import { getSupabase } from "@/lib/supabase/client";
import { getStore } from "@/lib/data/store";
import { renderPackingListPdf, buildPackingListInput } from "@/lib/pdf/packing-list";
import { getIp } from "@/lib/api/helpers";
// 8b-8: sanitise the LR number before interpolating into
// Content-Disposition — closes a header-injection vector.
import { safeFilename } from "@/lib/security/safe-filename";
import { checkRateLimit } from "@/lib/security/rate-limiter";

export const runtime = "nodejs";

// Portal client: download the packing list for their OWN logistics request.
// Ownership is enforced against the caller's partner_id + tenant_id — a
// request from another partner returns 404 (not 403) so we don't leak
// existence across tenants.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  // 9a-N3: per-IP rate limit — packing-list rendering is CPU-expensive.
  const _rl = await checkRateLimit(`pdf:ip:${getIp(req)}`, 30, 60_000);
  if (!_rl.allowed) {
    return NextResponse.json(
      { error: "Too many PDF requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(Math.ceil((_rl.retryAfter ?? 60_000) / 1000)) } },
    );
  }
  const access = await getPortalSessionAccess();
  if (!access) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  // 9a-N4: 4 gates that ALL other portal PDF routes have (offers,
  // invoices, proformas) — but were missing from this packing-list route.
  // A KYC-rejected partner cannot create a logistics request (the
  // create route has these gates), so they MUST NOT be able to download
  // the packing-list PDF for one they already created (consistency).
  if (!access.can_download_pdf) {
    return NextResponse.json({ error: "PDF download not available for your tier." }, { status: 403 });
  }
  const _kycBlock = await requireKycApproved(access);
  if (_kycBlock) return _kycBlock;
  const _gps = await requireGpsVerified(access);
  if (_gps) return _gps;

  // 9a-N5: feature gate — admin counterpart (logistics-requests/[id]/
  // packing-list.pdf/route.ts:23-26) has requireFeature("module_logistics").
  // Portal counterpart must match so partners on a plan without logistics
  // can't download packing-list PDFs (they also can't create them).
  const { requireFeature } = await import("@/lib/api/feature-guard");
  const _f = await requireFeature(access.tenant_id, "module_logistics", false);
  if (_f) return _f;

  const { id } = await params;
  const sb = getSupabase();
  const { data: lr } = await sb.from("logistics_requests").select("*").eq("id", id).maybeSingle();
  if (!lr) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if ((lr as any).partner_id !== access.partner_id || (lr as any).tenant_id !== access.tenant_id) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const store = await getStore();
  const tenant = await store.getTenant((lr as any).tenant_id);
  // audit12: shared builder (extracted from the admin route — this portal
  // route previously carried an identical 25-line inline copy of the same
  // LR → PackingListInput mapping).
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
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
