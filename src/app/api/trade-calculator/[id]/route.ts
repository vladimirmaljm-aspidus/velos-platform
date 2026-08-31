import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKey, requireAuthOrApiKeyPermission, audit, resolveTenantId, sanitizeError } from "@/lib/api/helpers";
import { TradeCostLine } from "@/lib/supabase/types";
import { TRADE_COST_TYPES } from "@/lib/data/reference";
import { getExchangeRate } from "@/lib/utils/exchange-rates";

export const runtime = "nodejs";

/**
 * Normalize commission type from UI format to backend enum.
 * CRITICAL FIX (audit C-2): see comment in route.ts (POST).
 */
function normalizeCommissionType(t: string | null | undefined): string | null {
  if (!t) return null;
  const map: Record<string, string> = {
    percent_profit: "profit_percent",
    percent_revenue: "revenue_percent",
    fixed_per_unit: "per_unit",
    fixed_total: "fixed",
    profit_percent: "profit_percent",
    revenue_percent: "revenue_percent",
    per_unit: "per_unit",
    fixed: "fixed",
  };
  return map[t] || t;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthOrApiKey(_req);
  if (auth instanceof NextResponse) return auth;
  // U-FIX (RBAC audit D-1): gate BOTH session AND API-key callers.
  const denied = requireAuthOrApiKeyPermission(auth, "trade-calculator.read");
  if (denied) return denied;
  // Feature gate (module_trade)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_trade", _isSA); if (_f) return _f; } /* requireFeature wired */

  const { id } = await params;
  const item = await auth.store.getTradeCalculation(id);
  if (!item) return NextResponse.json({ error: "Not found." }, { status: 404 });
  // CRITICAL FIX (audit T-2): tenant ownership check must cover BOTH auth
  // modes. Previously the `"user" in auth && !auth.isSuperAdmin` guard
  // skipped the check entirely for API key auth (which has no `isSuperAdmin`
  // property) — so an API key from tenant A could read tenant B's calc by id.
  const isSuperAdmin = "user" in auth && auth.isSuperAdmin;
  if (!isSuperAdmin && (item as any).tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  return NextResponse.json(item);
}

/**
 * PUT /api/trade-calculator/[id]
 * Update an existing trade calculation.
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthOrApiKey(req);
  if (auth instanceof NextResponse) return auth;
  // U-FIX (RBAC audit D-1): gate BOTH session AND API-key callers.
  const denied = requireAuthOrApiKeyPermission(auth, "trade-calculator.update");
  if (denied) return denied;
  // Feature gate (module_trade)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_trade", _isSA); if (_f) return _f; } /* requireFeature wired */

  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) return NextResponse.json({ error: "No tenant context." }, { status: 400 });

  const { id } = await params;
  const existing = await auth.store.getTradeCalculation(id);
  if (!existing) return NextResponse.json({ error: "Trade calculation not found." }, { status: 404 });
  // CRITICAL FIX (audit T-2): tenant ownership check must cover BOTH auth
  // modes (see GET handler above for full rationale).
  const isSuperAdmin = "user" in auth && auth.isSuperAdmin;
  if (!isSuperAdmin && (existing as any).tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Trade calculation not found." }, { status: 404 });
  }

  try {
    const body = await req.json();
    body.id = id;
    // Preserve the entity's tenant_id (regular users cannot move it to another tenant)
    body.tenant_id = (existing as any).tenant_id || tenantId;

    // ── Tenant-ownership validation (audit F-6/P1-6 IDOR) ──────────────
    // Same fix as POST /api/trade-calculator: an authenticated user could
    // otherwise change `product_id` / `supplier_offer_id` / `supplier_id`
    // / `buyer_id` on an existing calc to point at another tenant's
    // records. We validate against the calc's OWN tenant_id (not the
    // resolved tenantId, which for a super-admin could be different).
    // Super-admins bypass.
    if (!isSuperAdmin) {
      const calcTenantId = (existing as any).tenant_id;
      if (body.product_id) {
        const product = await auth.store.getProduct(body.product_id);
        if (!product || product.tenant_id !== calcTenantId) {
          return NextResponse.json({ error: "Invalid product — does not belong to your tenant." }, { status: 400 });
        }
      }
      if (body.supplier_offer_id) {
        const offer = await auth.store.getSupplierOffer(body.supplier_offer_id);
        if (!offer || offer.tenant_id !== calcTenantId) {
          return NextResponse.json({ error: "Invalid supplier offer — does not belong to your tenant." }, { status: 400 });
        }
      }
      if (body.supplier_id) {
        const supplier = await auth.store.getPartner(body.supplier_id);
        if (!supplier || supplier.tenant_id !== calcTenantId) {
          return NextResponse.json({ error: "Invalid supplier — does not belong to your tenant." }, { status: 400 });
        }
      }
      if (body.buyer_id) {
        const buyer = await auth.store.getPartner(body.buyer_id);
        if (!buyer || buyer.tenant_id !== calcTenantId) {
          return NextResponse.json({ error: "Invalid buyer — does not belong to your tenant." }, { status: 400 });
        }
      }
    }

    // Validate exchange_rate (Fix 8): must be positive when provided. Reuse
    // the existing value (already validated on POST) when not supplied.
    if (body.exchange_rate !== undefined && body.exchange_rate !== null) {
      const rate = Number(body.exchange_rate);
      if (!Number.isFinite(rate) || rate <= 0) {
        return NextResponse.json({ error: "Exchange rate must be a positive number." }, { status: 400 });
      }
    }

    // Validate commission_rate (Fix 8): non-negative.
    if (body.commission_rate !== undefined && body.commission_rate !== null) {
      const cr = Number(body.commission_rate);
      if (!Number.isFinite(cr) || cr < 0) {
        return NextResponse.json({ error: "Commission rate must be a non-negative number." }, { status: 400 });
      }
      body.commission_rate = cr;
    }

    // Preserve commission tracking fields (Fix 1) — when the body doesn't
    // supply them, fall back to the existing values so partial PUTs don't
    // silently clear the commission chain on a calc that already had it set.
    body.commission_agent_id = body.commission_agent_id ?? (existing as any).commission_agent_id ?? null;
    body.commission_type = normalizeCommissionType(body.commission_type ?? (existing as any).commission_type ?? null);
    body.commission_rate = body.commission_rate ?? (existing as any).commission_rate ?? 0;

    // Compute totals from cost lines
    const qty = body.quantity || (existing as any).quantity || 0;
    const numContainers = body.num_containers || (existing as any).num_containers || 1;
    const buyPrice = body.buy_price_per_unit ?? (existing as any).buy_price_per_unit ?? 0;
    const sellPrice = body.sell_price_per_unit ?? (existing as any).sell_price_per_unit ?? 0;
    const buyTotal = buyPrice * qty;
    // Apply exchange_rate when buy/sell currencies differ (audit T-series).
    const buyCurrency = body.buy_currency || (existing as any).buy_currency;
    const sellCurrency = body.sell_currency || (existing as any).sell_currency;
    const fxRate = Number(body.exchange_rate ?? (existing as any).exchange_rate) || 1;
    const currenciesDiffer =
      !!buyCurrency && !!sellCurrency && buyCurrency !== sellCurrency;
    const effectiveFx = currenciesDiffer ? fxRate : 1;

    let landedCost = buyTotal;
    // Per-line currency conversion (mirror of POST route — see comment there).
    // Each line's `amount` is computed in its own `currency`, then converted to
    // buy_currency via `line.fx_rate` (user-supplied or live-snapshotted).
    const normalizedBuyCurrency = (buyCurrency || "USD").toUpperCase();
    const sourceLines = (body.cost_lines || (existing as any).cost_lines || []) as TradeCostLine[];
    const computedLines: TradeCostLine[] = [];
    for (const line of sourceLines) {
      let amount = 0;
      if (line.basis === "unit") amount = line.value * qty;
      else if (line.basis === "fixed") amount = line.value;
      else if (line.basis === "per_container") amount = line.value * numContainers;
      else if (line.basis === "percent") {
        amount = (landedCost * line.value) / 100;
      }
      amount = Math.round(amount * 100) / 100;

      const lineCurrency = (line.currency || normalizedBuyCurrency).toUpperCase();
      let fxRate: number | undefined = undefined;
      // CRITICAL FIX (audit P1-15): percent cost lines apply to landedCost,
      // which is already in buy_currency. The amount is already in
      // buy_currency — do NOT convert again (was double-converting).
      if (line.basis === "percent") {
        fxRate = 1;
      } else if (lineCurrency === normalizedBuyCurrency) {
        fxRate = 1;
      } else if (typeof line.fx_rate === "number" && line.fx_rate > 0) {
        fxRate = line.fx_rate;
      } else {
        // CRITICAL FIX (audit P1-16): when the live rate provider is down,
        // fail loudly rather than silently falling back to 1. Cannot return
        // 400 from inside the try block — throw and let the catch propagate.
        const live = await getExchangeRate(lineCurrency, normalizedBuyCurrency);
        if (!live || live <= 0) {
          if (lineCurrency !== normalizedBuyCurrency) {
            throw new Error(`Could not fetch exchange rate for ${lineCurrency} → ${normalizedBuyCurrency}. Please set the rate manually or retry.`);
          }
          fxRate = 1;
        } else {
          fxRate = live;
        }
      }
      const convertedAmount = Math.round(amount * fxRate * 100) / 100;
      landedCost += convertedAmount;
      computedLines.push({
        ...line,
        currency: lineCurrency,
        amount,
        fx_rate: fxRate,
        converted_amount: convertedAmount,
      });
    }

    const sellTotal = sellPrice * qty;
    // Convert landed cost (buy currency) → sell currency for the margin math.
    const landedCostInSellCurrency = landedCost * effectiveFx;
    const margin = sellTotal - landedCostInSellCurrency;
    const marginPct = sellTotal > 0 ? (margin / sellTotal) * 100 : 0;

    body.cost_lines = computedLines;
    body.total_buy_cost = Math.round(buyTotal * 100) / 100;
    body.total_landed_cost = Math.round(landedCost * 100) / 100;
    body.total_sell_revenue = Math.round(sellTotal * 100) / 100;
    body.gross_margin = Math.round(margin * 100) / 100;
    body.margin_percent = Math.round(marginPct * 100) / 100;

    const updated = await auth.store.upsertTradeCalculation(body);
    const auditUser = "user" in auth ? auth.user : { id: auth.apiKeyId, username: auth.apiKeyName, tenant_id: auth.tenantId };
    await audit(auth.store, auditUser, req, "trade_calc.update", "trade_calculation", updated.id, { name: updated.name });
    return NextResponse.json(updated);
  } catch (e: any) {
    console.error("[trade-calculator PUT]", e);
    return NextResponse.json({ error: sanitizeError(e)}, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthOrApiKey(req);
  if (auth instanceof NextResponse) return auth;
  // U-FIX (RBAC audit D-1): gate BOTH session AND API-key callers.
  const denied = requireAuthOrApiKeyPermission(auth, "trade-calculator.delete");
  if (denied) return denied;
  // Feature gate (module_trade)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_trade", _isSA); if (_f) return _f; } /* requireFeature wired */

  const { id } = await params;
  // Tenant ownership check before delete
  const existing = await auth.store.getTradeCalculation(id);
  if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
  // CRITICAL FIX (audit T-2): tenant ownership check must cover BOTH auth
  // modes (see GET handler above for full rationale).
  const isSuperAdmin = "user" in auth && auth.isSuperAdmin;
  if (!isSuperAdmin && (existing as any).tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  await auth.store.deleteTradeCalculation(id);
  const auditUser = "user" in auth ? auth.user : { id: auth.apiKeyId, username: auth.apiKeyName, tenant_id: auth.tenantId };
  await audit(auth.store, auditUser, req, "trade_calc.delete", "trade_calculation", id);
  return NextResponse.json({ ok: true });
}
