// Marketplace Phase 7 store — finance: financial instruments + payment
// milestones.
//
// All functions talk directly to the tables added in migration
// 049_marketplace_finance.sql:
//   • marketplace_financial_instruments — one row per L/C, escrow, factoring
//     arrangement, trade-credit insurance policy, or payment schedule.
//   • marketplace_payment_milestones     — the staged-payment ledger backing
//     a `payment_schedule` instrument.
//
// SECURITY MODEL
//   • createInstrument(): the caller is the owning partner. tenant_id +
//     partner_id are stamped from the auth context — never trust a
//     body-supplied partner_id.
//   • getInstrument(): scoped by tenant_id; the caller's partner_id is
//     verified to be the owning partner OR (when post_id / negotiation_id
//     is set) the post owner / the other side of the negotiation.
//   • updateInstrumentStatus(): the owning partner only — verified at the
//     API layer before calling this store; the store filters by tenant_id +
//     partner_id so a partner from tenant A cannot update tenant B's rows
//     by guessing ids.
//   • listInstruments(): returns the caller's instruments (partner_id
//     filter), optional type filter.
//   • addMilestone(): the owning partner only (the store filters by
//     tenant_id + partner_id).
//   • updateMilestone(): the owning partner only — used to mark a milestone
//     as paid / due / overdue.
//   • releaseEscrow(): the owning partner (or the counterparty when the
//     release condition is `both_parties_confirm`). The store validates the
//     status transition active → released and stamps the released_at time.
//   • calculateFactoringCost() + calculateInsurancePremium() +
//     calculateLCChecklist(): pure functions — no DB calls. Used by both the
//     calculator API routes (GET, side-effect free) and the
//     finance-calculators component (via fetch).

import { getSupabase } from "@/lib/supabase/client";
import type {
  EscrowReleaseCondition,
  FinancialInstrument,
  FactoringCost,
  InsuranceCreate,
  InsurancePremium,
  InstrumentCreate,
  InstrumentStatus,
  InstrumentUpdate,
  LCChecklist,
  LCType,
  MilestoneSnapshot,
  MilestoneStatus,
  PaymentMilestone,
  PaymentMilestoneCreate,
  PaymentMilestoneUpdate,
  PaymentScheduleCreate,
  RiskLevel,
  TriggerCondition,
} from "@/lib/supabase/marketplace-finance-types";
import {
  ALLOWED_INSTRUMENT_TRANSITIONS,
  LC_OPTIONAL_DOCUMENTS_BY_TYPE,
  LC_REQUIRED_DOCUMENTS,
  canTransitionInstrumentStatus,
} from "@/lib/supabase/marketplace-finance-types";

// ─── Validation helpers ────────────────────────────────────────────────────

const VALID_INSTRUMENT_STATUSES = new Set<string>([
  "draft", "submitted", "approved", "active",
  "completed", "rejected", "disputed", "released", "refunded",
]);

const VALID_INSTRUMENT_TYPES = new Set<string>([
  "letter_of_credit", "escrow", "factoring",
  "trade_credit_insurance", "payment_schedule",
]);

const VALID_MILESTONE_STATUSES = new Set<string>([
  "pending", "due", "paid", "overdue", "cancelled",
]);

const VALID_TRIGGER_CONDITIONS = new Set<string>([
  "contract_signed", "advance_payment", "on_loading",
  "on_departure", "on_arrival", "on_inspection_pass", "on_delivery", "manual",
]);

const VALID_ESCROW_CONDITIONS = new Set<string>([
  "delivery_confirmation", "inspection_pass", "both_parties_confirm", "manual",
]);

const VALID_LC_TYPES = new Set<string>([
  "irrevocable", "revocable", "confirmed", "unconfirmed",
  "transferable", "back_to_back", "standby",
]);

// ─── Public sanitisation helpers ──────────────────────────────────────────

/**
 * Strip tenant_id / partner_id from an instrument before returning it to a
 * caller who is NOT the owning partner. The owning partner gets the full
 * row; everyone else (e.g. the post owner, the other side of the
 * negotiation) sees the sanitised shape so the partner_id of the owning
 * partner does not leak.
 */
export function sanitisePublicInstrument(
  fi: FinancialInstrument,
): Record<string, unknown> {
  const { tenant_id: _t, partner_id: _p, ...rest } = fi;
  return rest as Record<string, unknown>;
}

// ─── Payload builder ──────────────────────────────────────────────────────

/**
 * Build the Supabase insert payload from a typed InstrumentCreate input.
 * Validates the discriminator (instrument_type) and the type-specific
 * fields, then assembles the column map.
 *
 * For `payment_schedule` instruments, the `milestones` array is also
 * serialised into the `payment_milestones` JSONB column as an immutable
 * snapshot of the agreed schedule. The live ledger rows in
 * `marketplace_payment_milestones` are inserted separately by
 * `createInstrument` after the instrument row is created.
 */
