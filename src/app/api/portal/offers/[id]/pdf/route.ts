import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { requireGpsVerified } from "@/lib/portal/require-gps";
import { generatePdf } from "@/lib/pdf/generator";
import { markDocumentViewed } from "@/lib/portal/mark-viewed";
// 8b-8: sanitise the document number before interpolating into
// Content-Disposition — closes a header-injection vector on admin-
// controlled but potentially import-tainted numbers.
import { safeFilename } from "@/lib/security/safe-filename";

export const runtime = "nodejs";

/**
 * GET /api/portal/offers/[id]/pdf
 *
 * Generates and returns the PDF for a specific offer.
 * Only accessible by the portal client who owns the offer.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await getPortalSessionAccess();
    if (!access) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    const { getStore } = await import("@/lib/data/store");
    const store = await getStore();

    const { id } = await params;

    // Verify the offer belongs to this portal client
    const offer = await store.getOffer(id);
    if (!offer) {
      return NextResponse.json({ error: "Offer not found." }, { status: 404 });
    }

    // CRITICAL FIX (audit M-5): add tenant_id check for defense-in-depth.
    // partner_id is globally unique (uuid), so this check is unlikely to fail
    // if the partner_id check passes — but it guards against any future schema
    // change (e.g. partner_id becoming tenant-scoped integer) and against
    // bugs in getOffer that might leak cross-tenant rows.
    if ((offer as any).tenant_id !== access.tenant_id) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    // Security: the offer's partner_id must match the portal access partner_id
    if (offer.partner_id !== access.partner_id) {
      return NextResponse.json({ error: "Access denied." }, { status: 403 });
    }

    // Check if portal client has permission to download PDFs
    if (!access.can_download_pdf) {
      return NextResponse.json({ error: "PDF download not available for your tier." }, { status: 403 });
    }

    const _kycBlock = await requireKycApproved(access);
    if (_kycBlock) return _kycBlock;

    // CRITICAL FIX (audit P0-5): GPS gate must also apply to PDF download —
    // otherwise a portal client with a valid session but no shared GPS can
    // curl the PDF endpoint and bypass the client-side gate entirely.
    const _gps = await requireGpsVerified(access);
    if (_gps) return _gps;

    const result = await generatePdf({
      docType: "offer",
      docId: id,
      tenantId: access.tenant_id,
      createVerification: false,
    });

    // Fire-and-forget: mark as viewed (status sent→viewed on first open).
    markDocumentViewed("offers", id, access.tenant_id, access.portal_email).catch(() => {});

    return new NextResponse(new Uint8Array(result.buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="Offer-${safeFilename(offer.number, id)}.pdf"`,
        "Content-Length": result.buffer.length.toString(),
      },
    });
  } catch (e: any) {
    console.error("[portal.offer.pdf]", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
