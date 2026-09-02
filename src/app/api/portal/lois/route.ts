import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { requireGpsVerified } from "@/lib/portal/require-gps";
import { getStore } from "@/lib/data/store";
import { redactListForPortal } from "@/lib/portal/redact";

export const runtime = "nodejs";

// BUILD-LOI-PORTAL — which LOI statuses a portal client (the SELLER who
// received the Letter of Intent) may see. Mirrors the proforma policy:
//   • draft       — hidden (the buyer is still editing it)
//   • cancelled   — hidden (the buyer withdrew the LOI before/after sending;
//                   showing a withdrawn document to the seller invites
//                   confusion — the email recipient already got it, but the
//                   portal is the *current* source of truth)
//   • sent        — visible + respondable (accept / reject)
//   • accepted / rejected / expired — visible, read-only history
const PORTAL_LOI_STATUSES = new Set(["sent", "accepted", "rejected", "expired"]);

/**
 * GET /api/portal/lois
 *
 * BUILD-LOI-PORTAL — list Letters of Intent addressed to the logged-in
 * portal partner. The partner is the SELLER / recipient of the LOI; the
 * tenant (the portal owner's customer) is the BUYER / issuing party.
 *
 * Gated on `can_view_offers` (trade documents the client can see — the
 * same family as offers; portal_access has no dedicated can_view_lois
 * flag, and adding a column would require a portal_access migration +
 * admin permission UI for a single document type).
 *
 * Supports ?limit=&offset= pagination (default 50, hard ceiling 200).
 * `total` is the true count so the UI can render "Load more".
 */
export async function GET(req: NextRequest) {
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
    const store = await getStore();

    // Pagination params (2b2-F4 parity with portal proformas).
    const limitParam = Number.parseInt(req.nextUrl.searchParams.get("limit") || "", 10);
    const offsetParam = Number.parseInt(req.nextUrl.searchParams.get("offset") || "", 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 50;
    const offset = Number.isFinite(offsetParam) && offsetParam >= 0 ? offsetParam : 0;

    const result = await store.listLois(access.tenant_id, {
      filters: {
        partner_id: access.partner_id,
      },
      limit,
      offset,
    });

    // Defense-in-depth: strip drafts + cancelled even if the store returns
    // them (status filter is applied post-fetch because listLois only
    // supports a single status value, not a set).
    const visible = (result.items || []).filter((l) =>
      PORTAL_LOI_STATUSES.has(String(l.status || "").toLowerCase()),
    );

    return NextResponse.json(
      redactListForPortal({ ...result, items: visible, total: result.total }),
    );
  } catch (e: any) {
    console.error("[portal.lois]", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