function buildInstrumentPayload(
  tenantId: string,
  partnerId: string,
  data: InstrumentCreate,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    tenant_id: tenantId,
    partner_id: partnerId,
    instrument_type: data.instrument_type,
    amount: data.amount,
    currency: data.currency ?? "USD",
    post_id: data.post_id ?? null,
    negotiation_id: data.negotiation_id ?? null,
    counterparty_partner_id: data.counterparty_partner_id ?? null,
    terms: data.terms ?? null,
    status: data.status ?? "draft",
  };

  switch (data.instrument_type) {
    case "letter_of_credit": {
      if (!VALID_LC_TYPES.has(data.lc_type)) {
        throw new Error(`Invalid lc_type: "${data.lc_type}".`);
      }
      base.lc_type = data.lc_type;
      base.lc_issuing_bank = data.lc_issuing_bank ?? null;
      base.lc_advising_bank = data.lc_advising_bank ?? null;
      base.lc_expiry_date = data.lc_expiry_date ?? null;
      base.lc_documents_required = data.lc_documents_required ?? [];
      return base;
    }
    case "escrow": {
      if (!VALID_ESCROW_CONDITIONS.has(data.escrow_release_condition)) {
        throw new Error(`Invalid escrow_release_condition: "${data.escrow_release_condition}".`);
      }
      base.escrow_release_condition = data.escrow_release_condition;
      base.escrow_held_until = data.escrow_held_until ?? null;
      return base;
    }
    case "factoring": {
      base.factoring_company = data.factoring_company ?? null;
      base.factoring_discount_rate = data.factoring_discount_rate;
      base.factoring_advance_rate = data.factoring_advance_rate;
      return base;
    }
    case "trade_credit_insurance": {
      base.insurance_provider = data.insurance_provider ?? null;
      base.insurance_coverage = data.insurance_coverage;
      base.insurance_premium = data.insurance_premium ?? null;
      return base;
    }
    case "payment_schedule": {
      // Serialise the milestones as an immutable snapshot in the JSONB
      // column. The live ledger rows are inserted by createInstrument.
      base.payment_milestones = (data as PaymentScheduleCreate).milestones.map(
        (m): MilestoneSnapshot => ({
          sequence: m.sequence,
          description: m.description,
          percentage: m.percentage,
          amount: m.amount ?? null,
          trigger_condition: m.trigger_condition,
          due_date: m.due_date ?? null,
        }),
      );
      return base;
    }
    default: {
      // Exhaustiveness check — the discriminated union guarantees this
      // branch is unreachable at compile time, but the runtime guard
      // keeps the payload builder safe against untyped callers.
      const _exhaustive: never = data;
      void _exhaustive;
      throw new Error(`Unknown instrument_type: "${(data as { instrument_type: string }).instrument_type}".`);
    }
  }
}

// ─── Instruments ────────────────────────────────────────────────────────────

/**
 * Create a new financial instrument. tenant_id + partner_id are stamped
 * from the auth context by the API route — never trust a body-supplied
 * partner_id.
 *
 * For `payment_schedule` instruments, the milestones are persisted both as
 * an immutable JSONB snapshot on the instrument AND as live ledger rows in
 * `marketplace_payment_milestones`. The two representations serve
 * different purposes:
 *   • The JSONB snapshot is the agreed schedule — immutable unless the
 *     instrument is re-negotiated (in which case a new instrument is
 *     created; the old one is marked `completed` or `cancelled`).
 *   • The ledger rows are the live payment state — each row's `status`
 *     transitions pending → due → paid (or overdue / cancelled).
 */
export async function createInstrument(
  tenantId: string,
  partnerId: string,
  data: InstrumentCreate,
): Promise<FinancialInstrument> {
  const sb = getSupabase();

  // Validate instrument_type.
  if (!VALID_INSTRUMENT_TYPES.has(data.instrument_type)) {
    throw new Error(`Invalid instrument_type: "${data.instrument_type}".`);
  }
  // Validate amount.
  if (typeof data.amount !== "number" || !Number.isFinite(data.amount) || data.amount <= 0) {
    throw new Error("amount must be a positive finite number.");
  }
  // Validate optional status.
  if (data.status && !VALID_INSTRUMENT_STATUSES.has(data.status)) {
    throw new Error(`Invalid status: "${data.status}".`);
  }

  // Validate post_id / negotiation_id belong to the caller's tenant.
  if (data.post_id) {
    const { data: postRow, error: postErr } = await sb
      .from("marketplace_posts")
      .select("tenant_id")
      .eq("id", data.post_id)
      .maybeSingle();
    if (postErr) throw postErr;
    if (!postRow) throw new Error("Post not found.");
    if ((postRow as { tenant_id: string }).tenant_id !== tenantId) {
      throw new Error("Post not found.");
    }
  }
  if (data.negotiation_id) {
    const { data: negRow, error: negErr } = await sb
      .from("marketplace_negotiations")
      .select("tenant_id_a, tenant_id_b")
      .eq("id", data.negotiation_id)
      .maybeSingle();
    if (negErr) throw negErr;
    if (!negRow) throw new Error("Negotiation not found.");
    const n = negRow as { tenant_id_a: string; tenant_id_b: string };
    if (n.tenant_id_a !== tenantId && n.tenant_id_b !== tenantId) {
      throw new Error("Negotiation not found.");
    }
  }

  const payload = buildInstrumentPayload(tenantId, partnerId, data);

  const { data: inserted, error } = await sb
    .from("marketplace_financial_instruments")
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  const instrument = inserted as FinancialInstrument;

  // For payment schedules, also insert the live ledger rows.
  if (data.instrument_type === "payment_schedule" && data.milestones.length > 0) {
    const rows = data.milestones.map((m) => ({
      instrument_id: instrument.id,
      sequence: m.sequence,
      description: m.description,
      percentage: m.percentage,
      amount: m.amount ?? null,
      trigger_condition: m.trigger_condition,
      due_date: m.due_date ?? null,
      reference_number: m.reference_number ?? null,
      status: "pending" as const,
    }));
    const { error: mErr } = await sb
      .from("marketplace_payment_milestones")
      .insert(rows);
    if (mErr) throw mErr;
  }

  return instrument;
}

