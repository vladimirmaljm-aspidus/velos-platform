import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { requireGpsVerified } from "@/lib/portal/require-gps";
import { getStore } from "@/lib/data/store";
import { markDocumentViewed } from "@/lib/portal/mark-viewed";

export const runtime = "nodejs";

/**
 * POST /api/portal/proformas/[id]/view
 *
 * Marks the proforma as "viewed" by the portal client. The frontend fires this
 * the moment the detail sheet opens — previously `markDocumentViewed` was only
 * invoked from the PDF download route, so a client who read the proforma detail
 * (but never downloaded the PDF) would never transition `status: sent → viewed`
 * and the seller would never know the proforma was seen.
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

    // Verify the proforma belongs to this portal client before marking it viewed.
    const store = await getStore();
    const proforma = await store.getProforma(id);
    if (!proforma) return NextResponse.json({ error: "Proforma not found." }, { status: 404 });
    if ((proforma as any).tenant_id !== access.tenant_id) {
      return NextResponse.json({ error: "Proforma not found." }, { status: 404 });
    }
    if (proforma.partner_id !== access.partner_id) {
      return NextResponse.json({ error: "Access denied." }, { status: 403 });
    }

    await markDocumentViewed("proformas", id, access.tenant_id, access.portal_email);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[portal.proforma.view]", e);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
