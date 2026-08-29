/**
 * Status transition validator for documents & deals.
 *
 * Enforces a state-machine for offers, invoices, proformas and deals so a
 * finalised document can't be silently reverted (e.g. a paid invoice going
 * back to "draft"). Super-admins always bypass — they manage the platform
 * and need to be able to correct bad data.
 *
 * Used by the PUT handlers under /api/{offers,invoices,proformas,deals}/[id].
 *
 * FIX-P1-LOGIC Fix 1.
 *
 * Tier 2 fix (H-2): the function now supports an overload that accepts a
 * caller-supplied `allowedTransitions` map for entity types not covered by
 * the hard-coded VALID_TRANSITIONS table (e.g. logistics_request). When
 * the 4th argument is supplied, the function returns `string | null`
 * (the error message, or null when valid) so callers can write
 * `const err = validateStatusTransition(...); if (err) return 409;`.
 */

export type DocType = "offer" | "invoice" | "proforma" | "deal" | "kyc";

const VALID_TRANSITIONS: Record<DocType, Record<string, string[]>> = {
  offer: {
    draft: ["sent", "cancelled", "viewed"],
    sent: ["accepted", "rejected", "expired", "draft", "viewed", "cancelled", "countered"],
    viewed: ["accepted", "rejected", "expired", "cancelled", "sent", "countered"],
    // FIX-MARKET-UI / FIX 3 — portal clients can counter from "countered"
    // again, or accept/reject the latest counter. The "countered" state
    // is not final — it just signals an open negotiation in progress.
    countered: ["accepted", "rejected", "expired", "cancelled", "sent", "countered"],
    accepted: ["cancelled"],
    rejected: [],
    expired: [],
    cancelled: [],
  },
  invoice: {
    draft: ["sent", "cancelled", "viewed"],
    sent: ["paid", "partial", "overdue", "cancelled", "viewed"],
    viewed: ["paid", "partial", "overdue", "cancelled", "sent"],
    partial: ["paid", "cancelled"],
    paid: [],
    overdue: ["paid", "partial", "cancelled"],
    cancelled: [],
  },
  proforma: {
    draft: ["sent", "cancelled", "viewed", "rejected"],
    // AUDIT2-LOGIC-UX H1 — add "rejected" to the allowed transitions from
    // "sent" + "viewed" so a portal client's "Reject" decision (POST
    // /api/portal/proformas/[id]/respond with decision="reject") is a
    // valid state transition. Previously the route set the status to
    // "expired" instead, conflating an active rejection with a timeout.
    sent: ["accepted", "expired", "cancelled", "viewed", "rejected"],
    viewed: ["accepted", "expired", "cancelled", "sent", "rejected"],
    accepted: ["paid", "cancelled"],
    paid: [],
    expired: [],
    rejected: [],
    cancelled: [],
  },
  deal: {
    lead: ["qualified", "cancelled"],
    qualified: ["proposal", "negotiation", "cancelled"],
    proposal: ["negotiation", "won", "lost"],
    negotiation: ["won", "lost"],
    won: [],
    lost: [],
    cancelled: [],
  },
  // ADMIN-H11 — KYC submissions state machine. Without this, an admin
  // could push a submission directly from `rejected` → `approved`
  // (skipping the mandatory resubmit + re-review cycle), or move an
  // `approved` record back to `draft` (silent reversal of a positive
  // compliance decision). The matrix mirrors the lifecycle the KYC
  // UI documents: a partner submits → ops reviews → ops approves or
  // rejects. A rejected partner must resubmit (which moves them back
  // through `submitted` for a fresh review). `approved` is a final
  // state — re-opening requires either a brand new submission (the
  // partner re-files) or a super-admin override.
  kyc: {
    submitted: ["under_review", "draft"],
    under_review: ["submitted", "approved", "rejected", "resubmit", "draft"],
    approved: [],
    rejected: ["resubmit"],
    resubmit: ["submitted", "draft"],
    draft: ["submitted"],
  },
};

export interface StatusTransitionResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate that transitioning `docType` from `currentStatus` to `newStatus`
 * is allowed by the state machine.
 *
 * Notes:
 * - A no-op transition (same status) is always valid.
 * - An unknown `currentStatus` has no allowed transitions → blocked.
 *
 * Overload A (built-in state machine): pass a known `DocType`.
 *   Returns `{ valid, error? }`.
 *
 * Overload B (custom transitions — H-2): pass any string label plus an
 *   `allowedTransitions` map. Returns the error string (or `null` when
 *   valid) so callers can `if (err) return 409;`.
 */
export function validateStatusTransition(
  docType: DocType,
  currentStatus: string,
  newStatus: string,
): StatusTransitionResult;
export function validateStatusTransition(
  docType: string,
  currentStatus: string,
  newStatus: string,
  allowedTransitions: Record<string, string[]>,
): string | null;
export function validateStatusTransition(
  docType: DocType | string,
  currentStatus: string,
  newStatus: string,
  allowedTransitions?: Record<string, string[]>,
): StatusTransitionResult | string | null {
  if (currentStatus === newStatus) {
    return allowedTransitions ? null : { valid: true };
  }
  const allowed: string[] = allowedTransitions
    ? (allowedTransitions[currentStatus] ?? [])
    : (VALID_TRANSITIONS[docType as DocType]?.[currentStatus] ?? []);
  if (!Array.isArray(allowed) || !allowed.includes(newStatus)) {
    const err = `Cannot change ${docType} status from "${currentStatus}" to "${newStatus}". Allowed transitions: ${(Array.isArray(allowed) ? allowed : []).join(", ") || "none"}.`;
    return allowedTransitions ? err : { valid: false, error: err };
  }
  return allowedTransitions ? null : { valid: true };
}
