import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { requireGpsVerified } from "@/lib/portal/require-gps";
import { getSupabase } from "@/lib/supabase/client";
import { getStore } from "@/lib/data/store";
import { renderPackingListPdf, buildPackingListInput } from "@/lib/pdf/packing-list";
import { getIp, sanitizeError } from "@/lib/api/helpers";
// 8b-8: sanitise the LR number before interpolating into
// Content-Disposition — closes a header-injection vector.
import { safeFilename } from "@/lib/security/safe-filename";
import { checkRateLimit } from "@/lib/security/rate-limiter";

export const runtime = "nodejs";

// audit20 / 20-d2 — resolve the tenant's default letterhead logo / seal
// image to a data: URL. The packing-list renderer only accepts data: URLs
// (@react-pdf/renderer has no error boundary around <Image> — a remote
// fetch failure would take the whole render down). Minimal local copy of
// generator.ts's fetchAsDataUrl pattern (kept local to keep this route
// self-contained, same as the admin route's copy); any failure returns
// null → the PDF renders without the image.
async function fetchImageAsDataUrl(url: string): Promise<string | null> {
  try {
    if (url.startsWith("data:")) return url;
    let target = url;
    if (!/^https?:\/\//i.test(url)) {
      // Relative Supabase storage path — build the public URL the same
      // way generator.ts's fallback does.
      if (!process.env.SUPABASE_URL) return null;
      target = `${process.env.SUPABASE_URL}/storage/v1/object/public/tenant-logos/${url}`;
    }
    const res = await fetch(target, { redirect: "follow" });
    if (!res.ok) return null;
    const contentType = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (!contentType.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return null;
    return `data:${contentType};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

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
  const input = buildPackingListInput(lr as any, tenant?.name || "VELOS");
  // audit20 / 20-d2 — letterhead + seal parity with the admin packing-list
  // route + the offer/invoice/proforma/LOI PDFs: populate the (previously
  // dead) letterheadUrl / sealUrl props from the tenant's DEFAULT
  // letterhead + seal. Best-effort — the mock store throws
  // mockUnsupported on these lookups and any fetch failure degrades to the
  // unbranded PDF (never fails the download).
  try {
    const lh = await store.getDefaultLetterhead((lr as any).tenant_id);
    if (lh?.logo_url) input.letterheadUrl = await fetchImageAsDataUrl(lh.logo_url);
  } catch (e) {
    console.warn("[portal.logistics.packing-list.pdf] letterhead resolve failed:", e);
  }
  try {
    const seal = await store.getDefaultSeal((lr as any).tenant_id);
    if (seal?.image_url) input.sealUrl = await fetchImageAsDataUrl(seal.image_url);
  } catch (e) {
    console.warn("[portal.logistics.packing-list.pdf] seal resolve failed:", e);
  }
  const buffer = await renderPackingListPdf(input);
  const bytes = new Uint8Array(buffer);
  return new Response(bytes as any, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="packing-list-${safeFilename((lr as any).number, id)}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error)}, { status: 500 });
  }
}
