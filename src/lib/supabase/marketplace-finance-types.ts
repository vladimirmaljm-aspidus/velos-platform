// Marketplace Phase 7 — finance types.
//
// Backs the tables added in migration 049_marketplace_finance.sql:
//   • marketplace_financial_instruments — one row per L/C, escrow, factoring
//     arrangement, trade-credit insurance policy, or payment schedule.
//   • marketplace_payment_milestones     — the staged-payment rows backing a
//     `payment_schedule` instrument (advance → on_loading → on_arrival →
//     on_inspection_pass → on_delivery, with `manual` as a catch-all).
//
// The `instrument_type` discriminator drives which optional fields are
// populated: L/C rows fill the `lc_*` block, escrow rows fill the
// `escrow_*` block, factoring rows fill `factoring_*`, insurance rows fill
// `insurance_*`, and payment schedules keep their stage list both as a
// denormalised `payment_milestones` JSONB column on the instrument AND as
// real rows in `marketplace_payment_milestones` (the JSONB column is the
// immutable snapshot of the agreed schedule; the rows are the live payment
// ledger with per-milestone status + paid_date + reference_number).
//
// The lifecycle:
//   draft → submitted → approved → active → completed
// with `rejected` (after submitted) and `disputed` (after active) as
// parallel states, and `released` / `refunded` as the escrow-specific
// terminal states.

// ─── Instrument type discriminator ─────────────────────────────────────────

export type InstrumentType =
  | "letter_of_credit"
  | "escrow"
  | "factoring"
  | "trade_credit_insurance"
  | "payment_schedule";

/**
 * Canonical label keys for each instrument type. The component layer maps
 * these through the i18n store — keeping the keys here means the label
 * lookup is type-checked at compile time.
 */
export const INSTRUMENT_TYPE_LABEL_KEY: Record<InstrumentType, string> = {
  letter_of_credit: "marketplace-finance-type-lc",
  escrow: "marketplace-finance-type-escrow",
  factoring: "marketplace-finance-type-factoring",
  trade_credit_insurance: "marketplace-finance-type-insurance",
  payment_schedule: "marketplace-finance-type-payment-schedule",
};

// ─── Instrument status ──────────────────────────────────────────────────────

export type InstrumentStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "active"
  | "completed"
  | "rejected"
  | "disputed"
  | "released"
  | "refunded";

/**
 * Allowed instrument-status transitions. The lifecycle is mostly linear
 * (draft → submitted → approved → active → completed), with off-ramps:
 *   • submitted → rejected
 *   • active → disputed → active (re-resolved) or completed
 *   • escrow active → released / refunded (terminal)
 * `completed`, `released`, `refunded`, `rejected` are terminal.
 */
export const ALLOWED_INSTRUMENT_TRANSITIONS: Record<InstrumentStatus, InstrumentStatus[]> = {
  draft:     ["submitted", "active"],
  submitted: ["approved", "rejected", "draft"],
  approved:  ["active", "rejected"],
  active:    ["completed", "disputed", "released", "refunded"],
  disputed:  ["active", "completed", "released", "refunded"],
  completed: [],
  rejected:  [],
  released:  [],
  refunded:  [],
};

/**
 * Returns true if the status transition `from → to` is permitted under the
 * instrument lifecycle. Used by updateInstrumentStatus + releaseEscrow.
 */
export function canTransitionInstrumentStatus(
  from: InstrumentStatus,
  to: InstrumentStatus,
): boolean {
  if (from === to) return true;
  const allowed = ALLOWED_INSTRUMENT_TRANSITIONS[from];
  return (allowed as InstrumentStatus[] | undefined)?.includes(to) ?? false;
}

export const INSTRUMENT_STATUS_LABEL_KEY: Record<InstrumentStatus, string> = {
  draft: "marketplace-finance-status-draft",
  submitted: "marketplace-finance-status-submitted",
  approved: "marketplace-finance-status-approved",
  active: "marketplace-finance-status-active",
  completed: "marketplace-finance-status-completed",
  rejected: "marketplace-finance-status-rejected",
  disputed: "marketplace-finance-status-disputed",
  released: "marketplace-finance-status-released",
  refunded: "marketplace-finance-status-refunded",
};

// ─── Milestone status + trigger conditions ─────────────────────────────────

export type MilestoneStatus =
  | "pending"
  | "due"
  | "paid"
  | "overdue"
  | "cancelled";

export const MILESTONE_STATUS_LABEL_KEY: Record<MilestoneStatus, string> = {
  pending: "marketplace-finance-milestone-status-pending",
  due: "marketplace-finance-milestone-status-due",
  paid: "marketplace-finance-milestone-status-paid",
  overdue: "marketplace-finance-milestone-status-overdue",
  cancelled: "marketplace-finance-milestone-status-cancelled",
};

export type TriggerCondition =
  | "contract_signed"
  | "advance_payment"
  | "on_loading"
  | "on_departure"
  | "on_arrival"
  | "on_inspection_pass"
  | "on_delivery"
  | "manual";

