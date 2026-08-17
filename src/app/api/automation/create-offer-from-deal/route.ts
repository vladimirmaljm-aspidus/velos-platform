import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAuthOrApiKey, requireAuthOrApiKeyPermission, audit, resolveTenantId } from "@/lib/api/helpers";
import { nextDocNumber, formatDocNumber } from "@/lib/api/doc-number";
import type { OfferLineItem } from "@/lib/supabase/types";

export const runtime = "nodejs";

/**
 * POST /api/automation/create-offer-from-deal
 *
 * Auto-create an offer from a deal:
 * - Copy deal partner, products, and pricing
 * - Auto-generate offer number
 * - Auto-fill all partner data
 * - Auto-calculate totals
 *
 * Body: { deal_id: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuthOrApiKey(req);
  if (auth instanceof NextResponse) return auth;
  // U-FIX (RBAC audit D-1): gate BOTH session AND API-key callers.
  // This automation route creates an offer — a trade document with
  // pricing and product data. Previously any API key could trigger
  // offer creation, which also flows into the monthly_documents
  // quota counter downstream. API-key callers MUST now hold
  // `offers:create` (or `*`).
  const denied = requireAuthOrApiKeyPermission(auth, "offers.create");
  if (denied) return denied;
  // Feature gate (module_trade) — creates an offer (trade document).
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_trade", _isSA); if (_f) return _f; } /* requireFeature wired */


  const tid = resolveTenantId(auth, req);
  if (!tid) {
    return NextResponse.json({ error: "Tenant ID required." }, { status: 400 });
  }

  try {
    const body = await req.json();
    const { deal_id } = body;

    if (!deal_id) {
      return NextResponse.json(
        { error: "deal_id is required." },
        { status: 400 }
      );
    }

    const store = auth.store;

    // 1. Fetch the deal
    const deal = await store.getDeal(deal_id);
    if (!deal) {
      return NextResponse.json({ error: "Deal not found." }, { status: 404 });
    }
    // Tenant ownership check (applies to both session auth and API-key auth)
    const isSuperAdmin = "user" in auth && auth.isSuperAdmin;
    if (!isSuperAdmin && deal.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Deal not found." }, { status: 404 });
    }

    // 2. Fetch partner data for auto-fill
    const partner = deal.partner_id ? await store.getPartner(deal.partner_id) : null;
    // Enrich the auto-generated line with trade metadata (HS code, brand,
    // spec, SKU) when the deal is linked to a real product — mirrors the
    // manual product picker used on the Offers view.
    const linkedProduct = deal.product_id ? await store.getProduct(deal.product_id).catch(() => null) : null;

    // 3. Auto-generate offer number (atomic via Postgres SEQUENCE; falls
    //    back to legacy `listOffers().total + 1` if the RPC is unavailable).
    //    Format: OF-<year>-<NNNN>  (4-digit sequence)
    const year = new Date().getFullYear();
    const seqNum = await nextDocNumber("offer");
    let offerNumber: string;
    if (seqNum) {
      offerNumber = seqNum;
    } else {
      const existingOffers = await store.listOffers(tid, { limit: 1 });
      const nextSeq = (existingOffers.total || 0) + 1;
      offerNumber = formatDocNumber("offer", year, nextSeq);
    }

    // 4. Build offer items from deal data. Quantity/unit come from the deal
    //    itself when set (deal.quantity, deal.unit); unit_price is derived
    //    from the deal value so the offer total matches the deal value.
    const qty = deal.quantity && deal.quantity > 0 ? deal.quantity : 1;
    const unit = deal.unit || linkedProduct?.unit || "pcs";
    const unitPrice = deal.value / qty;
    const items: OfferLineItem[] = [
      {
        product_id: linkedProduct?.id || "",
        product_name: linkedProduct?.name || deal.title,
        sku: linkedProduct?.sku || "",
        quantity: qty,
        unit,
        unit_price: unitPrice,
        discount: 0,
        tax_rate: 0,
        total: deal.value,
        hs_code: (linkedProduct as any)?.hs_code ?? null,
        description: (linkedProduct as any)?.description ?? null,
        detailed_spec: (linkedProduct as any)?.detailed_spec ?? null,
        brand: (linkedProduct as any)?.brand ?? null,
      },
    ];

    // 5. Calculate totals
    let subtotal = 0;
    let discountTotal = 0;
    let taxTotal = 0;
    for (const it of items) {
      const line = it.quantity * it.unit_price;
      const disc = line * (it.discount || 0) / 100;
      const net = line - disc;
      const tax = net * (it.tax_rate || 0) / 100;
      subtotal += line;
      discountTotal += disc;
      taxTotal += tax;
      it.total = net + tax;
    }

    const total = subtotal - discountTotal + taxTotal;

    // 6. Determine currency from partner preference or deal
    const currency = partner?.preferred_currency || deal.currency || "USD";

    // 7. Build the offer object
    const offerData = {
      tenant_id: tid,
      number: offerNumber,
      deal_id: deal.id,
      partner_id: deal.partner_id,
      owner_id: "user" in auth ? auth.user.id : null,
      status: "draft" as const,
      subject: `Offer for: ${deal.title}`,
      currency,
      subtotal,
      discount_total: discountTotal,
      tax_total: taxTotal,
      total,
      notes: `Auto-generated from deal: ${deal.title}`,
      terms: partner?.preferred_payment_terms || null,
      valid_until: new Date(
        Date.now() + 30 * 24 * 60 * 60 * 1000
      ).toISOString(),
      items,
    };

    // 8. Enforce monthly_documents quota (parity with POST /api/offers)
    //    API keys are tenant-scoped → never super-admin.
    {
      const isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
      const { enforceQuota } = await import("@/lib/api/plan-limits");
      const denied = await enforceQuota(tid, "monthly_documents", isSA);
      if (denied) return denied;
    }

    // 9. Create the offer
    const created = await store.upsertOffer(offerData);

    // 10. Audit log
    const auditUser = "user" in auth ? auth.user : { id: auth.apiKeyId, username: auth.apiKeyName, tenant_id: auth.tenantId };
    await audit(
      store,
      auditUser,
      req,
      "automation.create_offer_from_deal",
      "offer",
      created.id,
      {
        deal_id: deal.id,
        deal_title: deal.title,
        offer_number: created.number,
        partner_id: deal.partner_id,
        partner_name: partner?.name || "Unknown",
      }
    );

    return NextResponse.json(created);
  } catch (e: any) {
    console.error("[automation/create-offer-from-deal]", e);
    return NextResponse.json(
      { error: e.message || "Failed to create offer from deal." },
      { status: 500 }
    );
  }
}
