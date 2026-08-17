import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { requireGpsVerified } from "@/lib/portal/require-gps";
import { getStore } from "@/lib/data/store";
import { markDocumentViewed } from "@/lib/portal/mark-viewed";

export const runtime = "nodejs";

/**
 * POST /api/portal/invoices/[id]/view
 *
 * Marks the invoice as "viewed" by the portal client. The frontend fires this
 * the moment the detail sheet opens — previously `markDocumentViewed` was only
 * invoked from the PDF download route, so a client who read the invoice detail
 * (but never downloaded the PDF) would never transition `status: sent → viewed`
 * and the seller would never know the invoice was seen.
 *
 * Idempotent: `markDocumentViewed` only sets `viewed_at` + promotes status on
 * the FIRST view; subsequent calls just increment `view_count`.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await getPortalSessionAccess();
    if (!access) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    if (!access.can_view_invoices) {
      return NextResponse.json({ error: "Not permitted." }, { status: 403 });
    }
    const _kycBlock = await requireKycApproved(access);
    if (_kycBlock) return _kycBlock;
    const _gps = await requireGpsVerified(access);
    if (_gps) return _gps;

    const { id } = await params;

    // Verify the invoice belongs to this portal client before marking it viewed.
    const store = await getStore();
    const invoice = await store.getInvoice(id);
    if (!invoice) return NextResponse.json({ error: "Invoice not found." }, { status: 404 });
    if ((invoice as any).tenant_id !== access.tenant_id) {
      return NextResponse.json({ error: "Invoice not found." }, { status: 404 });
    }
    if (invoice.partner_id !== access.partner_id) {
      return NextResponse.json({ error: "Access denied." }, { status: 403 });
    }

    await markDocumentViewed("invoices", id, access.tenant_id, access.portal_email);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[portal.invoice.view]", e);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