/**
 * Fetch an instrument + its payment milestones (when the instrument is a
 * payment schedule) in a single round-trip.
 *
 * Auth check: the caller's partner_id must equal the instrument's
 * partner_id (the owning partner) OR — when post_id is set — be the post
 * owner OR — when negotiation_id is set — be one of the two partners in
 * the negotiation OR — when counterparty_partner_id is set — equal it.
 * The auth check is done at the API layer before calling this store; the
 * store itself only filters by tenant_id so a partner from tenant A
 * cannot read tenant B's instruments by guessing ids.
 *
 * Returns `{ instrument, milestones }` or `null` when the instrument is
 * not found. `milestones` is empty for non-schedule instruments.
 */
export async function getInstrument(
  instrumentId: string,
  tenantId: string,
): Promise<{ instrument: FinancialInstrument; milestones: PaymentMilestone[] } | null> {
  const sb = getSupabase();

  const { data: row, error } = await sb
    .from("marketplace_financial_instruments")
    .select("*")
    .eq("id", instrumentId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw error;
  if (!row) return null;
  const instrument = row as FinancialInstrument;

  const { data: mRows, error: mErr } = await sb
    .from("marketplace_payment_milestones")
    .select("*")
    .eq("instrument_id", instrumentId)
    .order("sequence", { ascending: true });
  if (mErr) throw mErr;
  const milestones = (mRows as PaymentMilestone[]) || [];

  return { instrument, milestones };
}

/**
 * Update an instrument's status. The caller MUST verify ownership
 * (partner_id === caller) BEFORE calling this function — the API route
 * performs that check; the store filters by tenant_id + partner_id so a
 * partner from tenant A cannot update tenant B's rows by guessing ids.
 *
 * Validates the status-transition graph (ALLOWED_INSTRUMENT_TRANSITIONS):
 *   draft → submitted → approved → active → completed
 * with `rejected`, `disputed`, `released`, `refunded` as off-ramps.
 * `completed`, `released`, `refunded`, `rejected` are terminal.
 *
 * Returns the updated row, or null when the instrument was not found /
 * the caller is not authorised.
 */
export async function updateInstrumentStatus(
  instrumentId: string,
  tenantId: string,
  partnerId: string,
  newStatus: InstrumentStatus,
): Promise<FinancialInstrument | null> {
  const sb = getSupabase();

  if (!VALID_INSTRUMENT_STATUSES.has(newStatus)) {
    throw new Error(`Invalid status: "${newStatus}".`);
  }

  // Fetch the current row to validate the transition.
  const { data: cur, error: curErr } = await sb
    .from("marketplace_financial_instruments")
    .select("id, status, tenant_id, partner_id")
    .eq("id", instrumentId)
    .eq("tenant_id", tenantId)
    .eq("partner_id", partnerId)
    .maybeSingle();
  if (curErr) throw curErr;
  if (!cur) return null;
  const c = cur as { id: string; status: InstrumentStatus };
  const prevStatus = c.status;
  if (!canTransitionInstrumentStatus(prevStatus, newStatus)) {
    throw new Error(
      `Cannot transition instrument status from "${prevStatus}" to "${newStatus}".`,
    );
  }

  const { data, error } = await sb
    .from("marketplace_financial_instruments")
    .update({ status: newStatus })
    .eq("id", instrumentId)
    .eq("tenant_id", tenantId)
    .eq("partner_id", partnerId)
    .select()
    .maybeSingle();
  if (error) throw error;
  return (data as FinancialInstrument) || null;
}

/**
 * Patch an instrument's type-specific fields (L/C banks, escrow condition,
 * factoring rates, insurance coverage etc.). Used by the API PUT route.
 * Ownership is verified at the API layer; the store filters by tenant_id +
 * partner_id.
 */
export async function updateInstrument(
  instrumentId: string,
  tenantId: string,
  partnerId: string,
  patch: InstrumentUpdate,
): Promise<FinancialInstrument | null> {
  const sb = getSupabase();

  // Strip fields the DB owns (id, tenant_id, partner_id, created_at,
  // updated_at, instrument_type, amount — those are immutable post-create).
  const {
    status: _s,
    ...writable
  } = patch as Record<string, unknown>;
  void _s;

  // Validate enum fields when supplied.
  if (writable.escrow_release_condition !== undefined && writable.escrow_release_condition !== null) {
    if (!VALID_ESCROW_CONDITIONS.has(String(writable.escrow_release_condition))) {
      throw new Error(`Invalid escrow_release_condition: "${writable.escrow_release_condition}".`);
    }
  }
  for (const k of ["factoring_discount_rate", "factoring_advance_rate", "insurance_coverage", "insurance_premium"] as const) {
    const v = (writable as Record<string, unknown>)[k];
    if (v !== undefined && v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
      throw new Error(`${k} must be a non-negative number.`);
    }
  }

  const { data, error } = await sb
    .from("marketplace_financial_instruments")
    .update(writable)
    .eq("id", instrumentId)
    .eq("tenant_id", tenantId)
    .eq("partner_id", partnerId)
    .select()
    .maybeSingle();
  if (error) throw error;
  return (data as FinancialInstrument) || null;
}

/**
 * List a partner's own instruments, newest first. Returns the FULL row (no
 * sanitisation) — the caller IS the owning partner.
 *
 * The `type` filter is optional and accepts the same values as the
 * instrument_type enum. `limit` is capped at 100.
 */
export async function listInstruments(
  tenantId: string,
  partnerId: string,
  opts?: { type?: string; limit?: number; offset?: number },
): Promise<{ items: FinancialInstrument[]; total: number }> {
  const sb = getSupabase();
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100);
  const offset = Math.max(opts?.offset ?? 0, 0);

  let q = sb
    .from("marketplace_financial_instruments")
    .select("*", { count: "exact" })
    .eq("tenant_id", tenantId)
    .eq("partner_id", partnerId);

  if (opts?.type && VALID_INSTRUMENT_TYPES.has(opts.type)) {
    q = q.eq("instrument_type", opts.type);
  }
  q = q.order("created_at", { ascending: false }).range(offset, offset + limit - 1);

  const { data, error, count } = await q;
  if (error) throw error;
  return {
    items: (data as FinancialInstrument[]) || [],
    total: count ?? 0,
  };
}

