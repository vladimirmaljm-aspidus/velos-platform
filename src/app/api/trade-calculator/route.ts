import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAuthOrApiKey, requireAuthOrApiKeyPermission, audit, resolveTenantId, sanitizeError } from "@/lib/api/helpers";
import { TradeCostLine } from "@/lib/supabase/types";
import { TRADE_COST_TYPES } from "@/lib/data/reference";
import { getExchangeRate } from "@/lib/utils/exchange-rates";

export const runtime = "nodejs";

/**
 * Normalize commission type from UI format to backend enum.
 * CRITICAL FIX (audit C-2): UI saves percent_profit/percent_revenue/fixed_per_unit/fixed_total
 * but backend expects profit_percent/revenue_percent/per_unit/fixed.
 * Without normalization, every commission computes to $0.
 */
function normalizeCommissionType(t: string | null | undefined): string | null {
  if (!t) return null;
  const map: Record<string, string> = {
    percent_profit: "profit_percent",
    percent_revenue: "revenue_percent",
    fixed_per_unit: "per_unit",
    fixed_total: "fixed",
    // Pass-through already-correct values:
    profit_percent: "profit_percent",
    revenue_percent: "revenue_percent",
    per_unit: "per_unit",
    fixed: "fixed",
  };
  return map[t] || t;
}

