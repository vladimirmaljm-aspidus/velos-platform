import { TradeCostLine } from "@/lib/supabase/types";
import { getExchangeRate } from "@/lib/utils/exchange-rates";

/**
 * Trade Calculator — shared server-side math (46-a).
 *
 * Both POST /api/trade-calculator and PUT /api/trade-calculator/[id]
 * duplicated this logic inline (they drifted once already — audit C-2 /
 * P1-15 / P1-16 were fixed on one side and mirrored by hand on the other).
 * This module is the single source of truth for:
 *
 *   • normalizeCommissionType — UI enum → backend enum (audit C-2).
 *   • computeTradeTotals — per-line basis math + per-line currency →
 *     buy-currency conversion + landed-cost accumulation + margin math.
 *     Async because a cost line in a currency that differs from the buy
 *     currency without a user-supplied fx_rate triggers a LIVE rate fetch
 *     (audit P1-16: when the provider is down we THROW a descriptive error
 *     instead of silently falling back to 1 — the ROUTES decide how to map
 *     that error: POST → 400 with e.message, PUT → let it propagate to the
 *     500 catch).
 *   • diffTradeCalculation — field-level [{field, from, to}] diff of the
 *     tracked business fields, recorded in the audit trail on every PUT so
 *     edits show up in the entity's History panel (GET /api/audit/entity).
 *
 * The functions mirror the exact arithmetic that used to live inline in
 * the POST route (including rounding to 2 decimals per amount and the
 * effectiveFx semantics for the margin math), so identical inputs keep
 * producing byte-identical saved totals. Inputs are route-validated; the
 * defensive defaults below only guard direct (test) callers.
 */

/**
 * Normalize commission type from UI format to backend enum.
 * CRITICAL FIX (audit C-2): UI saves percent_profit/percent_revenue/fixed_per_unit/fixed_total
 * but backend expects profit_percent/revenue_percent/per_unit/fixed.
 * Without normalization, every commission computes to $0.
 */
