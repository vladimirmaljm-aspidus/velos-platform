import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { requireGpsVerified } from "@/lib/portal/require-gps";
import { getStore } from "@/lib/data/store";
import { redactListForPortal } from "@/lib/portal/redact";
import { sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

// 2b2-F4 — accept ?limit=&offset= for pagination. Default 50, hard
// ceiling 200. The `total` field in the response envelope is the true
// count so the UI can show "Load more".
export async function GET(req: NextRequest) {
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

  // 2b2-F4 — pagination params.
  const url = new URL(req.url);
  const limitParam = Number.parseInt(url.searchParams.get("limit") || "", 10);
  const offsetParam = Number.parseInt(url.searchParams.get("offset") || "", 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 50;
  const offset = Number.isFinite(offsetParam) && offsetParam >= 0 ? offsetParam : 0;

  const result = await store.listDocuments(access.tenant_id, {
    filters: { partner_id: access.partner_id },
    limit,
    offset,
  });
  // only show docs visible to partner
  result.items = result.items.filter((d) => d.visible_to_partner);
  // 2b2-F4 — return the original `total` from `paginateQuery` so the
  // UI can show "Load more" when items.length < total. The visible
  // filter strips docs marked `visible_to_partner=false`, so the
  // returned items.length may be less than total — the pagination
  // control stops fetching once the store returns a short page.
  return NextResponse.json(redactListForPortal({ ...result, total: result.total }));
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error)}, { status: 500 });
  }
}
