import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { requireGpsVerified } from "@/lib/portal/require-gps";
import { getStore } from "@/lib/data/store";
import { markDocumentViewed } from "@/lib/portal/mark-viewed";

export const runtime = "nodejs";

// Same visibility policy as the list route (BUILD-LOI-PORTAL).
const PORTAL_LOI_STATUSES = new Set(["sent", "accepted", "rejected", "expired"]);

/**
 * POST /api/portal/lois/[id]/view
 *
 * BUILD-LOI-PORTAL — marks the LOI as viewed by the portal client. The
 * frontend fires this the moment the detail sheet opens (PORTAL-M2 parity
 * with proformas), so a partner who READS the LOI (but never downloads the
 * PDF) still gets tracked.
 *
 * Idempotent: `markDocumentViewed` only sets `viewed_at` on the FIRST
 * view; subsequent calls just increment `view_count`. Note the LOI status
 * is NOT promoted (no "viewed" status in the LOI state machine — it stays
 * "sent" until accepted / rejected / expired).
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const access = await getPortalSessionAccess();
    if (!access) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    if (!access.can_view_offers) {
      return NextResponse.json({ error: "Not permitted." }, { status: 403 });
    }
    const kycBlock = await requireKycApproved(access);
    if (kycBlock) return kycBlock;
    const gps = await requireGpsVerified(access);
    if (gps) return gps;

    const { id } = await params;

    // Verify the LOI exists, belongs to this portal client, and is visible.
    const store = await getStore();
    const loi = await store.getLoi(id);
    if (!loi) return NextResponse.json({ error: "LOI not found." }, { status: 404 });
    if (loi.tenant_id !== access.tenant_id) {
      return NextResponse.json({ error: "LOI not found." }, { status: 404 });
    }
    if (loi.partner_id !== access.partner_id) {
      return NextResponse.json({ error: "Access denied." }, { status: 403 });
    }
    if (!PORTAL_LOI_STATUSES.has(String(loi.status || "").toLowerCase())) {
      return NextResponse.json({ error: "LOI not found." }, { status: 404 });
    }

    await markDocumentViewed("lois", id, access.tenant_id, access.portal_email);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[portal.loi.view]", e);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
