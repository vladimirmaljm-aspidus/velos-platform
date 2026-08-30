import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKey, audit, sanitizeError, hasPermission, getIp, type AuthContext, type ApiKeyAuthContext } from "@/lib/api/helpers";
import { generatePdf } from "@/lib/pdf/generator";
import { safeFilename } from "@/lib/security/safe-filename";
import { checkRateLimit } from "@/lib/security/rate-limiter";

export const runtime = "nodejs";

function getAuthUser(auth: AuthContext | ApiKeyAuthContext) {
  if ("user" in auth) return auth.user;
  return { id: `api:${auth.apiKeyId}`, username: auth.apiKeyName, tenant_id: auth.tenantId };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // 9a-N3: per-IP rate limit — PDF rendering is CPU-expensive (react-pdf
  // renderToBuffer + logo fetch + SHA-256 hash + DB writes). Without a cap,
  // a logged-in partner / API key holder can hammer this route thousands
  // of times per minute. 30 renders per IP per minute matches admin
  // interactive patterns (a human clicks a few PDFs in a row).
  const _rl = await checkRateLimit(`pdf:ip:${getIp(req)}`, 30, 60_000);
  if (!_rl.allowed) {
    return NextResponse.json(
      { error: "Too many PDF requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(Math.ceil((_rl.retryAfter ?? 60_000) / 1000)) } },
    );
  }
  // F-FINAL: allow API key auth (Bearer asp_...) in addition to cookie
  // sessions. Unblocks programmatic PDF generation (e.g. an integration
  // that archives offer PDFs to external storage) without requiring a
  // logged-in admin session. Permission gate is enforced via
  // requirePermission (cookie) OR hasPermission (API key).
  const auth = await requireAuthOrApiKey(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (offers.read) — cookie session enforces via requirePermission,
    // API key enforces via hasPermission below.
    { const { requirePermission } = await import("@/lib/permissions/can");
      if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "offers.read"); if (_d) return _d; } } /* requirePermission wired */
  if ("apiKeyId" in auth && !hasPermission(auth.permissions, "offers:read")) {
    return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
  }

  const { id } = await params;

  try {
    // Fetch the offer FIRST so we know which tenant it belongs to. This also
    // fixes super-admin downloads: the document itself carries the tenant_id,
    // so super-admins no longer need to pass ?tenant_id= explicitly (the
    // previous silent fallback to tenants[0] was wrong — it returned a PDF
    // for the wrong tenant's first document).
    const offer = await auth.store.getOffer(id);
    if (!offer) return NextResponse.json({ error: "Not found." }, { status: 404 });
    // Tenant ownership check (super-admin can access any tenant's docs;
    // API keys are always tenant-scoped to their key's tenant_id).
    const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
    if (!isSuperAdmin && offer.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const tenantId = offer.tenant_id;

    const partner = offer?.partner_id ? await auth.store.getPartner(offer.partner_id) : null;
    const tenant = await auth.store.getTenant(tenantId);

    const result = await generatePdf({ docType: "offer", docId: id, tenantId });
    await audit(auth.store, getAuthUser(auth), req, "offer.pdf", "offer", id, {
      verification_code: result.verificationCode,
      size: result.buffer.length,
    });

    // 9a-N1: use shared safeFilename — strips CRLF / quotes / control
    // chars. Inline safeName only stripped non-alphanumerics, leaving
    // the door open to HTTP response-splitting via tenant.name or
    // partner.name with `\r\nX-Evil: header-injected` (CSV-import vector).
    const tenantName = safeFilename(tenant?.name, "VELOS").replace(/[^a-zA-Z0-9_-]/g, "-");
    const docNum = safeFilename(offer?.number, id).replace(/[^a-zA-Z0-9_-]/g, "-");
    const partnerName = partner ? `_${safeFilename(partner.name, "").replace(/[^a-zA-Z0-9_-]/g, "-")}` : "";
    const filename = `${tenantName}_Offer_${docNum}${partnerName}.pdf`;

    return new NextResponse(new Uint8Array(result.buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Content-Length": result.buffer.length.toString(),
      },
    });
  } catch (e: any) {
    console.error("[pdf.offer]", e);
    return NextResponse.json({ error: sanitizeError(e)}, { status: 500 });
  }
}