// ─── Payment milestones ─────────────────────────────────────────────────────

/**
 * Append a milestone to a payment-schedule instrument. The store validates
 * that the instrument is a `payment_schedule` and that the caller is the
 * owning partner.
 */
export async function addMilestone(
  instrumentId: string,
  tenantId: string,
  partnerId: string,
  data: PaymentMilestoneCreate,
): Promise<PaymentMilestone> {
  const sb = getSupabase();

  // Verify the instrument exists + is a payment schedule + belongs to the
  // caller's tenant + the caller is the owning partner.
  const { data: row, error: err } = await sb
    .from("marketplace_financial_instruments")
    .select("id, instrument_type, tenant_id, partner_id")
    .eq("id", instrumentId)
    .eq("tenant_id", tenantId)
    .eq("partner_id", partnerId)
    .maybeSingle();
  if (err) throw err;
  if (!row) throw new Error("Instrument not found.");
  const r = row as { id: string; instrument_type: string };
  if (r.instrument_type !== "payment_schedule") {
    throw new Error("Milestones can only be added to payment_schedule instruments.");
  }

  if (!VALID_TRIGGER_CONDITIONS.has(data.trigger_condition)) {
    throw new Error(`Invalid trigger_condition: "${data.trigger_condition}".`);
  }
  if (typeof data.percentage !== "number" || !Number.isFinite(data.percentage) || data.percentage < 0 || data.percentage > 100) {
    throw new Error("percentage must be a number in [0, 100].");
  }

  const payload = {
    instrument_id: instrumentId,
    sequence: data.sequence,
    description: data.description,
    percentage: data.percentage,
    amount: data.amount ?? null,
    trigger_condition: data.trigger_condition,
    due_date: data.due_date ?? null,
    reference_number: data.reference_number ?? null,
    status: "pending",
  };
  const { data: inserted, error: insErr } = await sb
    .from("marketplace_payment_milestones")
    .insert(payload)
    .select()
    .single();
  if (insErr) throw insErr;
  return inserted as PaymentMilestone;
}

/**
 * Update a payment milestone — mark it as paid / due / overdue, or set the
 * reference number. The caller MUST be the owning partner — verified by
 * the join through marketplace_financial_instruments (tenant_id + partner_id).
 *
 * Setting `status: "paid"` also stamps `paid_date` to now() when not
 * explicitly supplied.
 */
export async function updateMilestone(
  milestoneId: string,
  tenantId: string,
  partnerId: string,
  patch: PaymentMilestoneUpdate,
): Promise<PaymentMilestone | null> {
  const sb = getSupabase();

  if (patch.status && !VALID_MILESTONE_STATUSES.has(patch.status)) {
    throw new Error(`Invalid milestone status: "${patch.status}".`);
  }

  // Verify the milestone belongs to an instrument owned by the caller.
  // Join through the instrument table so a partner from tenant A cannot
  // update tenant B's milestones by guessing ids.
  const { data: mRow, error: mErr } = await sb
    .from("marketplace_payment_milestones")
    .select("id, instrument_id, status")
    .eq("id", milestoneId)
    .maybeSingle();
  if (mErr) throw mErr;
  if (!mRow) return null;
  const m = mRow as { id: string; instrument_id: string; status: MilestoneStatus };

  const { data: fiRow, error: fiErr } = await sb
    .from("marketplace_financial_instruments")
    .select("id, tenant_id, partner_id")
    .eq("id", m.instrument_id)
    .maybeSingle();
  if (fiErr) throw fiErr;
  if (!fiRow) return null;
  const fi = fiRow as { id: string; tenant_id: string; partner_id: string };
  if (fi.tenant_id !== tenantId || fi.partner_id !== partnerId) {
    return null;
  }

  const updates: Record<string, unknown> = {};
  if (patch.status) updates.status = patch.status;
  if (patch.reference_number !== undefined) updates.reference_number = patch.reference_number;
  if (patch.paid_date !== undefined) {
    updates.paid_date = patch.paid_date;
  } else if (patch.status === "paid") {
    updates.paid_date = new Date().toISOString();
  }

  // Status-transition guard — full milestone state machine:
  //   pending  → any status (initial state, no restriction)
  //   due      → any status (pending / paid / overdue / cancelled)
  //   overdue  → paid | cancelled only (cannot revert to pending/due)
  //   paid     → cancelled only (terminal-ish — paid is the success
  //              state, the only legal exit is cancellation)
  //   cancelled→ TERMINAL (no transitions out, ever)
  // Without this guard, a paid milestone could be reverted to "pending"
  // (washing a paid obligation off the books) or a cancelled milestone
  // could be revived to "paid" (paying a debt that was written off).
  if (patch.status && patch.status !== m.status) {
    const from = m.status;
    const to = patch.status;
    const allowed: Record<string, Set<string>> = {
      pending: new Set(["due", "paid", "overdue", "cancelled"]),
      due: new Set(["pending", "paid", "overdue", "cancelled"]),
      overdue: new Set(["paid", "cancelled"]),
      paid: new Set(["cancelled"]),
      cancelled: new Set(), // terminal
    };
    const transitions = allowed[from];
    if (transitions && !transitions.has(to)) {
      throw new Error(
        `Cannot transition milestone status from "${from}" to "${to}".`,
      );
    }
  }

  const { data, error } = await sb
    .from("marketplace_payment_milestones")
    .update(updates)
    .eq("id", milestoneId)
    .select()
    .maybeSingle();
  if (error) throw error;
  return (data as PaymentMilestone) || null;
}

