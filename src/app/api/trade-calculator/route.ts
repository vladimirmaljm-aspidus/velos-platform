import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAuthOrApiKey, requireAuthOrApiKeyPermission, audit, resolveTenantId, sanitizeError } from "@/lib/api/helpers";
import { TradeCostLine } from "@/lib/supabase/types";
import { TRADE_COST_TYPES } from "@/lib/data/reference";
// 31-f — shared numeric-field validation (task brief B-list: the one
// numeric trade-calc input that previously skipped validation — see the
// P2-5 / ADMIN-M11 blocks below for the fields that were already covered).
import { assertNumeric } from "@/lib/api/validate";
// 46-a — shared trade-calculator math (single source of truth for POST and
// PUT; the inline copies were extracted byte-for-byte — see the lib header).
import { normalizeCommissionType, computeTradeTotals } from "@/lib/trade/calculator-math";

export const runtime = "nodejs";

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

/**
 * 46-a — key facts recorded on the trade_calc.create audit event (the
 * History panel renders them as the "born as" snapshot of the calc).
 * Only DEFINED values are included; null/undefined keys are omitted
 * entirely so the audit row stays compact.
 */
function createAuditDetails(created: {
  name: string;
  quantity: number;
  sell_currency: string;
  total_sell_revenue: number;
  gross_margin: number;
  margin_percent: number;
  commission_agent_id?: string | null;
  commission_rate?: number | null;
}): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  if (created.name != null) details.name = created.name;
  if (created.quantity != null) details.quantity = created.quantity;
  if (created.sell_currency) details.sell_currency = created.sell_currency;
  if (created.total_sell_revenue != null) details.total_sell_revenue = created.total_sell_revenue;
  if (created.gross_margin != null) details.gross_margin = created.gross_margin;
  if (created.margin_percent != null) details.margin_percent = created.margin_percent;
  if (created.commission_agent_id) details.commission_agent_id = created.commission_agent_id;
  if (created.commission_rate != null) details.commission_rate = created.commission_rate;
  return details;
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

  // 31-f — num_containers numeric validation. The P2-5 / Fix 8 blocks
  // below already coerce quantity / buy_price_per_unit / sell_price_per_unit
  // / exchange_rate / commission_rate (audit "CRITICAL FIX P2-5"), but
  // num_containers flows raw into `line.value * numContainers` (NaN
  // propagation) and into the row's integer column (PostgREST 22P02 → 500).
  // Coerce numeric strings, 400 on junk — same semantics as the others.
  {
    const bad = assertNumeric(body, ["num_containers"]);
    if (bad) return bad;
  }

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

  // AUDIT2-LOW #6: enforce an UPPER BOUND on commission_rate. The earlier
  // check (above) only rejects negative values, so a 10000% commission
  // or a $1e12 fixed commission would sail through and produce absurd
  // totals. After normalization we know the canonical type, so:
  //   - percent-based types (profit_percent / revenue_percent) → cap at 100%
  //   - fixed total amount ("fixed") → cap at 1e9 (1 billion)
  // `per_unit` is intentionally not capped here (it represents a per-unit
  // amount, so the effective total scales with quantity — a per-unit
  // cap would need to also consider `quantity`, which is out of scope
  // for this LOW finding).
  if (body.commission_rate !== undefined && body.commission_rate !== null) {
    const cr = Number(body.commission_rate);
    const ct = (body.commission_type as string | null | undefined) ?? "";
    if (ct.includes("percent") && cr > 100) {
      return NextResponse.json(
        { error: "Commission rate must be between 0 and 100 for percent-based types." },
        { status: 400 },
      );
    }
    if (ct === "fixed" && cr > 1e9) {
      return NextResponse.json(
        { error: "Commission amount too large." },
        { status: 400 },
      );
    }
  }

  // ── Cost-line validation (ADMIN-M11) ─────────────────────────────────
  //  - For ALL bases, the value MUST be a finite number — a string,
  //    null, or NaN flows through the arithmetic as NaN and silently
  //    zeroes the landed cost (which is the exact NaN-propagation
  //    bug P2-5 fixed for the top-level inputs but missed here).
  //  - For `basis === "percent"`, the value MUST be between 0 and
  //    100. A negative percentage makes no sense (and would invert
  //    the cost into a credit); > 100 means the line alone is more
  //    than the entire buy value, which the UI never intends and
  //    which would silently explode `landedCost` into the sky.
  // (Validated up-front so the shared math in computeTradeTotals only ever
  // sees clean numbers; the mutation `line.value = lineValue` matches the
  // pre-46-a inline loop, which coerced numeric strings in place.)
  for (const line of (body.cost_lines || []) as TradeCostLine[]) {
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
  }

  // Compute totals from cost lines
  // NOTE: `qty`, `buyPrice`, `sellPrice` were already validated and coerced
  // above (P2-5). Reuse them here instead of re-reading body fields.
  // 46-a: the arithmetic lives in src/lib/trade/calculator-math.ts (shared
  // with the PUT route — same inputs, byte-identical totals). When a line's
  // currency differs from the buy currency and no fx_rate is supplied, the
  // lib fetches the LIVE rate and THROWS when the provider is down (P1-16);
  // POST maps that error to a 400 with the descriptive message.
  let totals;
  try {
    totals = await computeTradeTotals({
      quantity: qty,
      buy_price_per_unit: buyPrice,
      sell_price_per_unit: sellPrice,
      buy_currency: body.buy_currency,
      sell_currency: body.sell_currency,
      exchange_rate: body.exchange_rate,
      num_containers: body.num_containers || 1,
      cost_lines: (body.cost_lines || []) as TradeCostLine[],
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to compute totals." }, { status: 400 });
  }

  body.cost_lines = totals.computedLines;
  body.total_buy_cost = totals.total_buy_cost;
  body.total_landed_cost = totals.total_landed_cost;
  body.total_sell_revenue = totals.total_sell_revenue;
  body.gross_margin = totals.gross_margin;
  body.margin_percent = totals.margin_percent;

  const created = await auth.store.upsertTradeCalculation(body);
  const auditUser = "user" in auth ? auth.user : { id: auth.apiKeyId, username: auth.apiKeyName, tenant_id: auth.tenantId };
  // 46-a: the create event carries the key business facts (only DEFINED
  // values — null/undefined keys are omitted entirely) so the History panel
  // can show what the calculation was born as, not just its name.
  const auditDetails: Record<string, unknown> = body.id
    ? { name: created.name }
    : createAuditDetails(created);
  await audit(auth.store, auditUser, req, body.id ? "trade_calc.update" : "trade_calc.create", "trade_calculation", created.id, auditDetails);
  return NextResponse.json(created);
  } catch (e: any) {
    console.error("[trade-calculator POST]", e);
    return NextResponse.json(
      { error: sanitizeError(e) },
      { status: 500 },
    );
  }
}
