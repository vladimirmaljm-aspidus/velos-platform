import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { requireGpsVerified } from "@/lib/portal/require-gps";
import { getStore } from "@/lib/data/store";
import { redactListForPortal } from "@/lib/portal/redact";

export const runtime = "nodejs";

// Portal clients must never see draft offers — those haven't been sent yet.
// Allowed: sent | viewed | accepted | rejected | expired
const PORTAL_OFFER_STATUSES = new Set(["sent", "viewed", "accepted", "rejected", "expired"]);

// Portal: list offers for the logged-in partner
export async function GET() {
  try {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  if (!access.can_view_offers) {
    return NextResponse.json({ error: "Not permitted." }, { status: 403 });
  }
  const _kycBlock = await requireKycApproved(access);
  if (_kycBlock) return _kycBlock;
  const _gpsBlock = await requireGpsVerified(access);
  if (_gpsBlock) return _gpsBlock;
  const store = await getStore();
  const result = await store.listOffers(access.tenant_id, { filters: { partner_id: access.partner_id } });
  // Defense-in-depth: strip drafts (and any other internal-only status) before
  // returning to the portal client. The store layer doesn't yet expose a
  // "status IN (...)" filter, so we apply it here on the result set.
  const visible = (result.items || []).filter((o) => PORTAL_OFFER_STATUSES.has(String(o.status || "").toLowerCase()));
  return NextResponse.json(redactListForPortal({ ...result, items: visible, total: visible.length }));
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