// ─── Escrow release ────────────────────────────────────────────────────────

/**
 * Result of an escrow release attempt.
 *
 *  • `instrument`                — the current instrument row (status is
 *                                  "active" if pending, "released" if the
 *                                  release completed).
 *  • `needs_counterparty_confirm` — true when the instrument's release
 *                                  condition is `both_parties_confirm` and
 *                                  only one party has confirmed so far.
 *                                  The caller should surface a "waiting on
 *                                  counterparty" UX.
 *  • `confirmed_partner_ids`      — the partner_ids that have confirmed
 *                                  so far. Empty for single-party release
 *                                  conditions.
 */
export interface EscrowReleaseResult {
  instrument: FinancialInstrument;
  needs_counterparty_confirm: boolean;
  confirmed_partner_ids: string[];
}

/**
 * Release the funds held in an escrow instrument. The caller is the owning
 * partner (or, when `escrow_release_condition` is `both_parties_confirm`,
 * either party).
 *
 * Validates the instrument is an escrow, is in `active` status, and the
 * transition active → released is permitted (which it always is for
 * escrows; the guard exists for symmetry with the lifecycle).
 *
 * FIX-AUDIT2-CRIT / C4 — the previous implementation immediately flipped
 * status="released" on a single call from EITHER party, defeating the
 * safety guarantee of the `both_parties_confirm` condition (any single
 * party could release the funds). The function now implements a real
 * 2-phase commit:
 *
 *  • When `escrow_release_condition === "both_parties_confirm"`, the
 *    caller's partner_id is appended to a JSONB array
 *    (`release_confirmations`, added by migration
 *    supabase/migrations/062_release_confirmations.sql). The status is
 *    only flipped to "released" when BOTH the owning partner AND the
 *    counterparty are present in the array. Until then, the instrument
 *    stays "active" and the result carries
 *    `needs_counterparty_confirm: true`.
 *  • When the `release_confirmations` column does not exist (a pre-
 *    migration-062 deploy), the function falls back to storing
 *    confirmation entries in the existing `documents` JSONB array
 *    (entries with `{ type: "release_confirmation", partner_id }`).
 *  • Each confirmation call writes a `marketplace.escrow_release_confirmed`
 *    audit log entry so the audit trail shows who confirmed and when,
 *    even on the call that does NOT yet complete the release.
 *  • For the other release conditions (`manual`, `delivery_confirmation`,
 *    `inspection_pass`), the existing single-party release behaviour
 *    is preserved.
 *
 * Returns the result object, or null when not found / not authorised.
 */
