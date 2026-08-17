import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";

export const runtime = "nodejs";

// Forensic check: compare uploaded PDF hash against stored hash.
// Accepts: { verification_code, pdf_base64 }
// Returns: { match: boolean, stored_hash, computed_hash, details }
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (document-verify.create)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "document-verify.read"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_document_verification)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_document_verification", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  try {
    const body = await req.json();
    const { verification_code, pdf_hash } = body;
    if (!verification_code || !pdf_hash) {
      return NextResponse.json({ error: "verification_code and pdf_hash required." }, { status: 400 });
    }
    const store = auth.store;
    const v = await store.getDocumentVerificationByCode(verification_code);
    if (!v) {
      try {
        await audit(auth.store, auth.user, req, "document.forensic_check", "document", body.document_id, { check_type: body.check_type, verification_code, result: "invalid" });
      } catch (e) { console.error("[audit]", e); }
      return NextResponse.json({
        match: false,
        result: "invalid",
        message: "Verification code not found.",
      });
    }
    // F-9-2: tenant ownership check — the verification row carries a
    // tenant_id; without this gate an authenticated user from tenant A
    // could probe another tenant's verification codes by hash. Return
    // 404 (not 403) to avoid leaking whether the code exists across
    // tenants.
    if (!auth.isSuperAdmin && v.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const computed = pdf_hash.startsWith("sha256:") ? pdf_hash : `sha256:${pdf_hash}`;
    const match = computed === v.pdf_hash;
    try {
      await audit(auth.store, auth.user, req, "document.forensic_check", "document", body.document_id, { check_type: body.check_type, verification_code, result: match ? "valid" : "modified" });
    } catch (e) { console.error("[audit]", e); }
    // FIX (audit P3-25): do NOT return stored_hash or pdf_size to the client.
    // These enable offline hash-comparison and length-extension analysis.
    // Only return whether the hash matched + the document metadata.
    return NextResponse.json({
      match,
      result: match ? "valid" : "modified",
      message: match
        ? "PDF is authentic — no modifications detected."
        : "PDF has been modified after issuance. Stored hash does not match.",
      document_number: v.document_number,
      document_type: v.document_type,
      issued_at: v.issued_at,
      // stored_hash + computed_hash intentionally omitted
    });
  } catch (e) {
    console.error("[forensic]", e);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
