import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { generatePdf } from "@/lib/pdf/generator";
// 8b-8: sanitise the LOI number before interpolating into Content-Disposition.
import { safeFilename } from "@/lib/security/safe-filename";

export const runtime = "nodejs";

/**
 * GET /api/lois/[id]/pdf — render the LOI as a professional PDF using the
 * same `generatePdf` system as offers/invoices/proformas (memorandum
 * header + logo, footer with QR + address + page#, verification code,
 * signature blocks, etc.).
 *
 * The LOI template branch renders an introductory paragraph (or the LOI's
 * custom `terms_text` when provided), a single-product specifications
 * table, delivery & payment terms, validity, optional notes, and the
 * buyer/seller signature blocks.
 *
 * The verification code is generated + persisted by `generatePdf` and
 * also returned in the `X-Verification-Code` response header so the
 * caller can display it.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    // Fetch the LOI first to get the tenant_id (needed for super-admin
    // downloads where the auth.tenantId differs from the doc's tenant).
    const loi = await auth.store.getLoi(id);
    if (!loi) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && loi.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    const result = await generatePdf({
      docType: "loi",
      docId: id,
      tenantId: loi.tenant_id,
    });

    // Audit the PDF download (non-fatal — keep the PDF flowing even if
    // the audit write fails).
    try {
      await audit(auth.store, auth.user, req, "loi.pdf_downloaded", "loi", id, {
        number: loi.number,
        verification_code: result.verificationCode,
      });
    } catch (e: any) {
      console.warn("[loi.pdf] audit failed:", e?.message || e);
    }

    const headers = new Headers();
    headers.set("Content-Type", "application/pdf");
    headers.set("Content-Disposition", `attachment; filename="LOI-${safeFilename(loi.number, id)}.pdf"`);
    headers.set("Content-Length", String(result.buffer.length));
    if (result.verificationCode) {
      headers.set("X-Verification-Code", result.verificationCode);
    }
    // Wrap the Buffer in a Uint8Array so it conforms to Next.js's BodyInit
    // expectation (raw Buffer isn't assignable in strict mode).
    return new NextResponse(new Uint8Array(result.buffer), { status: 200, headers });
  } catch (e: any) {
    console.error("[lois.pdf]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
