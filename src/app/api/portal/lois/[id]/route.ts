import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { requireGpsVerified } from "@/lib/portal/require-gps";
import { getStore } from "@/lib/data/store";
import { redactDocumentForPortal } from "@/lib/portal/redact";

export const runtime = "nodejs";

// Same visibility policy as the list route (BUILD-LOI-PORTAL).
const PORTAL_LOI_STATUSES = new Set(["sent", "accepted", "rejected", "expired"]);

/**
 * GET /api/portal/lois/[id]
 *
 * BUILD-LOI-PORTAL — fetch a single Letter of Intent addressed to the
 * logged-in portal partner. Ownership is enforced twice:
 *   1. tenant_id must match the portal session tenant (404 otherwise)
 *   2. partner_id must match the portal session partner (403 otherwise)
 *
 * Draft and cancelled LOIs are never returned to a portal client.
 *
 * The proformas module re-fetches the whole LIST to build its detail sheet
 * (with pagination that silently breaks for items beyond page 1); this
 * route is the proper REST detail endpoint the LOI UI uses instead.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const access = await getPortalSessionAccess();
    if (!access) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    if (!access.can_view_offers) {
      return NextResponse.json({ error: "Not permitted." }, { status: 403 });
    }

    const kycBlock = await requireKycApproved(access);
    if (kycBlock) return kycBlock;
    const gpsBlock = await requireGpsVerified(access);
    if (gpsBlock) return gpsBlock;

    const { id } = await params;
    const store = await getStore();
    const loi = await store.getLoi(id);
    if (!loi) {
      return NextResponse.json({ error: "LOI not found." }, { status: 404 });
    }
    if (loi.tenant_id !== access.tenant_id) {
      return NextResponse.json({ error: "LOI not found." }, { status: 404 });
    }
    if (loi.partner_id !== access.partner_id) {
      return NextResponse.json({ error: "Access denied." }, { status: 403 });
    }
    if (!PORTAL_LOI_STATUSES.has(String(loi.status || "").toLowerCase())) {
      // Draft / cancelled LOIs are invisible to portal clients — report
      // them the same way as a missing row so the endpoint leaks nothing.
      return NextResponse.json({ error: "LOI not found." }, { status: 404 });
    }

    return NextResponse.json(redactDocumentForPortal(loi as any));
  } catch (e: any) {
    console.error("[portal.lois.detail]", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