export function normalizeCommissionType(t: string | null | undefined): string | null {
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

// ─── Totals computation ─────────────────────────────────────────────────────

export interface ComputeTradeTotalsInput {
  quantity: number | null | undefined;
  buy_price_per_unit: number | null | undefined;
  sell_price_per_unit: number | null | undefined;
  buy_currency: string | null | undefined;
  sell_currency: string | null | undefined;
  /** sell_currency per buy_currency (only applied when the currencies differ). */
  exchange_rate: number | null | undefined;
  num_containers: number | null | undefined;
  cost_lines: TradeCostLine[] | null | undefined;
}

export interface ComputeTradeTotalsResult {
  /** Input lines enriched with amount / upper-cased currency / fx_rate /
   *  converted_amount (exactly what the routes persist in cost_lines). */
  computedLines: TradeCostLine[];
  total_buy_cost: number;
  total_landed_cost: number;
  total_sell_revenue: number;
  gross_margin: number;
  margin_percent: number;
}

/**
 * Compute the trade-calculation totals from the cost lines.
 *
 * Semantics (mirrors the former POST-route inline math exactly):
 *   • basis math: unit → value×qty, fixed → value, per_container →
 *     value×numContainers, percent → landedCost×value/100 applied to the
 *     ACCUMULATED landed cost (buy total + all previous lines, each already
 *     converted to the buy currency) — that's how CIF-style percentage
 *     costs (duty on CIF value) chain.
 *   • per-line currency → buy-currency conversion: percent lines fx=1
 *     (P1-15: their amount is already in buy currency — never convert
 *     twice); same-currency lines fx=1; a user fx_rate > 0 is trusted;
 *     otherwise the LIVE rate is fetched — and when it is unavailable for
 *     a differing currency we THROW (P1-16) instead of silently using 1.
 *   • rounding: Math.round(x * 100) / 100 on every amount.
 *   • margin = sellTotal − landedCost × effectiveFx where effectiveFx =
 *     exchange_rate only when buy/sell currencies differ (raw comparison —
 *     not case-insensitive), else 1; marginPercent = margin / sellTotal × 100
 *     when sellTotal > 0, else 0.
 *
 * NOTE: `amount` on each computed line stays in the LINE's own currency;
 * `converted_amount` is the buy-currency value that accumulates into
 * total_landed_cost.
 */
export async function computeTradeTotals(input: ComputeTradeTotalsInput): Promise<ComputeTradeTotalsResult> {
  // Defensive defaults (the routes pre-validate/pre-merge these — direct
  // callers just get the same fallbacks: quantity 0, containers 1, prices 0).
  const qty = (input.quantity ?? 0) || 0;
  const numContainers = (input.num_containers ?? 1) || 1;
  const buyPrice = (input.buy_price_per_unit ?? 0) || 0;
  const sellPrice = (input.sell_price_per_unit ?? 0) || 0;
  const buyTotal = buyPrice * qty;

  // Exchange rate: sell_currency per buy_currency. When currencies differ,
  // landed cost (in buy currency) must be converted to sell currency before
  // subtracting from sell revenue to compute margin. Audit T-series.
  // NOTE: the differ check uses the RAW strings (exactly like the routes);
  // line-currency matching below is case-insensitive.
  const fxRate = Number(input.exchange_rate) || 1;
  const currenciesDiffer =
    !!input.buy_currency && !!input.sell_currency && input.buy_currency !== input.sell_currency;
  const effectiveFx = currenciesDiffer ? fxRate : 1;

  let landedCost = buyTotal;
  // Cost lines: each line has its own `currency`. Convert each line's amount
  // to buy_currency via its `fx_rate` before adding to landedCost. This is the
  // fix for the silent multi-currency bug (EUR freight was summed as if USD).
  // The `fx_rate` is snapshotted server-side from the live rate at save time
  // so historical calcs stay accurate when rates move.
  const buyCurrency = (input.buy_currency || "USD").toUpperCase();
  const computedLines: TradeCostLine[] = [];
  for (const line of (input.cost_lines || []) as TradeCostLine[]) {
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
    let lineFxRate: number | undefined = undefined;
    // CRITICAL FIX (audit P1-15): percent cost lines apply to landedCost,
    // which is already in buy_currency. The amount is already in
    // buy_currency — do NOT convert again (was double-converting).
    if (line.basis === "percent") {
      lineFxRate = 1;
    } else if (lineCurrency === buyCurrency) {
      lineFxRate = 1;
    } else if (typeof line.fx_rate === "number" && line.fx_rate > 0) {
      // User-supplied (possibly manual) rate — trust it.
      lineFxRate = line.fx_rate;
    } else {
      // CRITICAL FIX (audit P1-16): when the live rate provider is down,
      // fail loudly rather than silently falling back to 1 (which would
      // silently produce wrong totals). The caller maps this error to the
      // right HTTP contract (POST: 400 with the message; PUT: 500 catch).
      const live = await getExchangeRate(lineCurrency, buyCurrency);
      if (!live || live <= 0) {
        if (lineCurrency !== buyCurrency) {
          throw new Error(
            `Could not fetch exchange rate for ${lineCurrency} → ${buyCurrency}. Please set the rate manually or retry.`,
          );
        }
        lineFxRate = 1;
      } else {
        lineFxRate = live;
      }
    }
    const convertedAmount = Math.round(amount * lineFxRate * 100) / 100;

    landedCost += convertedAmount;
    computedLines.push({
      ...line,
      currency: lineCurrency,
      amount,
      fx_rate: lineFxRate,
      converted_amount: convertedAmount,
    });
  }

  const sellTotal = sellPrice * qty;
  // Convert landed cost (buy currency) → sell currency for the margin math.
  const landedCostInSellCurrency = landedCost * effectiveFx;
  const margin = sellTotal - landedCostInSellCurrency;
  const marginPct = sellTotal > 0 ? (margin / sellTotal) * 100 : 0;

  return {
    computedLines,
    total_buy_cost: Math.round(buyTotal * 100) / 100,
    total_landed_cost: Math.round(landedCost * 100) / 100,
    total_sell_revenue: Math.round(sellTotal * 100) / 100,
    gross_margin: Math.round(margin * 100) / 100,
    margin_percent: Math.round(marginPct * 100) / 100,
  };
}

// ─── Field-level edit history diff ─────────────────────────────────────────

export interface TradeCalcChange {
  /** The tracked business field (DB property name, e.g. buy_price_per_unit). */
  field: string;
  from: string;
  to: string;
}

/**
 * The trade-calculation fields tracked in the edit history. Kept in one
 * place so the PUT route, the audit diff and the History-panel labels
 * (misc-tch-f-* in src/lib/i18n/domains/misc.ts) stay in sync. `cost_lines`
 * is diffed by COUNT — the per-line amounts already flow into the tracked
 * totals, so a "3 → 4 lines" row plus the total rows tells the story.
 */
const TRACKED_PROPS: string[] = [
  "name",
  "product_id",
  "supplier_id",
  "buyer_id",
  "quantity",
  "unit",
  "num_containers",
  "buy_price_per_unit",
  "sell_price_per_unit",
  "buy_currency",
  "sell_currency",
  "exchange_rate",
  "commission_agent_id",
  "commission_type",
  "commission_rate",
  "cost_lines",
  "total_buy_cost",
  "total_landed_cost",
  "total_sell_revenue",
  "gross_margin",
  "margin_percent",
];

/** Stringify an audit-diff value: null/undefined/"" → "—", booleans → true/false. */
function diffValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/**
 * Compute a field-level [{field, from, to}] diff between the pre-update row
 * (`before`) and the post-update row (`after`) of a trade calculation for
 * every tracked field that ACTUALLY changed (numbers tolerate 0.01 —
 * cosmetic rounding from the client is not a change; cost_lines compares
 * the line COUNT). Unchanged fields are omitted entirely; a no-op edit
 * returns []. The result is recorded as audit details.changes and rendered
 * by the History panel (CalcHistoryDialog in trade-calculator-view.tsx).
 */
export function diffTradeCalculation(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): TradeCalcChange[] {
  const b = before || {};
  const a = after || {};
  const changes: TradeCalcChange[] = [];
  for (const field of TRACKED_PROPS) {
    if (field === "cost_lines") {
      const fromCount = Array.isArray(b.cost_lines) ? (b.cost_lines as unknown[]).length : 0;
      const toCount = Array.isArray(a.cost_lines) ? (a.cost_lines as unknown[]).length : 0;
      if (fromCount !== toCount) {
        changes.push({ field, from: String(fromCount), to: String(toCount) });
      }
      continue;
    }
    const from = b[field];
    const to = a[field];
    const changed = typeof to === "number" && typeof from === "number"
      ? Math.abs(to - from) > 0.01
      : to !== from;
    if (changed) changes.push({ field, from: diffValue(from), to: diffValue(to) });
  }
  return changes;
}
