/**
 * Standard trade finance costs (based on ICC Banking Commission surveys).
 * These are world-average rates — users can modify per negotiation with their bank.
 */

export interface BankCostItem {
  id: string;
  label: string;
  description: string;
  basis: "percent" | "per_drawing" | "fixed" | "per_period";
  defaultValue: number; // percentage or fixed amount
  appliesTo: "lc_issuance" | "lc_advising" | "lc_confirmation" | "lc_discount" | "bank_guarantee" | "standby_lc" | "transfer_lc";
  applicablePaymentMethods: string[]; // which payment methods trigger this cost
}

export const BANK_COSTS: BankCostItem[] = [
  {
    id: "lc_issuance_fee",
    label: "LC Issuance Fee",
    description: "Fee for issuing a Letter of Credit (paid by buyer/applicant)",
    basis: "percent",
    defaultValue: 0.125, // 0.125% of LC value per quarter (typical)
    appliesTo: "lc_issuance",
    applicablePaymentMethods: ["lc_sight", "lc_30", "lc_60", "lc_90", "lc_confirmed", "lc_transferable"],
  },
  {
    id: "lc_advising_fee",
    label: "LC Advising Fee",
    description: "Fee for advising an LC (paid by beneficiary/seller)",
    basis: "fixed",
    defaultValue: 100, // $100-$500 typical flat fee
    appliesTo: "lc_advising",
    applicablePaymentMethods: ["lc_sight", "lc_30", "lc_60", "lc_90", "lc_confirmed", "lc_transferable"],
  },
  {
    id: "lc_confirmation_fee",
    label: "LC Confirmation Fee",
    description: "Fee for confirming an LC by the advising bank (adds bank's payment guarantee)",
    basis: "percent",
    defaultValue: 0.2, // 0.1-0.3% of LC value per quarter
    appliesTo: "lc_confirmation",
    applicablePaymentMethods: ["lc_confirmed"],
  },
  {
    id: "lc_discount_fee",
    label: "LC Discount/Negotiation Fee",
    description: "Fee for discounting/negotiating LC documents (getting paid before maturity)",
    basis: "percent",
    defaultValue: 0.15, // 0.1-0.25% of drawing amount
    appliesTo: "lc_discount",
    applicablePaymentMethods: ["lc_30", "lc_60", "lc_90"],
  },
  {
    id: "lc_amendment_fee",
    label: "LC Amendment Fee",
    description: "Fee for amending an LC (per amendment)",
    basis: "fixed",
    defaultValue: 50, // $50-$200 per amendment
    appliesTo: "lc_issuance",
    applicablePaymentMethods: ["lc_sight", "lc_30", "lc_60", "lc_90", "lc_confirmed", "lc_transferable"],
  },
  {
    id: "lc_discrepancy_fee",
    label: "Discrepancy Fee",
    description: "Fee per discrepancy in documents under LC (if any)",
    basis: "fixed",
    defaultValue: 75, // $50-$100 per discrepancy
    appliesTo: "lc_issuance",
    applicablePaymentMethods: ["lc_sight", "lc_30", "lc_60", "lc_90", "lc_confirmed", "lc_transferable"],
  },
  // ─── Bank guarantees / standby LCs ───
  // IMPORTANT: bank guarantees for advance-payment methods are OPTIONAL — they
  // require explicit user request (negotiated separately). They are NOT shown
  // by default for advance_100 / cia / tt_advance / split-payment methods.
  // The user can still add them as a manual cost line if needed.
  // For trade-finance methods that REQUIRE a guarantee (LC confirmed, etc.),
  // the guarantee is folded into the LC issuance/confirmation fee.
  {
    id: "bank_guarantee_fee",
    label: "Bank Guarantee Fee",
    description: "Fee for issuing a bank guarantee (performance, advance payment, etc.)",
    basis: "percent",
    defaultValue: 1.0, // 0.5-2% per year of guarantee amount
    appliesTo: "bank_guarantee",
    // Not applicable to any default payment method — must be opted-in
    // explicitly (e.g. via a manual cost line). Kept here for UI reference.
    applicablePaymentMethods: [],
  },
  {
    id: "standby_lc_fee",
    label: "Standby LC Fee",
    description: "Fee for issuing a Standby Letter of Credit",
    basis: "percent",
    defaultValue: 0.5, // 0.25-1% per year
    appliesTo: "standby_lc",
    applicablePaymentMethods: [],
  },
  {
    id: "transfer_lc_fee",
    label: "Transfer LC Fee",
    description: "Fee for transferring an LC to a second beneficiary (back-to-back)",
    basis: "percent",
    defaultValue: 0.1, // 0.1% of transferred amount
    appliesTo: "transfer_lc",
    applicablePaymentMethods: ["lc_transferable"],
  },
];

