import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKey, audit, sanitizeError, hasPermission, type AuthContext, type ApiKeyAuthContext } from "@/lib/api/helpers";
import { generatePdf } from "@/lib/pdf/generator";

export const runtime = "nodejs";

function getAuthUser(auth: AuthContext | ApiKeyAuthContext) {
  if ("user" in auth) return auth.user;
  return { id: `api:${auth.apiKeyId}`, username: auth.apiKeyName, tenant_id: auth.tenantId };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // F-FINAL: allow API key auth (Bearer asp_...) in addition to cookie
  // sessions. Unblocks programmatic PDF generation (e.g. an integration
  // that archives proforma PDFs to external storage) without requiring a
  // logged-in admin session.
  const auth = await requireAuthOrApiKey(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (proformas.read) — cookie session enforces via requirePermission,
    // API key enforces via hasPermission below.
    { const { requirePermission } = await import("@/lib/permissions/can");
      if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "proformas.read"); if (_d) return _d; } } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_finance", _isSA); if (_f) return _f; } /* requireFeature wired */
  if ("apiKeyId" in auth && !hasPermission(auth.permissions, "proformas:read")) {
    return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
  }

  const { id } = await params;

  try {
    // Fetch the proforma FIRST so we know which tenant it belongs to. This
    // fixes super-admin downloads: the document itself carries the tenant_id,
    // so super-admins no longer need to pass ?tenant_id= explicitly (the
    // previous silent fallback to tenants[0] returned a PDF for the wrong tenant).
    const proforma = await auth.store.getProforma(id);
    if (!proforma) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
    if (!isSuperAdmin && proforma.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const tenantId = proforma.tenant_id;

    const partner = proforma?.partner_id ? await auth.store.getPartner(proforma.partner_id) : null;
    const tenant = await auth.store.getTenant(tenantId);

    const result = await generatePdf({ docType: "proforma", docId: id, tenantId });
    await audit(auth.store, getAuthUser(auth), req, "proforma.pdf", "proforma", id, {
      verification_code: result.verificationCode,
    });

    const safeName = (s: string) => s.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    const tenantName = safeName(tenant?.name || "VELOS");
    const docNum = safeName(proforma?.number || id);
    const partnerName = partner ? `_${safeName(partner.name)}` : "";
    const filename = `${tenantName}_Proforma_${docNum}${partnerName}.pdf`;

    return new NextResponse(new Uint8Array(result.buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Content-Length": result.buffer.length.toString(),
      },
    });
  } catch (e: any) {
    console.error("[pdf.proforma]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
