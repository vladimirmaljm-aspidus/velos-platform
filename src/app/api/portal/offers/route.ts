import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { requireGpsVerified } from "@/lib/portal/require-gps";
import { getStore } from "@/lib/data/store";
import { redactListForPortal } from "@/lib/portal/redact";
import { sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

// Portal clients must never see draft offers — those haven't been sent yet.
// Allowed: sent | viewed | accepted | rejected | expired
const PORTAL_OFFER_STATUSES = new Set(["sent", "viewed", "accepted", "rejected", "expired"]);

// Portal: list offers for the logged-in partner
export async function GET(req: NextRequest) {
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

  // 2b2-F4 — accept ?limit=&offset= so the portal UI can paginate.
  // Previously the route passed no params to `listOffers`, so the store
  // used `paginateQuery`'s default cap of 50 — silently truncating a
  // partner's offer history at 50 rows. The UI had no "Load more"
  // affordance, so older offers were invisible. The hard ceiling is
  // 200 (single partner rarely has >200 visible offers; tenants with
  // heavy volume should rely on the search + status filters rather
  // than unbounded list).
  const url = new URL(req.url);
  const limitParam = Number.parseInt(url.searchParams.get("limit") || "", 10);
  const offsetParam = Number.parseInt(url.searchParams.get("offset") || "", 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 50;
  const offset = Number.isFinite(offsetParam) && offsetParam >= 0 ? offsetParam : 0;

  const result = await store.listOffers(access.tenant_id, {
    filters: { partner_id: access.partner_id },
    limit,
    offset,
  });
  // Defense-in-depth: strip drafts (and any other internal-only status) before
  // returning to the portal client. The store layer doesn't yet expose a
  // "status IN (...)" filter, so we apply it here on the result set.
  const visible = (result.items || []).filter((o) => PORTAL_OFFER_STATUSES.has(String(o.status || "").toLowerCase()));
  // 2b2-F4 — return the original `total` from `paginateQuery` so the UI
  // can show "Load more" when items.length < total. We can't simply use
  // `visible.length` because the store's count includes draft offers the
  // portal can't see — but the difference is small in practice (drafts
  // are rare once an offer is sent) and the pagination control stops
  // fetching once the store returns a short page.
  return NextResponse.json(redactListForPortal({ ...result, items: visible, total: result.total }));
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error)}, { status: 500 });
  }
}