export interface BankCostResult {
  id: string;
  label: string;
  amount: number;
  basis: string;
}

/**
 * Classify a payment method by which trade-finance instrument it uses.
 *  - "lc"            → Letter of Credit (any LC variant)
 *  - "guarantee"     → Methods that may require a bank guarantee (advance,
 *                      split payments) — but only if explicitly requested.
 *  - "none"          → No trade-finance instrument (T/T, net terms, D/P, etc.)
 *
 * Transfer fees ALWAYS apply (any international payment moves money via
 * SWIFT). They are calculated separately via `calculateTransferFees`.
 */
export function classifyPaymentMethod(paymentMethod: string): "lc" | "guarantee" | "none" {
  if (!paymentMethod) return "none";
  // Letter of Credit — any LC variant
  if (
    paymentMethod.startsWith("lc_") ||
    paymentMethod === "lc_confirmed" ||
    paymentMethod === "lc_transferable"
  ) {
    return "lc";
  }
  // Advance / split payments — bank guarantee is OPTIONAL (must be requested)
  if (
    ["advance_100", "cia", "tt_advance", "30_70_bl", "20_80_bl", "50_50", "40_60_proforma"].includes(
      paymentMethod,
    )
  ) {
    return "guarantee";
  }
  // Net terms, D/P, D/A, CAD, open account, consignment, custom → no LC, no guarantee
  return "none";
}

/**
 * Calculate bank costs based on payment method + transaction value.
 * Returns a list of cost items with calculated amounts.
 *
 * NOTE: This returns ONLY trade-finance costs (LC issuance, advising,
 * confirmation, etc.). Transfer fees (SWIFT, correspondent, FX spread)
 * are calculated separately via `calculateTransferFees` — they apply to
 * ALL international payments regardless of payment method.
 */
export function calculateBankCosts(
  paymentMethod: string,
  transactionValue: number, // total deal value in the payment currency
  customRates?: Record<string, number>, // override defaults
  numDrawings?: number, // for per_drawing costs
): BankCostResult[] {
  const results: BankCostResult[] = [];

  // Determine if this payment method uses LC/trade finance.
  // Advance / guarantee methods return no costs by default — bank guarantees
  // are OPTIONAL and must be explicitly requested (out of scope here).
  const instrument = classifyPaymentMethod(paymentMethod);
  if (instrument === "none" || instrument === "guarantee") {
    return [];
  }

  for (const cost of BANK_COSTS) {
    // Check if this cost applies to the selected payment method
    if (!cost.applicablePaymentMethods.includes(paymentMethod)) continue;

    const rate = customRates?.[cost.id] ?? cost.defaultValue;
    let amount = 0;

    switch (cost.basis) {
      case "percent":
        amount = (transactionValue * rate) / 100;
        break;
      case "fixed":
        amount = rate;
        break;
      case "per_drawing":
        amount = rate * (numDrawings || 1);
        break;
      case "per_period":
        // Per quarter — assume 1 quarter for now
        amount = (transactionValue * rate) / 100;
        break;
    }

    results.push({
      id: cost.id,
      label: cost.label,
      amount: Math.round(amount * 100) / 100,
      basis: cost.basis,
    });
  }

  return results;
}

/**
 * Get applicable bank costs for a payment method (for UI display).
 */
export function getBankCostsForPaymentMethod(paymentMethod: string): BankCostItem[] {
  return BANK_COSTS.filter((c) => c.applicablePaymentMethods.includes(paymentMethod));
}

// ============================================================
// International transfer fees (SWIFT / wire transfers)
// ============================================================
// These are per-transfer fees that apply to EVERY international payment,
// regardless of payment method. They are based on World Bank remittance
// pricing + correspondent banking surveys.
//
// IMPORTANT: Transfer fees are ALWAYS present when money moves
// internationally. They are independent of trade-finance costs (LC, etc.)
// and are added on top of any LC fees the payment method may incur.

export interface TransferFeeItem {
  id: string;
  label: string;
  description: string;
  basis: "fixed" | "percent" | "tiered";
  defaultValue: number; // fixed amount or percentage
  // For tiered: different rates for different amount ranges
  tiers?: Array<{ min: number; max: number; rate: number; type: "fixed" | "percent" }>;
}