export const TRIGGER_CONDITION_LABEL_KEY: Record<TriggerCondition, string> = {
  contract_signed: "marketplace-finance-trigger-contract-signed",
  advance_payment: "marketplace-finance-trigger-advance-payment",
  on_loading: "marketplace-finance-trigger-on-loading",
  on_departure: "marketplace-finance-trigger-on-departure",
  on_arrival: "marketplace-finance-trigger-on-arrival",
  on_inspection_pass: "marketplace-finance-trigger-on-inspection-pass",
  on_delivery: "marketplace-finance-trigger-on-delivery",
  manual: "marketplace-finance-trigger-manual",
};

// ─── L/C specific ──────────────────────────────────────────────────────────

export type LCType =
  | "irrevocable"
  | "revocable"
  | "confirmed"
  | "unconfirmed"
  | "transferable"
  | "back_to_back"
  | "standby";

export const LC_TYPE_LABEL_KEY: Record<LCType, string> = {
  irrevocable: "marketplace-finance-lc-type-irrevocable",
  revocable: "marketplace-finance-lc-type-revocable",
  confirmed: "marketplace-finance-lc-type-confirmed",
  unconfirmed: "marketplace-finance-lc-type-unconfirmed",
  transferable: "marketplace-finance-lc-type-transferable",
  back_to_back: "marketplace-finance-lc-type-back-to-back",
  standby: "marketplace-finance-lc-type-standby",
};

/**
 * Standard documents required to draw down a Letter of Credit under UCP 600.
 * The exact document set depends on the L/C type + the underlying transaction
 * (sale of goods, services, standby etc.), but this is the common checklist
 * surfaced by the L/C calculator. Each entry pairs a stable code (used as a
 * React key + stored verbatim in `lc_documents_required`) with an i18n key.
 */
export interface LCRequiredDocument {
  code: string;
  label_key: string;
  /** Whether the document is mandatory under UCP 600 for this L/C type. */
  required: boolean;
}

export const LC_REQUIRED_DOCUMENTS: LCRequiredDocument[] = [
  { code: "commercial_invoice", label_key: "marketplace-finance-lc-doc-commercial-invoice", required: true },
  { code: "packing_list", label_key: "marketplace-finance-lc-doc-packing-list", required: true },
  { code: "bill_of_lading", label_key: "marketplace-finance-lc-doc-bill-of-lading", required: true },
  { code: "certificate_of_origin", label_key: "marketplace-finance-lc-doc-certificate-of-origin", required: true },
  { code: "insurance_certificate", label_key: "marketplace-finance-lc-doc-insurance-certificate", required: true },
  { code: "inspection_certificate", label_key: "marketplace-finance-lc-doc-inspection-certificate", required: false },
  { code: "phytosanitary_certificate", label_key: "marketplace-finance-lc-doc-phytosanitary", required: false },
  { code: "beneficiary_certificate", label_key: "marketplace-finance-lc-doc-beneficiary-certificate", required: false },
];

/**
 * Documents that are commonly required (but not strictly mandatory) for a
 * given L/C type. Used by the L/C calculator to flag which optional
 * documents are typically requested for the chosen type.
 */
export const LC_OPTIONAL_DOCUMENTS_BY_TYPE: Record<LCType, string[]> = {
  irrevocable: ["inspection_certificate", "beneficiary_certificate"],
  revocable: [],
  confirmed: ["inspection_certificate", "beneficiary_certificate"],
  unconfirmed: ["beneficiary_certificate"],
  transferable: ["inspection_certificate", "beneficiary_certificate"],
  back_to_back: ["inspection_certificate", "beneficiary_certificate"],
  standby: ["beneficiary_certificate"],
};

// ─── Escrow release conditions ─────────────────────────────────────────────

export type EscrowReleaseCondition =
  | "delivery_confirmation"
  | "inspection_pass"
  | "both_parties_confirm"
  | "manual";

export const ESCROW_RELEASE_CONDITION_LABEL_KEY: Record<EscrowReleaseCondition, string> = {
  delivery_confirmation: "marketplace-finance-escrow-condition-delivery",
  inspection_pass: "marketplace-finance-escrow-condition-inspection",
  both_parties_confirm: "marketplace-finance-escrow-condition-both",
  manual: "marketplace-finance-escrow-condition-manual",
};

// ─── Risk level (used by the insurance calculator) ─────────────────────────

export type RiskLevel = "low" | "medium" | "high" | "very_high";

export const RISK_LEVEL_LABEL_KEY: Record<RiskLevel, string> = {
  low: "marketplace-finance-risk-low",
  medium: "marketplace-finance-risk-medium",
  high: "marketplace-finance-risk-high",
  very_high: "marketplace-finance-risk-very-high",
};

// ─── marketplace_financial_instruments ──────────────────────────────────────