export async function GET(req: NextRequest) {
  const auth = await requireAuthOrApiKey(req);
  if (auth instanceof NextResponse) return auth;
  // U-FIX (RBAC audit D-1): gate BOTH session AND API-key callers.
  const denied = requireAuthOrApiKeyPermission(auth, "trade-calculator.read");
  if (denied) return denied;
  // Feature gate (module_trade)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_trade", _isSA); if (_f) return _f; } /* requireFeature wired */

  const tenantId = resolveTenantId(auth, req);
  // Super-admin without an active tenant selected: return empty rather than
  // 400 — the view is meant to be tenant-scoped and the client is not
  // "broken", the user just hasn't chosen a tenant yet.
  if (!tenantId) return NextResponse.json({ items: [], total: 0 });
  const url = new URL(req.url);
  const search = url.searchParams.get("search") || undefined;
  const result = await auth.store.listTradeCalculations(tenantId, { search });
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  // F-FINAL / P0: wrap the whole handler in try/catch. Previously, a DB
  // error from `upsertTradeCalculation` (or any helper) bubbled out of
  // the route handler as an unhandled rejection — Next.js turned that
  // into a 500 with an EMPTY body (no JSON), so callers got a parse
  // error and ops got no triage context. Now we log + return a sanitized
  // JSON body so the client sees `{"error":"..."}` and ops sees the
  // original stack in the server log.
  try {
  const auth = await requireAuthOrApiKey(req);
  if (auth instanceof NextResponse) return auth;
  // U-FIX (RBAC audit D-1): gate BOTH session AND API-key callers.
  const denied = requireAuthOrApiKeyPermission(auth, "trade-calculator.create");
  if (denied) return denied;
  // Feature gate (module_trade)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_trade", _isSA); if (_f) return _f; } /* requireFeature wired */

  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) return NextResponse.json({ error: "No tenant context." }, { status: 400 });
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  body.tenant_id = tenantId;
  if (!body.created_by && "user" in auth) body.created_by = auth.user.id;

  // ── Tenant-ownership validation (audit F-6/P1-6 IDOR) ────────────────
  // The trade calculator links to products, supplier offers, suppliers
  // (partners), and buyers (partners). Without this check, an
  // authenticated user could pass another tenant's id for any of these
  // and create a calculation that cross-references another tenant's
  // data — and then use the offer-preview endpoint to read sensitive
  // pricing fields from that other tenant's records. Super-admins
  // bypass (they can mix cross-tenant records for platform operations).
  const isSuperAdminPost = "user" in auth && auth.isSuperAdmin;
  if (!isSuperAdminPost) {
    if (body.product_id) {
      const product = await auth.store.getProduct(body.product_id);
      if (!product || product.tenant_id !== tenantId) {
        return NextResponse.json({ error: "Invalid product — does not belong to your tenant." }, { status: 400 });
      }
    }
    if (body.supplier_offer_id) {
      const offer = await auth.store.getSupplierOffer(body.supplier_offer_id);
      if (!offer || offer.tenant_id !== tenantId) {
        return NextResponse.json({ error: "Invalid supplier offer — does not belong to your tenant." }, { status: 400 });
      }
    }
    if (body.supplier_id) {
      const supplier = await auth.store.getPartner(body.supplier_id);
      if (!supplier || supplier.tenant_id !== tenantId) {
        return NextResponse.json({ error: "Invalid supplier — does not belong to your tenant." }, { status: 400 });
      }
    }
    if (body.buyer_id) {
      const buyer = await auth.store.getPartner(body.buyer_id);
      if (!buyer || buyer.tenant_id !== tenantId) {
        return NextResponse.json({ error: "Invalid buyer — does not belong to your tenant." }, { status: 400 });
      }
    }
  }

  // Validate exchange_rate (Fix 8): must be positive when provided. A negative
  // rate flows through to `landedCostInSellCurrency` as a negative multiplier
  // → margin wildly inflates. Zero is silently coerced to 1 below (matches
  // existing behaviour for the same-currency edge case).
  if (body.exchange_rate !== undefined && body.exchange_rate !== null) {
    const rate = Number(body.exchange_rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      return NextResponse.json({ error: "Exchange rate must be a positive number." }, { status: 400 });
    }
  }

  // Validate commission_rate (Fix 8 — assertNonNegative): percent or fixed
  // amount cannot be negative. We allow 0 (no commission).
  if (body.commission_rate !== undefined && body.commission_rate !== null) {
    const cr = Number(body.commission_rate);
    if (!Number.isFinite(cr) || cr < 0) {
      return NextResponse.json({ error: "Commission rate must be a non-negative number." }, { status: 400 });
    }
    body.commission_rate = cr;
  }

  // CRITICAL FIX (audit P2-5): validate numeric inputs to prevent NaN
  // propagation. If the client sends a string (e.g. "100") or omits the
  // field, downstream math (`buyTotal = buy_price_per_unit * qty`) would
  // produce NaN/undefined, silently zeroing totals.
  const qty = Number(body.quantity);
  if (!Number.isFinite(qty) || qty < 0) {
    return NextResponse.json({ error: "Quantity must be a non-negative number." }, { status: 400 });
  }
  body.quantity = qty;

  const buyPrice = Number(body.buy_price_per_unit);
  if (!Number.isFinite(buyPrice) || buyPrice < 0) {
    return NextResponse.json({ error: "Buy price must be a non-negative number." }, { status: 400 });
  }
  body.buy_price_per_unit = buyPrice;

  const sellPrice = Number(body.sell_price_per_unit);
  if (!Number.isFinite(sellPrice) || sellPrice < 0) {
    return NextResponse.json({ error: "Sell price must be a non-negative number." }, { status: 400 });
  }
  body.sell_price_per_unit = sellPrice;

  // Persist commission tracking fields (Fix 1) — they were previously dropped
  // because the columns didn't exist on the live schema. After migration 007
  // is applied, these flow through `upsertTradeCalculation` → smartUpsert
  // and are saved on the trade_calculations row. They're later read by the
  // offer-preview endpoint to auto-track commission obligations on accept.
  body.commission_agent_id = body.commission_agent_id ?? null;
  // CRITICAL FIX (audit C-2): normalize UI commission types to backend enum.
  // UI sends: percent_profit | percent_revenue | fixed_per_unit | fixed_total
  // Backend expects: profit_percent | revenue_percent | per_unit | fixed
  // Without this, every commission computes to $0 (switch falls through to default).
  body.commission_type = normalizeCommissionType(body.commission_type);

  // Compute totals from cost lines
  // NOTE: `qty`, `buyPrice`, `sellPrice` were already validated and coerced
  // above (P2-5). Reuse them here instead of re-reading body fields.
  const numContainers = body.num_containers || 1;
  const buyTotal = buyPrice * qty;
  // Exchange rate: sell_currency per buy_currency. When currencies differ,
  // landed cost (in buy currency) must be converted to sell currency before
  // subtracting from sell revenue to compute margin. Audit T-series.
  const fxRate = Number(body.exchange_rate) || 1;
  const currenciesDiffer =
    !!body.buy_currency && !!body.sell_currency && body.buy_currency !== body.sell_currency;
  const effectiveFx = currenciesDiffer ? fxRate : 1;

  let landedCost = buyTotal;
  // Cost lines: each line has its own `currency`. Convert each line's amount
  // to buy_currency via its `fx_rate` before adding to landedCost. This is the
  // fix for the silent multi-currency bug (EUR freight was summed as if USD).
  // The `fx_rate` is snapshotted server-side from the live rate at save time
  // so historical calcs stay accurate when rates move.
  const buyCurrency = (body.buy_currency || "USD").toUpperCase();
  const computedLines: TradeCostLine[] = [];
  for (const line of (body.cost_lines || []) as TradeCostLine[]) {
    // ADMIN-M11: validate the cost-line value before applying it.
    //  - For ALL bases, the value MUST be a finite number — a string,
    //    null, or NaN flows through the arithmetic as NaN and silently
    //    zeroes the landed cost (which is the exact NaN-propagation
    //    bug P2-5 fixed for the top-level inputs but missed here).
    //  - For `basis === "percent"`, the value MUST be between 0 and
    //    100. A negative percentage makes no sense (and would invert
    //    the cost into a credit); > 100 means the line alone is more
    //    than the entire buy value, which the UI never intends and
    //    which would silently explode `landedCost` into the sky.
    const lineValue = Number(line.value);
    if (!Number.isFinite(lineValue)) {
      return NextResponse.json(
        { error: "Each cost line must have a numeric value." },
        { status: 400 },
      );
    }
    line.value = lineValue;
    if (line.basis === "percent" && (lineValue < 0 || lineValue > 100)) {
      return NextResponse.json(
        { error: "Percentage cost lines must be between 0 and 100." },
        { status: 400 },
      );
    }
    let amount = 0;
    if (line.basis === "unit") amount = line.value * qty;
    else if (line.basis === "fixed") amount = line.value;
    else if (line.basis === "per_container") amount = line.value * numContainers;
    else if (line.basis === "percent") {
      // percent applies to buyTotal + accumulated costs (CIF value)
      amount = (landedCost * line.value) / 100;
    }
    amount = Math.round(amount * 100) / 100;

    // Resolve line.fx_rate: prefer user-supplied, else snapshot live rate
    // when line.currency differs from buy_currency. Same currency = 1.
    const lineCurrency = (line.currency || buyCurrency).toUpperCase();
    let fxRate: number | undefined = undefined;
    // CRITICAL FIX (audit P1-15): percent cost lines apply to landedCost,
    // which is already in buy_currency. The amount is already in
    // buy_currency — do NOT convert again (was double-converting).
    if (line.basis === "percent") {
      fxRate = 1;
    } else if (lineCurrency === buyCurrency) {
      fxRate = 1;
    } else if (typeof line.fx_rate === "number" && line.fx_rate > 0) {
      // User-supplied (possibly manual) rate — trust it.
      fxRate = line.fx_rate;
    } else {
      // CRITICAL FIX (audit P1-16): when the live rate provider is down,
      // fail loudly rather than silently falling back to 1 (which would
      // silently produce wrong totals).
      const live = await getExchangeRate(lineCurrency, buyCurrency);
      if (!live || live <= 0) {
        if (lineCurrency !== buyCurrency) {
          return NextResponse.json(
            { error: `Could not fetch exchange rate for ${lineCurrency} → ${buyCurrency}. Please set the rate manually or retry.` },
            { status: 400 },
          );
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

  const created = await auth.store.upsertTradeCalculation(body);
  const auditUser = "user" in auth ? auth.user : { id: auth.apiKeyId, username: auth.apiKeyName, tenant_id: auth.tenantId };
  await audit(auth.store, auditUser, req, body.id ? "trade_calc.update" : "trade_calc.create", "trade_calculation", created.id, { name: created.name });
  return NextResponse.json(created);
  } catch (e: any) {
    console.error("[trade-calculator POST]", e);
    return NextResponse.json(
      { error: sanitizeError(e) },
      { status: 500 },
    );
  }
}
