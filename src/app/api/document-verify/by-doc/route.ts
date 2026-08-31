import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, sanitizeError } from "@/lib/api/helpers";
import { createHash } from "crypto";

export const runtime = "nodejs";

// Admin: look up verification by document (offer/invoice/proforma)
export async function GET(req: NextRequest) {
  try {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (document-verify.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "document-verify.read"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_document_verification)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_document_verification", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) return NextResponse.json({ items: [], total: 0 });

  const url = new URL(req.url);
  const docType = url.searchParams.get("doc_type");
  const docId = url.searchParams.get("doc_id");
  if (!docType || !docId) {
    return NextResponse.json({ error: "doc_type and doc_id required." }, { status: 400 });
  }
  const v = await auth.store.getDocumentVerificationByDoc(tenantId, docType, docId);
  if (!v) return NextResponse.json({ verification: null });
  return NextResponse.json({ verification: v });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error)}, { status: 500 });
  }
}