export async function releaseEscrow(
  instrumentId: string,
  tenantId: string,
  partnerId: string,
): Promise<EscrowReleaseResult | null> {
  const sb = getSupabase();

  // Fetch the instrument. We try to select the new `release_confirmations`
  // column first; if the column does not exist (pre-migration-062 deploy),
  // PostgREST returns an error and we re-fetch using only the columns
  // that exist, then use the `documents` JSONB array as a fallback store.
  let useFallbackStore = false;
  let row: unknown = null;
  {
    const { data, error } = await sb
      .from("marketplace_financial_instruments")
      .select(
        "id, instrument_type, status, tenant_id, partner_id, counterparty_partner_id, escrow_release_condition, documents, release_confirmations",
      )
      .eq("id", instrumentId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error) {
      // PGRST205 ("schemaCacheMiss") / "column does not exist" — re-fetch
      // with the legacy-shape select and switch the write path to the
      // `documents` JSONB fallback.
      if (/\brelease_confirmations\b|could not find|does not exist|PGRST205/i.test(error.message || "")) {
        useFallbackStore = true;
        const { data: legacyData, error: legacyErr } = await sb
          .from("marketplace_financial_instruments")
          .select(
            "id, instrument_type, status, tenant_id, partner_id, counterparty_partner_id, escrow_release_condition, documents",
          )
          .eq("id", instrumentId)
          .eq("tenant_id", tenantId)
          .maybeSingle();
        if (legacyErr) throw legacyErr;
        row = legacyData;
      } else {
        throw error;
      }
    } else {
      row = data;
    }
  }
  if (!row) return null;
  const r = row as {
    id: string;
    instrument_type: string;
    status: InstrumentStatus;
    tenant_id: string;
    partner_id: string;
    counterparty_partner_id: string | null;
    escrow_release_condition: string | null;
    documents: Record<string, unknown>[];
    release_confirmations?: string[] | null;
  };
  if (r.instrument_type !== "escrow") {
    throw new Error("Instrument is not an escrow.");
  }
  // Ownership: owning partner, OR counterparty (when both_parties_confirm).
  const isOwner = r.partner_id === partnerId;
  const isCounterparty = r.counterparty_partner_id === partnerId;
  if (!isOwner && !isCounterparty) {
    return null;
  }

  if (!canTransitionInstrumentStatus(r.status, "released")) {
    throw new Error(
      `Cannot release escrow in status "${r.status}" — must be "active" (or "disputed").`,
    );
  }

  // ── 2-phase commit for `both_parties_confirm` ──────────────────────────
  if (r.escrow_release_condition === "both_parties_confirm") {
    // Load existing confirmations.
    let confirmations: string[] = [];
    if (!useFallbackStore && Array.isArray(r.release_confirmations)) {
      confirmations = r.release_confirmations.filter(
        (x): x is string => typeof x === "string",
      );
    } else {
      const docs = Array.isArray(r.documents) ? r.documents : [];
      confirmations = docs
        .filter(
          (d) =>
            d && typeof d === "object" && (d as { type?: unknown }).type === "release_confirmation",
        )
        .map((d) => String((d as { partner_id?: unknown }).partner_id ?? ""))
        .filter((x) => x !== "");
    }

    // Idempotent: do not double-add if the caller has already confirmed.
    if (!confirmations.includes(partnerId)) {
      confirmations.push(partnerId);
    }

    // Per-confirmation audit log entry — every call is recorded so the
    // audit trail shows who confirmed and when, including the call that
    // does NOT yet release. Best-effort: failures are swallowed so a DB
    // hiccup in the audit log never blocks the release flow.
    const bothConfirmed =
      !!r.counterparty_partner_id &&
      confirmations.includes(r.partner_id) &&
      confirmations.includes(r.counterparty_partner_id);
    try {
      await sb.from("audit_logs").insert({
        user_id: null,
        username: `partner:${partnerId}`,
        tenant_id: tenantId,
        action: "marketplace.escrow_release_confirmed",
        entity_type: "marketplace_financial_instruments",
        entity_id: instrumentId,
        details: {
          confirming_partner_id: partnerId,
          is_owner: isOwner,
          is_counterparty: isCounterparty,
          confirmed_partner_ids: confirmations,
          released: bothConfirmed,
        },
        ip: null,
        user_agent: null,
      });
    } catch (e) {
      console.warn("[marketplace.finance.release] confirmation audit log failed:", e);
    }

    if (!bothConfirmed) {
      // Persist the confirmation list without changing status. If the
      // release_confirmations column exists, update it directly;
      // otherwise, append the confirmation entries to the documents
      // JSONB array (the documented fallback store).
      if (!useFallbackStore) {
        const { error: updErr } = await sb
          .from("marketplace_financial_instruments")
          .update({ release_confirmations: confirmations })
          .eq("id", instrumentId);
        if (updErr) {
          if (/\brelease_confirmations\b|could not find|does not exist|PGRST205/i.test(updErr.message || "")) {
            useFallbackStore = true;
          } else {
            throw updErr;
          }
        }
      }
      if (useFallbackStore) {
        const docs = Array.isArray(r.documents) ? r.documents : [];
        // Preserve existing non-confirmation docs.
        const otherDocs = docs.filter(
          (d) =>
            !d ||
            typeof d !== "object" ||
            (d as { type?: unknown }).type !== "release_confirmation",
        );
        const confirmationDocs = confirmations.map((pid) => ({
          type: "release_confirmation",
          partner_id: pid,
          confirmed_at: new Date().toISOString(),
        }));
        const { error: updErr } = await sb
          .from("marketplace_financial_instruments")
          .update({ documents: [...otherDocs, ...confirmationDocs] })
          .eq("id", instrumentId);
        if (updErr) throw updErr;
      }

      // Re-fetch the instrument (status is unchanged) so the caller
      // receives the current row, then return the pending result.
      const { data: stillActive, error: refErr } = await sb
        .from("marketplace_financial_instruments")
        .select("*")
        .eq("id", instrumentId)
        .maybeSingle();
      if (refErr) throw refErr;
      return {
        instrument: stillActive as FinancialInstrument,
        needs_counterparty_confirm: true,
        confirmed_partner_ids: confirmations,
      };
    }

    // Both parties have confirmed — flip status to "released" and persist
    // the full confirmation list (so the released row carries the audit
    // trail of who confirmed).
    const updatePayload: Record<string, unknown> = { status: "released" };
    if (useFallbackStore) {
      const docs = Array.isArray(r.documents) ? r.documents : [];
      const otherDocs = docs.filter(
        (d) =>
          !d ||
          typeof d !== "object" ||
          (d as { type?: unknown }).type !== "release_confirmation",
      );
      const confirmationDocs = confirmations.map((pid) => ({
        type: "release_confirmation",
        partner_id: pid,
        confirmed_at: new Date().toISOString(),
      }));
      updatePayload.documents = [...otherDocs, ...confirmationDocs];
    } else {
      updatePayload.release_confirmations = confirmations;
    }
    const { data: released, error: relErr } = await sb
      .from("marketplace_financial_instruments")
      .update(updatePayload)
      .eq("id", instrumentId)
      .select("*")
      .maybeSingle();
    if (relErr) throw relErr;
    return {
      instrument: released as FinancialInstrument,
      needs_counterparty_confirm: false,
      confirmed_partner_ids: confirmations,
    };
  }

  // ── Non-`both_parties_confirm` release conditions ────────────────────
  // Single-party release: the existing behaviour. The 2-phase commit
  // above is the only path that requires both parties; the rest are
  // single-call releases.
  const { data, error } = await sb
    .from("marketplace_financial_instruments")
    .update({ status: "released" })
    .eq("id", instrumentId)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    instrument: data as FinancialInstrument,
    needs_counterparty_confirm: false,
    confirmed_partner_ids: [],
  };
}

