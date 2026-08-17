import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { requireGpsVerified } from "@/lib/portal/require-gps";
import { getStore } from "@/lib/data/store";
import { redactListForPortal } from "@/lib/portal/redact";

export const runtime = "nodejs";

// Portal clients must never see draft invoices. Allowed:
// sent | viewed | paid | overdue | cancelled (and the optional "partial" used by the
// record-payment flow).
const PORTAL_INVOICE_STATUSES = new Set(["sent", "viewed", "paid", "overdue", "cancelled", "partial"]);

/**
 * GET /api/portal/invoices
 *
 * List invoices for the logged-in portal partner.
 * Supports optional ?status= filter parameter.
 */
export async function GET(req: NextRequest) {
  try {
    const access = await getPortalSessionAccess();
    if (!access) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    if (!access.can_view_invoices) {
      return NextResponse.json({ error: "Not permitted." }, { status: 403 });
    }

    const statusFilter = req.nextUrl.searchParams.get("status") || undefined;
    // If the client requests a status explicitly, still block drafts.
    if (statusFilter && !PORTAL_INVOICE_STATUSES.has(String(statusFilter).toLowerCase())) {
      return NextResponse.json({ error: "Not permitted." }, { status: 403 });
    }

    const _kycBlock = await requireKycApproved(access);
  if (_kycBlock) return _kycBlock;
  const _gpsBlock = await requireGpsVerified(access);
  if (_gpsBlock) return _gpsBlock;
  const store = await getStore();
    const result = await store.listInvoices(access.tenant_id, {
      filters: {
        partner_id: access.partner_id,
        ...(statusFilter ? { status: statusFilter } : {}),
      },
    });

    // Defense-in-depth: strip drafts even if the store returns them.
    const visible = (result.items || []).filter((i) =>
      PORTAL_INVOICE_STATUSES.has(String(i.status || "").toLowerCase())
    );

    return NextResponse.json(redactListForPortal({ ...result, items: visible, total: visible.length }));
  } catch (e: any) {
    console.error("[portal.invoices]", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
