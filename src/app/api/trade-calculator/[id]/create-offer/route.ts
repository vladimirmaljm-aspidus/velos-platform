import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAuthOrApiKey, requireAuthOrApiKeyPermission, audit, resolveTenantId } from "@/lib/api/helpers";
import { nextDocNumber, formatDocNumber } from "@/lib/api/doc-number";

export const runtime = "nodejs";

/**
 * POST /api/trade-calculator/[id]/create-offer
 *
 * Creates a new offer from a saved trade calculation.
 *
 * CRITICAL RULES:
 *   1. Product name MUST come from the product catalog entry (not calc.name)
 *   2. Buy cost, landed cost, margin — NEVER included in the offer (internal only)
 *   3. Offer notes contain only client-facing info (product specs, origin, delivery)
 *   4. Subject uses the actual product name, not the calc name
 *
 * Pre-fills:
 *   - partner_id (from calc.partner_id or calc.buyer_id or body.partner_id)
 *   - currency, quantity, unit, sell price
 *   - product name, specs, origin country from the catalog entry
 *   - incoterm, payment_terms, pol, pod
 *
 * Body (optional overrides):
 *   partner_id, valid_until, payment_terms, notes
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;
    // U-FIX (RBAC audit D-1): gate BOTH session AND API-key callers.
    // POST creates an offer from a trade calc — `offers.create` is the
    // narrower / more accurate permission for the resulting entity, but
    // the route has historically been gated by `trade-calculator.create`.
    // Both are accepted by `can()` for admins (implicit), so session
    // callers see no behavior change; API-key callers must now hold
    // `trade-calculator:create` (or `*`).
    const denied = requireAuthOrApiKeyPermission(auth, "trade-calculator.create");
    if (denied) return denied;
    // Feature gate (module_trade)
    { const { requireFeature } = await import("@/lib/api/feature-guard");
      const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
      const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
      const _f = await requireFeature(_tid, "module_trade", _isSA); if (_f) return _f; } /* requireFeature wired */

    const tenantId = resolveTenantId(auth, req);
    if (!tenantId) return NextResponse.json({ error: "No tenant context." }, { status: 400 });

    const { id } = await params;
    const calc = await auth.store.getTradeCalculation(id);
    if (!calc) return NextResponse.json({ error: "Trade calculation not found." }, { status: 404 });
    // CRITICAL FIX (audit T-2): tenant ownership check must cover BOTH auth
    // modes. Previously the `"user" in auth && !auth.isSuperAdmin` guard
    // skipped the check entirely for API key auth (which has no `isSuperAdmin`
    // property) — so an API key from tenant A could create offers from
    // tenant B's trade calculations.
    const isSuperAdmin = "user" in auth && auth.isSuperAdmin;
    if (!isSuperAdmin && (calc as any).tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Trade calculation not found." }, { status: 404 });
    }

    let body: {
      partner_id?: string;
      valid_until?: string;
      payment_terms?: string;
      notes?: string;
    } = {};
    try { body = await req.json(); } catch { /* empty body ok */ }

    // Resolve partner_id — check body, then calc.partner_id, then calc.buyer_id
    const partnerId = body.partner_id || (calc as any).partner_id || (calc as any).buyer_id;
    if (!partnerId) {
      return NextResponse.json(
        { error: "Partner ID is required. Specify a partner in the body or save the calculation with a buyer/partner." },
        { status: 400 }
      );
    }

    const currency = (calc as any).currency || "USD";
    const qty = (calc as any).quantity || 0;
    const unit = (calc as any).unit || "MT";
    const sellPrice = (calc as any).sell_price_per_unit || 0;
    const totalSell = (calc as any).total_sell_revenue || qty * sellPrice;

    // ── Fetch the product catalog entry for REAL product data ────────────
    // The calc.product_id can be EITHER:
    //   - a nanoid from product_catalog (legacy rows migrated from the old
    //     catalog table), OR
    //   - a UUID from products (the norm going forward — Task 2 / commit
    //     ad65507 dropped the trade_calculations.product_id FK so UUIDs from
    //     the products table are now allowed).
    // We try product_catalog first, then fall back to products — mirroring
    // /api/trade-calculator/[id]/offer-preview/route.ts.
    let productName = "Product";
    let productSku = "";
    let productHsCode: string | null = null;
    let productOrigin: string | null = null;
    let productSpecs: any = null;
    let productCategory: string | null = null;
    let catalogEntryData: any = null;
    let productRowData: any = null;

    const productId = (calc as any).product_id || (calc as any).product_catalog_id;
    if (productId) {
      try {
        catalogEntryData = await auth.store.getProductCatalogEntry(productId);
        if (catalogEntryData) {
          productName = catalogEntryData.name;
          // FIX (audit T-3): previously productSku was never populated, so the
          // created offer's line item always had sku="" even when the catalog
          // entry had one. Mirror offer-preview which sets productSku here.
          productSku = catalogEntryData.sku || "";
          productHsCode = catalogEntryData.hs_code;
          productOrigin = catalogEntryData.origin_country;
          productSpecs = catalogEntryData.specifications;
          productCategory = catalogEntryData.category;
        } else {
          // FIX (audit T-3): fall back to the products table for calc rows
          // whose product_id is a UUID from products (post-FK-drop norm).
          // Without this, productName stayed "Product" and the created offer
          // showed "Offer: Product — 100 MT" instead of the real product name.
          try {
            productRowData = await auth.store.getProduct(productId);
            if (productRowData) {
              productName = productRowData.name || productName;
              productSku = productRowData.sku || "";
              productHsCode = (productRowData as any).hs_code ?? null;
              // products table has no origin_country column — read from
              // attributes.origin_country (the documented workaround).
              productOrigin = (productRowData as any).origin_country
                ?? ((productRowData as any).attributes?.origin_country ?? null);
              productSpecs = (productRowData as any).coa_params ?? null;
              productCategory = (productRowData as any).category ?? null;
            }
          } catch { /* ignore — keep defaults */ }
        }
      } catch { /* ignore — fallback to calc data */ }
    }

    // Fallback: if no catalog entry AND no product row, use calc.product_name
    // (NOT calc.name — calc.name is the calc title like "Q4 Cement Deal").
    if (productName === "Product" && (calc as any).product_name) {
      productName = (calc as any).product_name;
    }

    // Build line item with real product data
    // FIX (audit F-19): include ALL trade metadata fields so PDFs and
    // downstream automation (proforma/invoice) have complete data.
    const items = [{
      product_id: productId || null,
      product_name: productName,
      sku: productSku || "",
      quantity: qty,
      unit,
      unit_price: sellPrice,
      discount: 0,
      tax_rate: 0,
      // CRITICAL FIX (audit F-4): round to 2 decimals to avoid floating-point
      // drift (e.g. 1199.9999999998) being persisted as the line total.
      total: Math.round(totalSell * 100) / 100,
      // FIX (audit F-19): trade metadata — previously dropped, causing
      // PDFs to show "—" for HS Code, Origin, Brand, Specifications.
      hs_code: productHsCode || null,
      origin_country: productOrigin || null,
      // FIX (audit T-3): fall back to productRowData for brand/detailed_spec/
      // description when the catalog entry wasn't found (UUID product_id case).
      brand: catalogEntryData?.brand ?? productRowData?.brand ?? null,
      detailed_spec: catalogEntryData?.detailed_spec ?? productRowData?.detailed_spec ?? null,
      specifications: productSpecs || null,
      description: catalogEntryData?.description ?? productRowData?.description ?? null,
    }];

    // ── Build CLIENT-FACING notes ────────────────────────────────────────
    // NEVER include buy cost, landed cost, or margin — those are internal.
    // Only include product info, specifications, origin, delivery terms.
    let notes = body.notes || "";
    if (!notes) {
      const specLines: string[] = [];
      if (productSpecs) {
        const rawSpecs = productSpecs as unknown;
        if (Array.isArray(rawSpecs)) {
          for (const s of rawSpecs as { name: string; value: string }[]) {
            specLines.push(`  ${s.name}: ${s.value}`);
          }
        } else if (typeof rawSpecs === "object" && rawSpecs !== null) {
          for (const [k, v] of Object.entries(rawSpecs as Record<string, string>)) {
            specLines.push(`  ${k}: ${v}`);
          }
        }
      }

      notes = [
        `Product: ${productName}`,
        productHsCode ? `HS Code: ${productHsCode}` : null,
        productOrigin ? `Origin: ${productOrigin}` : null,
        productCategory ? `Category: ${productCategory}` : null,
        `Quantity: ${qty} ${unit}`,
        specLines.length > 0 ? `\nSpecifications:\n${specLines.join("\n")}` : null,
        (calc as any).incoterm ? `\nIncoterm: ${(calc as any).incoterm}` : null,
        (calc as any).pol ? `Loading port: ${(calc as any).pol}` : null,
        (calc as any).pod ? `Discharge port: ${(calc as any).pod}` : null,
        (calc as any).lead_time ? `Lead time: ${(calc as any).lead_time}` : null,
        (calc as any).packaging ? `Packaging: ${(calc as any).packaging}` : null,
      ].filter(Boolean).join("\n");
    }

    // Generate offer number (atomic via Postgres SEQUENCE; falls back to
    // legacy `listOffers().total + 1` if the RPC is unavailable).
    // Format: OF-<year>-<NNNN>  (4-digit sequence)
    //
    // Re-Audit-2 P0-2 / N10: the fallback filter previously used `/${year}`
    // (slash) but `formatDocNumber("offer", year, nextSeq)` produces
    // `OF-${year}-${seq}` (dashes) → the filter never matched → every fallback
    // call minted `OF-2025-0001` → unique-constraint 500 on the second call.
    // Fixed to filter on the actual `OF-${year}-` prefix.
    const year = new Date().getFullYear();
    // FIX-PRODUCTS-DOCS / Fix 3 — pass `tenantId` so nextDocNumber uses
    // the per-tenant RPC (migration 063). Previously called without a
    // tenantId → fell through to the GLOBAL sequence → cross-tenant
    // number leak risk + EU VAT compliance issue.
    const seqNum = await nextDocNumber("offer", tenantId);
    let offerNumber: string;
    if (seqNum) {
      offerNumber = seqNum;
    } else {
      // Loop with retry-on-collision: try to find the next available sequence
      // by inspecting existing offers for this year + tenant. We attempt up to
      // 10 inserts before bailing (defense in depth against persistent
      // collisions under heavy concurrent load).
      const offerYearPrefix = `OF-${year}-`;
      for (let attempt = 0; attempt < 10; attempt++) {
        const existingOffers = await auth.store.listOffers(tenantId, { limit: 1000 });
        const yearOffers = existingOffers.items.filter((o: any) =>
          typeof o.number === "string" && o.number.startsWith(offerYearPrefix),
        );
        const nextSeq = yearOffers.length + 1 + attempt;
        const candidate = formatDocNumber("offer", year, nextSeq);
        // Quick uniqueness check: if no existing offer has this exact number,
        // we can use it.
        const collision = yearOffers.some((o: any) => o.number === candidate);
        if (!collision) {
          offerNumber = candidate;
          break;
        }
      }
      if (!offerNumber!) {
        // All 10 attempts collided — fall back to a UUID-suffixed number to
        // guarantee uniqueness. (This branch is essentially unreachable in
        // practice but keeps the route safe against pathological collisions.)
        const { randomUUID } = await import("node:crypto");
        offerNumber = `OF-${year}-${randomUUID().slice(0, 8)}`;
      }
    }

    // Re-Audit-2 N11 / Fix 1: persist trade calc commission metadata on the
    // offer so the downstream "auto-track commission on accept" block in
    // POST /api/offers fires when BOTH `_trade_calc_id` AND
    // `_commission_agent_id` are present. The offer-preview route already
    // emits these fields; the create-offer route was bypassing them.
    //
    // Note: the `_` prefixed fields are NOT real columns on the `offers` table
    // — they're stripped from the offerData below before calling upsertOffer
    // (otherwise PostgREST rejects the insert with a "column does not exist"
    // error). They're kept here so we can run the same commission cascade
    // logic that POST /api/offers runs after upserting the offer.
    const c = calc as any;
    const tradeCalcMeta = {
      _trade_calc_id: id,
      _commission_agent_id: c.commission_agent_id || null,
      _commission_type: c.commission_type || null,
      _commission_rate: Number(c.commission_rate) || 0,
      _commission_amount: Number(c.commission_amount) || 0,
      _buy_price_per_unit: Number(c.buy_price_per_unit) || 0,
      _buy_currency: c.buy_currency || currency,
      _landed_cost: Number(c.total_landed_cost) || 0,
      _margin: ((Number(c.sell_price_per_unit) || 0) - (Number(c.buy_price_per_unit) || 0)) * qty,
    };

    // Subject uses the actual product name (NOT calc.name)
    const subject = `Offer: ${productName} — ${qty} ${unit}`;

    const offerData: any = {
      tenant_id: tenantId,
      number: offerNumber,
      partner_id: partnerId,
      owner_id: "user" in auth ? auth.user.id : null,
      status: "draft",
      subject,
      currency,
      // CRITICAL FIX (audit F-4): round all currency totals to 2 decimals to
      // avoid floating-point drift in stored offer records.
      subtotal: Math.round(totalSell * 100) / 100,
      discount_total: Math.round(0 * 100) / 100,
      tax_total: Math.round(0 * 100) / 100,
      total: Math.round(totalSell * 100) / 100,
      items,
      notes,
      valid_until: body.valid_until || new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0],
      payment_terms: body.payment_terms || (calc as any).payment_terms || "net30",
      incoterm: (calc as any).incoterm || "CIF",
      pol: (calc as any).pol || null,
      pod: (calc as any).pod || null,
    };

    const created = await auth.store.upsertOffer(offerData);

    // Re-Audit-2 N11: when the trade calc has BOTH a `_trade_calc_id` AND a
    // `_commission_agent_id`, mirror the cascade that POST /api/offers runs —
    // find-or-create a Deal linked to this offer, then insert a pending
    // `deal_commissions` row. Fire-and-forget: failures are logged + audited
    // but don't fail the offer creation (the user can still create the
    // commission manually from the deals view).
    if (tradeCalcMeta._trade_calc_id && tradeCalcMeta._commission_agent_id) {
      try {
        const { getSupabase } = await import("@/lib/supabase/client");
        const sb = getSupabase();

        // 1. Find or create a deal for this offer.
        let dealId: string | null = (created as any).deal_id || null;
        if (!dealId) {
          const dealRow = {
            tenant_id: tenantId,
            title: (created as any).subject || `Deal for ${(created as any).number}`,
            partner_id: (created as any).partner_id,
            owner_id: "user" in auth ? auth.user.id : null,
            stage: "qualified",
            value: (created as any).total,
            currency: (created as any).currency,
            buy_cost: tradeCalcMeta._landed_cost || 0,
            quantity: ((created as any).items?.[0]?.quantity) || 0,
            unit: ((created as any).items?.[0]?.unit) || "MT",
            commission_agent_id: tradeCalcMeta._commission_agent_id,
          };
          const { data: deal, error: dealErr } = await sb
            .from("deals")
            .insert(dealRow)
            .select()
            .maybeSingle();
          if (dealErr) throw dealErr;
          dealId = deal?.id || null;

          if (dealId) {
            await sb.from("offers").update({ deal_id: dealId }).eq("id", (created as any).id);
            (created as any).deal_id = dealId;
          }
        }

        // 2. Create pending commission record (mirror POST /api/offers logic).
        if (dealId) {
          let commissionType = tradeCalcMeta._commission_type;
          let commissionRate = tradeCalcMeta._commission_rate;
          let commissionCurrency = (created as any).currency || "USD";
          let commissionPerUnit = 0;
          let agentPartnerId: string | null = null;
          try {
            const { data: agent } = await sb
              .from("commission_agents")
              .select("*")
              .eq("id", tradeCalcMeta._commission_agent_id!)
              .maybeSingle();
            if (agent) {
              commissionType = commissionType || (agent as any).commission_type;
              commissionRate = commissionRate || Number((agent as any).commission_rate) || 0;
              commissionPerUnit = Number((agent as any).commission_per_unit) || 0;
              commissionCurrency = (agent as any).commission_currency || commissionCurrency;
              agentPartnerId = (agent as any).partner_id || null;
            }
          } catch { /* keep defaults */ }

          const dealValue = Number((created as any).total) || 0;
          const dealProfit = Number(tradeCalcMeta._margin) || 0;
          let calculatedCommission = tradeCalcMeta._commission_amount;
          if (!calculatedCommission) {
            switch (commissionType) {
              case "profit_percent":
                calculatedCommission = (dealProfit * commissionRate) / 100;
                break;
              case "revenue_percent":
                calculatedCommission = (dealValue * commissionRate) / 100;
                break;
              case "per_unit":
                calculatedCommission =
                  commissionPerUnit * (Number((created as any).items?.[0]?.quantity) || 0);
                break;
              case "fixed":
                calculatedCommission = commissionRate;
                break;
              default:
                calculatedCommission = 0;
            }
          }

          const commissionRow = {
            tenant_id: tenantId,
            deal_id: dealId,
            agent_id: tradeCalcMeta._commission_agent_id,
            partner_id: agentPartnerId,
            commission_type: commissionType || "profit_percent",
            commission_rate: commissionRate,
            commission_per_unit: commissionPerUnit,
            commission_custom_formula: null,
            commission_currency: commissionCurrency,
            deal_value: dealValue,
            deal_profit: dealProfit,
            deal_quantity: Number((created as any).items?.[0]?.quantity) || 0,
            deal_unit: ((created as any).items?.[0]?.unit) || "MT",
            calculated_commission: Number(calculatedCommission) || 0,
            status: "pending",
            notes: `Auto-created from trade calculation ${tradeCalcMeta._trade_calc_id}`,
          };
          const { error: commErr } = await sb
            .from("deal_commissions")
            .insert(commissionRow);
          if (commErr) throw commErr;

          try {
            const auditUser = "user" in auth ? auth.user : { id: auth.apiKeyId, username: auth.apiKeyName, tenant_id: auth.tenantId };
            await audit(auth.store, auditUser as any, req, "commission.obligation_created", "deal_commission", dealId, {
              agent_id: tradeCalcMeta._commission_agent_id,
              amount: calculatedCommission,
              trade_calc_id: tradeCalcMeta._trade_calc_id,
              offer_id: (created as any).id,
              offer_number: (created as any).number,
              source: "trade-calculator/create-offer",
            });
          } catch (auditErr) {
            console.warn("[create-offer] commission audit failed:", auditErr);
          }
        }
      } catch (e) {
        // Don't fail the offer creation — log + audit.
        console.error("[create-offer] commission cascade failed:", e);
      }
    }
    const auditUser = "user" in auth ? auth.user : { id: auth.apiKeyId, username: auth.apiKeyName, tenant_id: auth.tenantId };
    await audit(auth.store, auditUser, req, "offer.create_from_calc", "offer", created.id, {
      trade_calc_id: id,
      offer_number: created.number,
      product_name: productName,
      total: created.total,
    });

    return NextResponse.json(created);
  } catch (e: any) {
    console.error("[trade-calculator.create-offer.POST]", e);
    return NextResponse.json({ error: e?.message || "Internal server error." }, { status: 500 });
  }
}
