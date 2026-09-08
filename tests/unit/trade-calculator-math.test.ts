import { describe, it, expect, vi, beforeEach } from "vitest";

// 46-a — Trade calculator shared math (src/lib/trade/calculator-math.ts).
//
// Pure unit tests, NO database / NO routes: the module is the single source
// of truth for POST /api/trade-calculator and PUT /api/trade-calculator/[id]
// totals, so its arithmetic contract is pinned here:
//   • normalizeCommissionType — UI enum → backend enum (+ pass-throughs).
//   • computeTradeTotals — per-line basis math (unit / fixed /
//     per_container / percent-on-ACCUMULATED-landed-cost), per-line
//     currency → buy-currency conversion (percent never double-converts,
//     user fx_rate trusted, live rate fetched when missing — THROWS when
//     the provider is down), effectiveFx margin math, 2-decimal rounding.
//   • diffTradeCalculation — the field-level [{field, from, to}] edit
//     history the PUT route records in the audit trail (numeric tolerance
//     0.01, cost_lines by count, null → "—").
//
// The live FX provider is mocked (same approach as the referral-commissions
// tests: hoisted mutable mock state + vi.fn inspection).

const fxState = vi.hoisted(() => ({
  rate: null as number | null,
}));

vi.mock("@/lib/utils/exchange-rates", () => ({
  getExchangeRate: vi.fn(async (_from: string, _to: string) => fxState.rate),
}));

import { getExchangeRate } from "@/lib/utils/exchange-rates";
import {
  normalizeCommissionType,
  computeTradeTotals,
  diffTradeCalculation,
  TradeCalcChange,
} from "@/lib/trade/calculator-math";

const mockGetRate = vi.mocked(getExchangeRate);

beforeEach(() => {
  fxState.rate = null;
  mockGetRate.mockClear();
});

// ── Fixtures ───────────────────────────────────────────────────────────────

/** Baseline same-currency calc: 100 units @ buy 10 / sell 12 USD. */
function baseInput(over: Record<string, unknown> = {}) {
  return {
    quantity: 100,
    buy_price_per_unit: 10,
    sell_price_per_unit: 12,
    buy_currency: "USD",
    sell_currency: "USD",
    exchange_rate: 1,
    num_containers: 1,
    cost_lines: [],
    ...over,
  };
}

/** A saved trade-calculation row (shape the PUT route diffs). */
function calcRow(over: Record<string, unknown> = {}) {
  return {
    id: "tc-1",
    tenant_id: "tenant-46a",
    name: "Sugar Q4",
    product_id: null,
    supplier_id: null,
    buyer_id: null,
    quantity: 100,
    unit: "MT",
    num_containers: 1,
    container_type: "40HC",
    buy_price_per_unit: 10,
    buy_currency: "USD",
    buy_incoterm: "FOB",
    sell_price_per_unit: 12,
    sell_currency: "USD",
    sell_incoterm: "CIF",
    transport_mode: "SEA",
    exchange_rate: 1,
    cost_lines: [] as unknown[],
    total_buy_cost: 1000,
    total_landed_cost: 1000,
    total_sell_revenue: 1200,
    gross_margin: 200,
    margin_percent: 16.67,
    commission_agent_id: null,
    commission_type: null,
    commission_rate: 0,
    ...over,
  };
}

// ── normalizeCommissionType ────────────────────────────────────────────────

describe("46-a normalizeCommissionType", () => {
  it("maps the four UI values to the backend enum", () => {
    expect(normalizeCommissionType("percent_profit")).toBe("profit_percent");
    expect(normalizeCommissionType("percent_revenue")).toBe("revenue_percent");
    expect(normalizeCommissionType("fixed_per_unit")).toBe("per_unit");
    expect(normalizeCommissionType("fixed_total")).toBe("fixed");
  });

  it("passes already-correct backend values through unchanged", () => {
    expect(normalizeCommissionType("profit_percent")).toBe("profit_percent");
    expect(normalizeCommissionType("revenue_percent")).toBe("revenue_percent");
    expect(normalizeCommissionType("per_unit")).toBe("per_unit");
    expect(normalizeCommissionType("fixed")).toBe("fixed");
  });

  it("null / undefined → null", () => {
    expect(normalizeCommissionType(null)).toBeNull();
    expect(normalizeCommissionType(undefined)).toBeNull();
    expect(normalizeCommissionType("")).toBeNull();
  });

  it("unknown values pass through as-is (custom commission types)", () => {
    expect(normalizeCommissionType("custom")).toBe("custom");
  });
});

// ── computeTradeTotals ─────────────────────────────────────────────────────

