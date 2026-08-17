import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * GET /api/automation/partner-context?partner_id=xxx&tenant_id=xxx
 *
 * When a partner is selected, return ALL related data in one response
 * to minimize frontend round-trips and enable auto-fill.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (dashboard.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "dashboard.read"); if (_d) return _d; } /* requirePermission wired */


  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) return NextResponse.json({ items: [], total: 0 });

  const url = new URL(req.url);
  const partnerId = url.searchParams.get("partner_id");
  if (!partnerId) {
    return NextResponse.json({ error: "partner_id is required." }, { status: 400 });
  }

  try {
    const store = auth.store;

    // 1. Partner details
    const partner = await store.getPartner(partnerId);
    if (!partner) {
      return NextResponse.json({ error: "Partner not found." }, { status: 404 });
    }
    // Tenant scope check: partner must belong to the resolved tenant
    if (partner.tenant_id !== tenantId) {
      return NextResponse.json({ error: "Partner not found." }, { status: 404 });
    }

    // 2. Recent deals with this partner
    const deals = await store.listDeals(tenantId, {
      limit: 10,
      filters: { partner_id: partnerId },
    });

    // 3. Recent offers to this partner
    const offers = await store.listOffers(tenantId, {
      limit: 10,
      filters: { partner_id: partnerId },
    });

    // 4. Recent invoices for this partner
    const invoices = await store.listInvoices(tenantId, {
      limit: 10,
      filters: { partner_id: partnerId },
    });

    // 5. Product catalog entries relevant to this partner
    const productCatalog = await store.listProductCatalog(tenantId, { limit: 50 });

    // 6. Supplier offers from this partner
    const supplierOffers = await store.listSupplierOffers(tenantId, {
      limit: 20,
      filters: { supplier_id: partnerId },
    });

    // 7. Portal access status
    const portalAccess = await store.getPortalAccessByPartner(partnerId);

    // 8. KYC status
    const kycSubmission = await store.getKycSubmissionByPartner(partnerId);

    // 9. Trade calculations involving this partner
    const tradeCalculations = await store.listTradeCalculations(tenantId, {
      limit: 10,
      filters: { supplier_id: partnerId },
    });

    // Also check as buyer
    const tradeCalculationsAsBuyer = await store.listTradeCalculations(tenantId, {
      limit: 10,
      filters: { buyer_id: partnerId },
    });

    // 10. Proformas for this partner
    const proformas = await store.listProformas(tenantId, {
      limit: 10,
      filters: { partner_id: partnerId },
    });

    // 11. Inventory movements
    const inventoryMovements = await store.listInventory(tenantId, partnerId);

    return NextResponse.json({
      partner,
      deals: deals.items,
      offers: offers.items,
      invoices: invoices.items,
      proformas: proformas.items,
      productCatalog: productCatalog.items,
      supplierOffers: supplierOffers.items,
      portalAccess,
      kyc: kycSubmission
        ? {
            status: kycSubmission.status,
            submitted_at: kycSubmission.submitted_at,
            reviewed_at: kycSubmission.reviewed_at,
            review_notes: kycSubmission.review_notes,
          }
        : null,
      tradeCalculations: [
        ...tradeCalculations.items,
        ...tradeCalculationsAsBuyer.items,
      ],
      inventoryMovements,
    });
  } catch (e) {
    console.error("[automation/partner-context]", e);
    return NextResponse.json(
      { error: "Failed to load partner context." },
      { status: 500 }
    );
  }
}
