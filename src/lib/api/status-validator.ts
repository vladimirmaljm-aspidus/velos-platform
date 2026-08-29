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

export type DocType =
  | "offer"
  | "invoice"
  | "proforma"
  | "deal"
  | "kyc"
  | "marketplace_post"
  | "marketplace_response"
  | "loi";

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
  // AUDIT4-PATHS / Fix 3 — marketplace posts state machine. The audit
  // found that POST /api/marketplace and PUT /api/marketplace/[id] only
  // validated the enum, never the transition. Without this guard a post
  // owner could revive an `expired` post (expired → active), re-open a
  // `closed` post, or un-flag a `flagged` post (flagged → active) without
  // admin review — defeating the moderation flag mechanism. The graph
  // mirrors the lifecycle the marketplace UI documents: a partner drafts
  // → activates → the cron expires / the owner closes / the admin flags.
  // `flagged → active` is the only re-activation path and is admin-only
  // (the route layer only allows portal clients, who are NEVER super-
  // admins, so the bypass documented in this file's header does not
  // apply here — but a future admin route may opt in). `closed`,
  // `expired`, `cancelled` are terminal: reviving them would silently
  // undo the cron / owner action that produced them.
  marketplace_post: {
    draft: ["active"],
    active: ["closed", "expired", "cancelled", "flagged"],
    closed: [],
    expired: [],
    flagged: ["active"],
    cancelled: [],
  },
  // AUDIT4-PATHS / Fix 4 — marketplace responses state machine. The
  // audit found that updateMarketplaceResponseStatus did a raw UPDATE
  // with no transition check, letting a post owner revert a "rejected"
  // response back to "sent", revive an "expired" response to
  // "accepted", or change their mind after accepting (accepted →
  // rejected). The downstream contract-creation flow assumes
  // status="accepted" is permanent — a reversion silently invalidates
  // any contract auto-generated from the acceptance. The graph:
  // sent → viewed/accepted/rejected/countered/expired (initial state
  // is `sent` when the responder creates the response; `viewed` is
  // set when the owner opens it; `countered` keeps the negotiation
  // open — the owner can counter again or accept/reject the latest
  // counter). accepted / rejected / expired are terminal.
  marketplace_response: {
    sent: ["viewed", "accepted", "rejected", "countered", "expired"],
    viewed: ["accepted", "rejected", "countered", "expired"],
    countered: ["accepted", "rejected", "countered", "expired"],
    accepted: [],
    rejected: [],
    expired: [],
  },
  // BUILD-LOI — Letters of Intent (LOI) state machine. Mirrors the lifecycle
  // the admin UI documents: a tenant admin drafts an LOI, emails it to the
  // seller partner (sent), the partner accepts or rejects (or it expires,
  // or the admin cancels). "draft" is the only editable state; "sent" can
  // be re-sent but the underlying data is locked once sent (the PUT route
  // enforces the field whitelist). accepted/rejected/expired/cancelled are
  // terminal — reviving would silently undo the partner's decision or the
  // admin's cancellation. Super-admin bypasses (general policy in this
  // module's header).
  loi: {
    draft: ["sent", "cancelled"],
    sent: ["accepted", "rejected", "expired", "cancelled", "draft"],
    accepted: ["cancelled"],
    rejected: [],
    expired: [],
    cancelled: [],
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