export const TRANSFER_FEES: TransferFeeItem[] = [
  {
    id: "swift_outgoing",
    label: "SWIFT Outgoing Transfer Fee",
    description:
      "Fee charged by sender's bank for initiating an international SWIFT transfer",
    basis: "tiered",
    defaultValue: 40,
    tiers: [
      { min: 0, max: 50000, rate: 25, type: "fixed" }, // Up to $50K: $25-40
      { min: 50000, max: 500000, rate: 40, type: "fixed" }, // $50K-$500K: $40-60
      { min: 500000, max: 5000000, rate: 50, type: "fixed" }, // $500K-$5M: $50-75
      { min: 5000000, max: Infinity, rate: 75, type: "fixed" }, // Over $5M: $75-100
    ],
  },
  {
    id: "correspondent_bank_intermediary",
    label: "Correspondent/Intermediary Bank Fee",
    description:
      "Fee deducted by correspondent banks during the transfer (typically $15-30 per hop, 1-3 hops)",
    basis: "fixed",
    defaultValue: 25,
  },
  {
    id: "beneficiary_bank_inbound",
    label: "Beneficiary Bank Inbound Fee",
    description:
      "Fee charged by the receiving bank for processing an incoming international transfer",
    basis: "fixed",
    defaultValue: 15,
  },
  {
    id: "fx_spread_cost",
    label: "FX Spread Cost (Hidden)",
    description:
      "Hidden cost from bank's buy/sell spread on currency conversion (typically 0.5-2% of amount)",
    basis: "percent",
    defaultValue: 1.0, // 1% average hidden FX cost
  },
];

export interface TransferFeeResult {
  id: string;
  label: string;
  amount: number;
  description: string;
}

/**
 * Calculate transfer fees for a given amount.
 * @param amount Transaction value in the transfer currency
 * @param currency Currency code (advisory only — fees are in same currency)
 * @param numTransfers How many separate transfers will be made (e.g. 30% advance
 *                     + 70% on B/L = 2 transfers)
 * @param customRates Optional overrides keyed by fee id
 */
export function calculateTransferFees(
  amount: number,
  currency: string,
  numTransfers: number = 1,
  customRates?: Record<string, number>,
): TransferFeeResult[] {
  const results: TransferFeeResult[] = [];
  const transfers = Math.max(1, numTransfers || 1);

  for (const fee of TRANSFER_FEES) {
    let amountPerTransfer = 0;
    const rate = customRates?.[fee.id] ?? fee.defaultValue;

    if (fee.basis === "tiered" && fee.tiers) {
      const tier = fee.tiers.find((t) => amount >= t.min && amount < t.max);
      if (tier) {
        amountPerTransfer =
          tier.type === "percent" ? (amount * tier.rate) / 100 : tier.rate;
      }
    } else if (fee.basis === "percent") {
      amountPerTransfer = (amount * rate) / 100;
    } else {
      amountPerTransfer = rate;
    }

    // Multiply by number of transfers (e.g. 30%+70% = 2 SWIFT messages)
    const total = amountPerTransfer * transfers;

    results.push({
      id: fee.id,
      label: fee.label,
      amount: Math.round(total * 100) / 100,
      description: `${fee.description} (${transfers} transfer${transfers > 1 ? "s" : ""})`,
    });
  }

  return results;
}

/**
 * Determine number of transfers based on payment method.
 * E.g. 30% advance + 70% on BL = 2 transfers.
 * LCs typically settle as a single drawing.
 */
export function getNumTransfersForPaymentMethod(paymentMethod: string): number {
  if (!paymentMethod) return 1;
  if (
    paymentMethod.startsWith("30_70") ||
    paymentMethod.startsWith("20_80") ||
    paymentMethod.startsWith("40_60") ||
    paymentMethod.startsWith("50_50")
  ) {
    return 2;
  }
  // LC methods are usually a single drawing
  if (paymentMethod.startsWith("lc_")) return 1;
  // Single payment methods
  if (
    paymentMethod === "advance_100" ||
    paymentMethod === "cia" ||
    paymentMethod === "tt_advance" ||
    paymentMethod === "dp" ||
    paymentMethod === "cad" ||
    paymentMethod === "da"
  ) {
    return 1;
  }
  // Net terms settle as a single transfer
  if (paymentMethod.startsWith("net")) return 1;
  return 1; // default
}