describe("46-a computeTradeTotals", () => {
  it("(a) simple same-currency math: margin 200 / marginPct 16.67", async () => {
    const r = await computeTradeTotals(baseInput());
    expect(r.total_buy_cost).toBe(1000);
    expect(r.total_landed_cost).toBe(1000);
    expect(r.total_sell_revenue).toBe(1200);
    expect(r.gross_margin).toBe(200);
    expect(r.margin_percent).toBe(16.67);
    expect(r.computedLines).toEqual([]);
    expect(mockGetRate).not.toHaveBeenCalled();
  });

  it("(b) basis math: unit = value×qty, fixed = value, per_container = value×containers", async () => {
    const r = await computeTradeTotals(baseInput({
      num_containers: 3,
      cost_lines: [
        { type: "FREIGHT", label: "Freight", basis: "unit", value: 2.5, currency: "usd" },
        { type: "LOCAL_CHARGES", label: "Local charges", basis: "fixed", value: 500, currency: "USD" },
        { type: "CUSTOMS", label: "Customs", basis: "per_container", value: 2500, currency: "USD" },
      ],
    }));
    // line currency is upper-cased; amount stays in the line currency.
    expect(r.computedLines[0]).toMatchObject({
      basis: "unit", amount: 250, currency: "USD", fx_rate: 1, converted_amount: 250,
    });
    expect(r.computedLines[1]).toMatchObject({ basis: "fixed", amount: 500, fx_rate: 1, converted_amount: 500 });
    expect(r.computedLines[2]).toMatchObject({ basis: "per_container", amount: 7500, fx_rate: 1, converted_amount: 7500 });
    expect(r.total_buy_cost).toBe(1000);
    expect(r.total_landed_cost).toBe(1000 + 250 + 500 + 7500);
  });

  it("(c) percent applies to the ACCUMULATED landed cost (1000 → 1100 → 1155)", async () => {
    const r = await computeTradeTotals(baseInput({
      cost_lines: [
        { type: "DUTY", label: "Duty 10%", basis: "percent", value: 10, currency: "USD" },
        { type: "VAT", label: "VAT 5%", basis: "percent", value: 5, currency: "USD" },
      ],
    }));
    expect(r.computedLines[0]).toMatchObject({ amount: 100, fx_rate: 1, converted_amount: 100 });
    // second percent line applies to 1100 (buy + first line), not to 1000.
    expect(r.computedLines[1]).toMatchObject({ amount: 55, fx_rate: 1, converted_amount: 55 });
    expect(r.total_landed_cost).toBe(1155);
  });

  it("(d) foreign-currency line with a user fx_rate converts into the buy currency", async () => {
    const r = await computeTradeTotals(baseInput({
      cost_lines: [
        { type: "FREIGHT", label: "EUR freight", basis: "fixed", value: 100, currency: "EUR", fx_rate: 1.1 },
      ],
    }));
    expect(r.computedLines[0]).toMatchObject({
      currency: "EUR", amount: 100, fx_rate: 1.1, converted_amount: 110,
    });
    expect(r.total_landed_cost).toBe(1110);
    expect(mockGetRate).not.toHaveBeenCalled();
  });

  it("(e) a percent line is NEVER double-converted (fx forced to 1)", async () => {
    const r = await computeTradeTotals(baseInput({
      cost_lines: [
        // Percent of a USD-landed-cost is already in USD even when the line's
        // currency says EUR — a stale user fx_rate must be ignored (P1-15).
        { type: "INSURANCE", label: "Insurance", basis: "percent", value: 10, currency: "EUR", fx_rate: 999 },
      ],
    }));
    expect(r.computedLines[0]).toMatchObject({ amount: 100, fx_rate: 1, converted_amount: 100 });
    expect(r.total_landed_cost).toBe(1100);
    expect(mockGetRate).not.toHaveBeenCalled();
  });

  it("(f) differing buy/sell currencies: effectiveFx applied to the landed cost in the margin math only", async () => {
    const r = await computeTradeTotals(baseInput({
      buy_currency: "USD",
      sell_currency: "EUR",
      exchange_rate: 0.9,
    }));
    // totals stay in their own currencies…
    expect(r.total_landed_cost).toBe(1000);
    expect(r.total_sell_revenue).toBe(1200);
    // …and margin = sellTotal − landedCost × 0.9 = 1200 − 900.
    expect(r.gross_margin).toBe(300);
    expect(r.margin_percent).toBe(25);
  });

  it("(g) live FX fetched when the line currency differs and no fx_rate is set", async () => {
    fxState.rate = 1.2;
    const r = await computeTradeTotals(baseInput({
      cost_lines: [
        { type: "FREIGHT", label: "EUR freight", basis: "fixed", value: 100, currency: "EUR" },
      ],
    }));
    expect(mockGetRate).toHaveBeenCalledWith("EUR", "USD");
    expect(r.computedLines[0]).toMatchObject({ amount: 100, fx_rate: 1.2, converted_amount: 120 });
    expect(r.total_landed_cost).toBe(1120);
  });

  it("(h) THROWS a descriptive error when the live rate is unavailable (P1-16)", async () => {
    fxState.rate = null;
    await expect(computeTradeTotals(baseInput({
      cost_lines: [
        { type: "FREIGHT", label: "EUR freight", basis: "fixed", value: 100, currency: "EUR" },
      ],
    }))).rejects.toThrow(/Could not fetch exchange rate for EUR → USD/);
  });

  it("defaults are defensive against nulls (qty 0, containers 1, prices 0)", async () => {
    const r = await computeTradeTotals({
      quantity: null,
      buy_price_per_unit: null,
      sell_price_per_unit: null,
      buy_currency: null,
      sell_currency: null,
      exchange_rate: null,
      num_containers: null,
      cost_lines: null,
    });
    expect(r.total_buy_cost).toBe(0);
    expect(r.total_landed_cost).toBe(0);
    expect(r.total_sell_revenue).toBe(0);
    expect(r.gross_margin).toBe(0);
    expect(r.margin_percent).toBe(0);
    expect(r.computedLines).toEqual([]);
  });

  it("rounds every amount to 2 decimals", async () => {
    const r = await computeTradeTotals(baseInput({
      quantity: 3,
      buy_price_per_unit: 10.333,
      sell_price_per_unit: 12.777,
      cost_lines: [
        { type: "X", label: "x", basis: "unit", value: 1.111, currency: "USD" },
      ],
    }));
    // 1.111 × 3 = 3.333 → 3.33 (Math.round(x*100)/100 on every amount)
    expect(r.computedLines[0].amount).toBe(3.33);
    expect(r.total_buy_cost).toBe(31);
    expect(r.total_sell_revenue).toBe(38.33); // 12.777 × 3 = 38.331
  });
});

