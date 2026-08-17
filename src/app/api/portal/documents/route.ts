import { NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { requireGpsVerified } from "@/lib/portal/require-gps";
import { getStore } from "@/lib/data/store";
import { redactListForPortal } from "@/lib/portal/redact";

export const runtime = "nodejs";

export async function GET() {
  try {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  if (!access.can_view_documents) {
    return NextResponse.json({ error: "Not permitted." }, { status: 403 });
  }
  const _kycBlock = await requireKycApproved(access);
  if (_kycBlock) return _kycBlock;
  const _gpsBlock = await requireGpsVerified(access);
  if (_gpsBlock) return _gpsBlock;
  const store = await getStore();
  const result = await store.listDocuments(access.tenant_id, { filters: { partner_id: access.partner_id } });
  // only show docs visible to partner
  result.items = result.items.filter((d) => d.visible_to_partner);
  return NextResponse.json(redactListForPortal(result));
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