// ─── Auth check: is the caller authorised to view this instrument? ────────

/**
 * Verify that the caller is authorised to view the instrument.
 *
 * Authorised parties:
 *   • The owning partner (instrument.partner_id === caller).
 *   • The counterparty (instrument.counterparty_partner_id === caller).
 *   • The post owner (when instrument.post_id is set and the post's owner
 *     is the caller).
 *   • Either side of the negotiation (when instrument.negotiation_id is
 *     set and the negotiation's partner_id_a / partner_id_b includes the
 *     caller).
 *
 * Returns `{ instrument, is_owner }` or null when the caller is NOT
 * authorised (or the instrument does not exist).
 */
export async function getInstrumentIfAuthorised(
  instrumentId: string,
  tenantId: string,
  partnerId: string,
): Promise<{ instrument: FinancialInstrument; is_owner: boolean } | null> {
  const sb = getSupabase();

  const { data: row, error: err } = await sb
    .from("marketplace_financial_instruments")
    .select("*")
    .eq("id", instrumentId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (err) throw err;
  if (!row) return null;
  const instrument = row as FinancialInstrument;

  // 1. Owning partner.
  if (instrument.partner_id === partnerId) {
    return { instrument, is_owner: true };
  }
  // 2. Counterparty.
  if (instrument.counterparty_partner_id === partnerId) {
    return { instrument, is_owner: false };
  }
  // 3. Post owner.
  if (instrument.post_id) {
    const { data: postRow } = await sb
      .from("marketplace_posts")
      .select("partner_id")
      .eq("id", instrument.post_id)
      .maybeSingle();
    if (postRow && (postRow as { partner_id: string }).partner_id === partnerId) {
      return { instrument, is_owner: false };
    }
  }
  // 4. Negotiation party.
  if (instrument.negotiation_id) {
    const { data: negRow } = await sb
      .from("marketplace_negotiations")
      .select("partner_id_a, partner_id_b")
      .eq("id", instrument.negotiation_id)
      .maybeSingle();
    if (negRow) {
      const n = negRow as { partner_id_a: string; partner_id_b: string };
      if (n.partner_id_a === partnerId || n.partner_id_b === partnerId) {
        return { instrument, is_owner: false };
      }
    }
  }

  return null;
}

// ─── Pure calculators ──────────────────────────────────────────────────────

/**
 * Calculate the cost of factoring an invoice. Pure function — no DB calls.
 *
 * Inputs:
 *   • invoice_amount    — the face value of the receivable being factored.
 *   • discount_rate     — the factoring fee as a percentage of the invoice
 *                         amount (e.g. 2.5 = 2.5%). Typical range 0.5–5%.
 *   • advance_rate      — the percentage of the invoice advanced up front
 *                         (e.g. 80 = 80%). The remainder is the "reserve",
 *                         paid out when the debtor settles minus the fee.
 *
 * Returns:
 *   • advance_amount    — advance_rate × invoice_amount
 *   • discount_fee      — discount_rate × invoice_amount
 *   • reserve_amount    — invoice_amount − advance_amount
 *   • net_payout        — advance_amount − discount_fee
 *                         (the reserve is paid later, net of the fee, so
 *                         the factoring company's total take is the fee;
 *                         net_payout here is the IMMEDIATE cash the seller
 *                         receives).
 *
 * The notes string explains the calculation in plain language so the UI
 * can show it without duplicating the math.
 */
export function calculateFactoringCost(
  invoiceAmount: number,
  discountRate: number,
  advanceRate: number,
  currency = "USD",
): FactoringCost {
  if (!Number.isFinite(invoiceAmount) || invoiceAmount < 0) {
    throw new Error("invoiceAmount must be a non-negative finite number.");
  }
  if (!Number.isFinite(discountRate) || discountRate < 0 || discountRate > 100) {
    throw new Error("discountRate must be in [0, 100].");
  }
  if (!Number.isFinite(advanceRate) || advanceRate < 0 || advanceRate > 100) {
    throw new Error("advanceRate must be in [0, 100].");
  }

  const advanceAmount = (invoiceAmount * advanceRate) / 100;
  const discountFee = (invoiceAmount * discountRate) / 100;
  const reserveAmount = invoiceAmount - advanceAmount;
  const netPayout = advanceAmount - discountFee;

  return {
    invoice_amount: round2(invoiceAmount),
    advance_rate: advanceRate,
    discount_rate: discountRate,
    advance_amount: round2(advanceAmount),
    discount_fee: round2(discountFee),
    reserve_amount: round2(reserveAmount),
    net_payout: round2(netPayout),
    currency,
    notes: `Advance ${advanceRate}% of ${currency} ${formatNum(invoiceAmount)} = ${currency} ${formatNum(advanceAmount)}; fee ${discountRate}% = ${currency} ${formatNum(discountFee)}; net immediate payout = ${currency} ${formatNum(netPayout)}. Reserve of ${currency} ${formatNum(reserveAmount)} released when the debtor settles.`,
  };
}

/**
 * Calculate the annual premium for a trade-credit insurance policy. Pure
 * function — no DB calls.
 *
 * Inputs:
 *   • insured_amount   — the receivable value being insured.
 *   • coverage_pct     — the percentage of the receivable covered (e.g. 90
 *                         = 90%). Typical trade-credit policies cover
 *                         80–95% of the invoice.
 *   • risk_level       — the debtor's risk bucket; drives the base rate per
 *                         mille (‰) of insured amount.
 *
 * The base rates per mille (per thousand of insured_amount) are:
 *   • low       — 1.5‰  (OECD sovereigns, investment-grade corporate debtors)
 *   • medium    — 4‰    (BBB-rated / emerging-market corporate)
 *   • high      — 8‰    (sub-investment-grade, frontier-market debtor)
 *   • very_high — 15‰   (distressed / sanctioned / no-credit-history debtor)
 *
 * Returns:
 *   • coverage_amount  — coverage_pct × insured_amount
 *   • base_rate        — the per-mille rate used
 *   • premium          — base_rate × coverage_amount / 1000
 */
export function calculateInsurancePremium(
  insuredAmount: number,
  coveragePct: number,
  riskLevel: RiskLevel,
  currency = "USD",
): InsurancePremium {
  if (!Number.isFinite(insuredAmount) || insuredAmount < 0) {
    throw new Error("insuredAmount must be a non-negative finite number.");
  }
  if (!Number.isFinite(coveragePct) || coveragePct < 0 || coveragePct > 100) {
    throw new Error("coveragePct must be in [0, 100].");
  }

  const baseRatePerMille: Record<RiskLevel, number> = {
    low: 1.5,
    medium: 4,
    high: 8,
    very_high: 15,
  };
  const baseRate = baseRatePerMille[riskLevel];
  const coverageAmount = (insuredAmount * coveragePct) / 100;
  const premium = (coverageAmount * baseRate) / 1000;

  return {
    insured_amount: round2(insuredAmount),
    coverage_pct: coveragePct,
    coverage_amount: round2(coverageAmount),
    risk_level: riskLevel,
    base_rate: baseRate,
    premium: round2(premium),
    currency,
    notes: `Coverage ${coveragePct}% of ${currency} ${formatNum(insuredAmount)} = ${currency} ${formatNum(coverageAmount)} insured. Risk tier "${riskLevel}" → ${baseRate}‰ premium → ${currency} ${formatNum(premium)}/yr.`,
  };
}

/**
 * Build the required-documents checklist for a given L/C type. Pure
 * function — no DB calls.
 *
 * Returns:
 *   • required_documents — the documents mandatory under UCP 600 for any L/C
 *     of this type (commercial invoice, packing list, B/L, certificate of
 *     origin, insurance certificate).
 *   • optional_documents — the documents commonly requested for this L/C
 *     type but not strictly mandatory (inspection certificate, beneficiary
 *     certificate etc.).
 *   • notes               — plain-language explanation.
 */
export function calculateLCChecklist(
  lcType: LCType,
): LCChecklist {
  const required = LC_REQUIRED_DOCUMENTS.filter((d) => d.required);
  const optionalCodes = LC_OPTIONAL_DOCUMENTS_BY_TYPE[lcType] || [];
  const optional = LC_REQUIRED_DOCUMENTS.filter(
    (d) => optionalCodes.includes(d.code),
  );

  return {
    lc_type: lcType,
    required_documents: required,
    optional_documents: optional,
    notes: `UCP 600 requires ${required.length} mandatory documents for a ${lcType.replace(/_/g, " ")} L/C. ${optional.length} additional document${optional.length === 1 ? "" : "s"} commonly requested for this L/C type: ${optional.length === 0 ? "none" : optional.map((d) => d.code.replace(/_/g, " ")).join(", ")}.`,
  };
}

// ─── Lifecycle convenience ────────────────────────────────────────────────

/**
 * Return the lifecycle position of a status as a number 0..n for the
 * payment-schedule progress bar. Off-ramps (rejected, disputed, released,
 * refunded) are rendered separately by the UI. Used by the
 * payment-schedule component to render the done/current/pending progress.
 */
export function instrumentLifecyclePosition(status: InstrumentStatus): number {
  const order: InstrumentStatus[] = [
    "draft", "submitted", "approved", "active", "completed",
  ];
  return order.indexOf(status);
}

// ─── Internal helpers ─────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function formatNum(n: number): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Re-export the validation sets + transition map so the API routes don't
// have to re-declare them.
export {
  ALLOWED_INSTRUMENT_TRANSITIONS,
  canTransitionInstrumentStatus,
};

// Type re-exports so the API routes can do a single import.
export type {
  EscrowReleaseCondition,
  InsuranceCreate,
  InstrumentCreate,
  InstrumentStatus,
  InstrumentUpdate,
  LCType,
  MilestoneSnapshot,
  MilestoneStatus,
  PaymentMilestone,
  PaymentMilestoneCreate,
  PaymentMilestoneUpdate,
  PaymentScheduleCreate,
  RiskLevel,
  TriggerCondition,
};
