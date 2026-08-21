import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { requireGpsVerified } from "@/lib/portal/require-gps";
import { getStore } from "@/lib/data/store";
import { markDocumentViewed } from "@/lib/portal/mark-viewed";

export const runtime = "nodejs";

/**
 * POST /api/portal/offers/[id]/view
 *
 * Marks the offer as "viewed" by the portal client. The frontend fires this
 * the moment the detail sheet opens — previously `markDocumentViewed` was only
 * invoked from the PDF download route, so a client who read the offer detail
 * (but never downloaded the PDF) would never transition `status: sent → viewed`
 * and the seller would never know the offer was seen.
 *
 * Idempotent: `markDocumentViewed` only sets `viewed_at` + promotes status on
 * the FIRST view; subsequent calls just increment `view_count`.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await getPortalSessionAccess();
    if (!access) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    if (!access.can_view_offers) {
      return NextResponse.json({ error: "Not permitted." }, { status: 403 });
    }
    const _kycBlock = await requireKycApproved(access);
    if (_kycBlock) return _kycBlock;
    const _gps = await requireGpsVerified(access);
    if (_gps) return _gps;

    const { id } = await params;

    // Verify the offer belongs to this portal client before marking it viewed.
    // Otherwise a client could mark ANY offer id as viewed, leaking existence.
    const store = await getStore();
    const offer = await store.getOffer(id);
    if (!offer) return NextResponse.json({ error: "Offer not found." }, { status: 404 });
    if ((offer as any).tenant_id !== access.tenant_id) {
      return NextResponse.json({ error: "Offer not found." }, { status: 404 });
    }
    if (offer.partner_id !== access.partner_id) {
      return NextResponse.json({ error: "Access denied." }, { status: 403 });
    }

    await markDocumentViewed("offers", id, access.tenant_id, access.portal_email);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[portal.offer.view]", e);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