// ── diffTradeCalculation ───────────────────────────────────────────────────

describe("46-a diffTradeCalculation", () => {
  it("no change → []", () => {
    expect(diffTradeCalculation(calcRow(), calcRow())).toEqual([]);
  });

  it("numeric change of 0.001 is NOT reported (0.01 tolerance)", () => {
    expect(diffTradeCalculation(calcRow(), calcRow({ quantity: 100.001 }))).toEqual([]);
  });

  it("numeric change of 5 IS reported", () => {
    const changes = diffTradeCalculation(calcRow(), calcRow({ quantity: 105 })) as TradeCalcChange[];
    expect(changes).toEqual([{ field: "quantity", from: "100", to: "105" }]);
  });

  it("string change reported (name)", () => {
    const changes = diffTradeCalculation(calcRow(), calcRow({ name: "Sugar Q5" })) as TradeCalcChange[];
    expect(changes).toEqual([{ field: "name", from: "Sugar Q4", to: "Sugar Q5" }]);
  });

  it("null → value renders '—' as the from side", () => {
    const changes = diffTradeCalculation(calcRow(), calcRow({ buyer_id: "partner-2" })) as TradeCalcChange[];
    expect(changes).toEqual([{ field: "buyer_id", from: "—", to: "partner-2" }]);
  });

  it("value → null renders '—' as the to side", () => {
    const before = calcRow({ supplier_id: "partner-1" });
    const changes = diffTradeCalculation(before, calcRow()) as TradeCalcChange[];
    expect(changes).toEqual([{ field: "supplier_id", from: "partner-1", to: "—" }]);
  });

  it("cost_lines count change recorded as the counts", () => {
    const before = calcRow({ cost_lines: [{}, {}, {}] });
    const after = calcRow({ cost_lines: [{}, {}, {}, {}] });
    const changes = diffTradeCalculation(before, after) as TradeCalcChange[];
    expect(changes).toEqual([{ field: "cost_lines", from: "3", to: "4" }]);
  });

  it("cost_lines with the SAME count is not reported", () => {
    const before = calcRow({ cost_lines: [{ type: "A" }, { type: "B" }] });
    const after = calcRow({ cost_lines: [{ type: "A" }, { type: "B", value: 5 }] });
    expect(diffTradeCalculation(before, after)).toEqual([]);
  });

  it("computed totals are tracked (margin + margin percent)", () => {
    const changes = diffTradeCalculation(
      calcRow(),
      calcRow({ gross_margin: 300.5, margin_percent: 25.04, total_landed_cost: 900 }),
    ) as TradeCalcChange[];
    expect(changes).toEqual([
      { field: "total_landed_cost", from: "1000", to: "900" },
      { field: "gross_margin", from: "200", to: "300.5" },
      { field: "margin_percent", from: "16.67", to: "25.04" },
    ]);
  });

  it("null / undefined rows are safe (treated as empty)", () => {
    expect(diffTradeCalculation(null, null)).toEqual([]);
    const changes = diffTradeCalculation(undefined, calcRow({ name: "New calc" })) as TradeCalcChange[];
    expect(changes.some((c) => c.field === "name" && c.from === "—" && c.to === "New calc")).toBe(true);
  });
});
