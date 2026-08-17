import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * GET /api/trade-calculator/[id]/offer-preview
 *
 * Returns a PRE-FILLED offer payload (does NOT create the offer yet) plus a
 * `filled` / `missingFields` map the UI uses to highlight fields that didn't
 * auto-fill from the trade calculation.
 *
 * Used by the Trade Calculator "Create Offer from Calculation" button to
 * open the offer form pre-filled and let the user review before saving.
 *
 * Output:
 *   {
 *     offer:         pre-filled offer payload (line items, totals, trade terms…)
 *     filled:        Record<field, boolean>  — true when the field was auto-filled
 *     missingFields: string[]                — keys whose `filled` value is false
 *     tradeCalculation: { id, name, buy_price_per_unit, sell_price_per_unit, quantity, unit }
 *   }
 *
 * The offer payload carries a handful of `_` prefixed metadata fields
 * (`_trade_calc_id`, `_commission_agent_id`, …) that are consumed by the
 * offer form's save() to auto-track commission obligations (Fix 2). The
 * POST /api/offers route strips these before persisting.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const tid = resolveTenantId(auth, req);
  if (!tid) return NextResponse.json({ error: "No tenant context." }, { status: 400 });

  const { id } = await params;
  const calc = await auth.store.getTradeCalculation(id);
  if (!calc) return NextResponse.json({ error: "Trade calculation not found." }, { status: 404 });
  // Tenant ownership check (session auth only — super-admins can read across tenants)
  if (!auth.isSuperAdmin && (calc as any).tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Trade calculation not found." }, { status: 404 });
  }

  // Pull fields safely — the TradeCalculation schema uses sell_currency /
  // buy_currency / sell_incoterm / loading_port / delivery_port, but legacy
  // rows (and trade calc UI drafts) sometimes also carry the short-named
  // variants. We prefer the typed column, then fall back to the alias.
  const c = calc as any;
  const partnerId: string | null =
    c.partner_id || c.buyer_id || null;
  const currency: string = c.currency || c.sell_currency || "USD";
  const qty: number = Number(c.quantity) || 0;
  const unit: string = c.unit || "MT";
  const sellPrice: number = Number(c.sell_price_per_unit) || 0;
  const buyPrice: number = Number(c.buy_price_per_unit) || 0;
  const totalSell: number = Number(c.total_sell_revenue) || qty * sellPrice;

  // ── Fetch the product catalog entry for REAL product data ────────────
  // Mirrors /api/trade-calculator/[id]/create-offer — the calc.product_id
  // points at a product_catalog row (not the products table). Fall back to
  // the products table if the catalog lookup misses (older data).
  let productName = (c.product_name && c.product_name !== "Product")
    ? c.product_name
    : (c.name as string) || "Product";
  let productSku = "";
  let productHsCode: string | null = null;
  let productOrigin: string | null = null;
  let productSpecs: any = null;

  const productId: string | null = c.product_id || c.product_catalog_id || null;
  if (productId) {
    try {
      const catalogEntry = await auth.store.getProductCatalogEntry(productId);
      if (catalogEntry) {
        productName = catalogEntry.name || productName;
        productSku = catalogEntry.sku || "";
        productHsCode = catalogEntry.hs_code ?? null;
        productOrigin = catalogEntry.origin_country ?? null;
        productSpecs = catalogEntry.specifications ?? null;
      } else {
        // Fall back to the products table for older calc rows that stored a
        // Product id rather than a ProductCatalogEntry id.
        try {
          const product = await auth.store.getProduct(productId);
          if (product) {
            productName = product.name || productName;
            productSku = product.sku || "";
            productHsCode = (product as any).hs_code ?? null;
            productOrigin = (product as any).origin_country ?? null;
            productSpecs = (product as any).coa_params ?? null;
          }
        } catch { /* ignore — keep defaults */ }
      }
    } catch { /* ignore — keep defaults */ }
  }

  // Resolve trade-term aliases: incoterm, pol, pod, payment_terms.
  const incoterm: string | null =
    c.incoterm || c.sell_incoterm || c.buy_incoterm || null;
  const pol: string | null = c.pol || c.loading_port || null;
  const pod: string | null = c.pod || c.delivery_port || null;
  const paymentTerms: string | null = c.payment_terms || null;

  // Determine which fields are FILLED vs MISSING — the offers-view form
  // uses this set to paint missing inputs with an orange border + tooltip.
  const filled: Record<string, boolean> = {
    partner_id: !!partnerId,
    product_name: !!productName && productName !== "Product",
    product_id: !!productId,
    sku: !!productSku,
    hs_code: !!productHsCode,
    origin_country: !!productOrigin,
    specifications: !!productSpecs,
    quantity: qty > 0,
    unit: !!unit,
    sell_price: sellPrice > 0,
    incoterm: !!incoterm,
    pol: !!pol,
    pod: !!pod,
    payment_terms: !!paymentTerms,
    currency: !!currency,
  };

  const missingFields: string[] = Object.entries(filled)
    .filter(([, isFilled]) => !isFilled)
    .map(([field]) => field);

  // Build the pre-filled offer. The `_` prefixed fields carry trade calc
  // metadata used downstream by POST /api/offers to auto-track commission
  // obligations. The offer form's save() passes them through verbatim; the
  // /api/offers POST strips them before upsert.
  const offerPreview = {
    partner_id: partnerId,
    subject: `Offer: ${productName} — ${qty} ${unit}`,
    currency,
    items: [{
      product_id: productId || "",
      product_name: productName,
      sku: productSku,
      quantity: qty,
      unit,
      unit_price: sellPrice,
      discount: 0,
      tax_rate: 0,
      total: totalSell,
      hs_code: productHsCode,
      origin_country: productOrigin,
      specifications: productSpecs,
    }],
    subtotal: totalSell,
    discount_total: 0,
    tax_total: 0,
    total: totalSell,
    incoterm,
    pol,
    pod,
    payment_terms: paymentTerms,
    valid_until: new Date(Date.now() + 30 * 86400000).toISOString(),
    notes: "",
    // Trade calc metadata for commission tracking (stripped before persist).
    // These now read from the live `trade_calculations.commission_*` columns
    // added in migration 007 — they were previously always null/0 because the
    // columns didn't exist on the live schema (Re-Audit-2 N11). When the calc
    // has `commission_agent_id` set, the auto-track commission block in POST
    // /api/offers fires → commission obligation created on accept.
    _trade_calc_id: id,
    _commission_agent_id: c.commission_agent_id || null,
    _commission_type: c.commission_type || null,
    _commission_rate: Number(c.commission_rate) || 0,
    _commission_amount: Number((c as any).commission_amount) || 0,
    _buy_price_per_unit: buyPrice,
    _buy_currency: c.buy_currency || currency,
    _landed_cost: Number(c.total_landed_cost) || 0,
    _margin: (sellPrice - buyPrice) * qty,
  };

  return NextResponse.json({
    offer: offerPreview,
    filled,
    missingFields,
    tradeCalculation: {
      id,
      name: c.name,
      buy_price_per_unit: buyPrice,
      sell_price_per_unit: sellPrice,
      quantity: qty,
      unit,
    },
  });
}