export interface FinancialInstrument {
  id: string;
  tenant_id: string;
  partner_id: string;
  post_id: string | null;
  negotiation_id: string | null;
  instrument_type: InstrumentType;
  status: InstrumentStatus;
  amount: number;
  currency: string;
  // L/C specific
  lc_type: LCType | null;
  lc_issuing_bank: string | null;
  lc_advising_bank: string | null;
  lc_expiry_date: string | null;
  lc_documents_required: string[];
  // Escrow specific
  escrow_release_condition: EscrowReleaseCondition | null;
  escrow_held_until: string | null;
  // Factoring specific
  factoring_company: string | null;
  factoring_discount_rate: number | null;
  factoring_advance_rate: number | null;
  // Insurance specific
  insurance_provider: string | null;
  insurance_coverage: number | null;
  insurance_premium: number | null;
  // Payment schedule (snapshot of the agreed milestones)
  payment_milestones: MilestoneSnapshot[];
  // Common
  counterparty_partner_id: string | null;
  terms: string | null;
  documents: Record<string, unknown>[];
  created_at: string;
  updated_at: string;
}

/**
 * Lightweight snapshot of a payment milestone stored in the
 * `payment_milestones` JSONB column on the instrument. The live payment
 * ledger (with status + paid_date) lives in the
 * `marketplace_payment_milestones` rows; this snapshot is the immutable
 * record of the agreed schedule at instrument-creation time.
 */
export interface MilestoneSnapshot {
  sequence: number;
  description: string;
  percentage: number;
  amount: number | null;
  trigger_condition: TriggerCondition;
  due_date: string | null;
}

// ─── marketplace_payment_milestones ─────────────────────────────────────────

export interface PaymentMilestone {
  id: string;
  instrument_id: string;
  sequence: number;
  description: string;
  percentage: number;
  amount: number | null;
  trigger_condition: TriggerCondition;
  status: MilestoneStatus;
  due_date: string | null;
  paid_date: string | null;
  reference_number: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentMilestoneCreate {
  sequence: number;
  description: string;
  percentage: number;
  amount?: number | null;
  trigger_condition: TriggerCondition;
  due_date?: string | null;
  reference_number?: string | null;
}

export interface PaymentMilestoneUpdate {
  status?: MilestoneStatus;
  paid_date?: string | null;
  reference_number?: string | null;
}

// ─── Instrument creation inputs ─────────────────────────────────────────────
//
// Each instrument type has a dedicated create input that narrows the
// generic FinancialInstrument row. The store's `createInstrument` accepts a
// discriminated union of these inputs; the `instrument_type` field selects
// which optional blocks are persisted.

export interface InstrumentCreateBase {
  post_id?: string | null;
  negotiation_id?: string | null;
  amount: number;
  currency?: string;
  counterparty_partner_id?: string | null;
  terms?: string | null;
  status?: InstrumentStatus;
}

export interface LCCreate extends InstrumentCreateBase {
  instrument_type: "letter_of_credit";
  lc_type: LCType;
  lc_issuing_bank?: string | null;
  lc_advising_bank?: string | null;
  lc_expiry_date?: string | null;
  lc_documents_required?: string[];
}

export interface EscrowCreate extends InstrumentCreateBase {
  instrument_type: "escrow";
  escrow_release_condition: EscrowReleaseCondition;
  escrow_held_until?: string | null;
}

export interface FactoringCreate extends InstrumentCreateBase {
  instrument_type: "factoring";
  factoring_company?: string | null;
  factoring_discount_rate: number;
  factoring_advance_rate: number;
}

export interface InsuranceCreate extends InstrumentCreateBase {
  instrument_type: "trade_credit_insurance";
  insurance_provider?: string | null;
  insurance_coverage: number;
  insurance_premium?: number | null;
}

export interface PaymentScheduleCreate extends InstrumentCreateBase {
  instrument_type: "payment_schedule";
  milestones: PaymentMilestoneCreate[];
}

export type InstrumentCreate =
  | LCCreate
  | EscrowCreate
  | FactoringCreate
  | InsuranceCreate
  | PaymentScheduleCreate;

export interface InstrumentUpdate {
  status?: InstrumentStatus;
  terms?: string | null;
  lc_issuing_bank?: string | null;
  lc_advising_bank?: string | null;
  lc_expiry_date?: string | null;
  lc_documents_required?: string[];
  escrow_release_condition?: EscrowReleaseCondition | null;
  escrow_held_until?: string | null;
  factoring_company?: string | null;
  factoring_discount_rate?: number | null;
  factoring_advance_rate?: number | null;
  insurance_provider?: string | null;
  insurance_coverage?: number | null;
  insurance_premium?: number | null;
}

// ─── Calculator results (pure functions in the store) ──────────────────────

export interface FactoringCost {
  invoice_amount: number;
  advance_rate: number; // percentage, e.g. 80 = 80%
  discount_rate: number; // percentage, e.g. 2.5 = 2.5%
  advance_amount: number;
  discount_fee: number;
  reserve_amount: number;
  net_payout: number;
  currency: string;
  notes: string;
}

export interface InsurancePremium {
  insured_amount: number;
  coverage_pct: number; // percentage of insured amount covered
  coverage_amount: number;
  risk_level: RiskLevel;
  base_rate: number; // percentage per mille
  premium: number;
  currency: string;
  notes: string;
}

export interface LCChecklist {
  lc_type: LCType;
  required_documents: LCRequiredDocument[];
  optional_documents: LCRequiredDocument[];
  notes: string;
}
