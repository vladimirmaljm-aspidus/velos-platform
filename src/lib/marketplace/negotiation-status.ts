// Marketplace negotiation status helpers — Phase 2.
//
// The marketplace_negotiations table has a `status` column that stores
// the coarse-grained lifecycle (active / accepted / rejected / expired /
// cancelled), but the negotiation room UI needs a richer view that
// combines that with the 48-hour auto-expiry rule (a negotiation goes
// stale if no messages are exchanged for 48h after the last message) and
// the "awaiting response" sub-state (when the last message was an offer
// or counter_offer the OTHER party hasn't responded to yet).
//
// The two helpers in this file are pure functions — they take a
// negotiation row (or any partial shape containing the relevant fields)
// and return a UI-friendly status string + a humanised time-remaining
// string. They never touch the database, so they can be called from API
// routes, React components, and unit tests alike.
//
// Auto-expiry rule:
//   • The clock starts when the negotiation is created.
//   • Every message the two parties exchange resets the clock (the
//     store bumps `last_message_at` on every insert).
//   • 48 hours after the last reset (or 48h after creation if no
//     messages were ever sent) the negotiation is considered EXPIRED.
//   • Once both parties have accepted (contact_revealed = true) the
//     clock stops — an accepted deal never expires.
//   • A negotiation whose status column is already 'accepted' / /
//     'rejected' / 'expired' / 'cancelled' is reported as-is — the
//     helper does not override an explicit lifecycle state.

import type { MarketplaceNegotiation } from "@/lib/supabase/marketplace-types";

/**
 * Coarse-grained status used by the negotiation list's filter tabs and
 * the room's banner. Returned by `getNegotiationStatus`.
 *
 *   • active    — open negotiation, awaiting no specific action
 *   • awaiting  — open, but the last message was an offer/counter the
 *                 other party hasn't responded to (UI shows "Your turn"
 *                 / "Awaiting response")
 *   • accepted  — both parties have accepted; contact info revealed
 *   • rejected  — either party rejected
 *   • expired   — 48h passed without a message, OR status='expired'
 */
export type NegotiationDisplayStatus =
  | "active"
  | "awaiting"
  | "accepted"
  | "rejected"
  | "expired";

/** 48 hours in milliseconds — the auto-expiry window. */
export const NEGOTIATION_EXPIRY_MS = 48 * 60 * 60 * 1000;

/**
 * Resolve the UI display status for a negotiation row.
 *
 * The function is total — it accepts `null`/`undefined` and any partial
 * shape containing the relevant fields; missing fields fall back to
 * sensible defaults (e.g. an undefined `last_message_at` is treated as
 * the negotiation's `created_at` so the clock still runs).
 *
 * Decision tree (first match wins):
 *   1. status === "accepted"            → "accepted"
 *   2. status === "rejected"            → "rejected"
 *   3. status === "cancelled"           → "rejected" (UI collapses the two)
 *   4. status === "expired"             → "expired"
 *   5. contact_revealed === true        → "accepted"
 *      (the DB may not have flipped `status` yet — Phase 2's accept
 *      handshake is in the messages table; `contact_revealed` is the
 *      authoritative signal)
 *   6. 48h since last_message_at        → "expired"
 *      (created_at used as the fallback anchor when no message has been
 *      sent — covers the "negotiation opened but nobody typed" case)
 *   7. awaiting_party === "A" | "B"     → "awaiting"
 *      (the optional Phase 2 column; set by the store when an offer /
 *      counter_offer message is inserted)
 *   8. last_message_type ∈ {offer,
 *      counter_offer}                    → "awaiting"
 *      (best-effort denormalised signal; falls through to "active"
 *      when neither Phase 2 column has been populated yet — the helper
 *      is correct in both cases)
 *   9. otherwise                        → "active"
 */
export function getNegotiationStatus(
  neg: MarketplaceNegotiation | Record<string, unknown> | null | undefined,
): NegotiationDisplayStatus {
  if (!neg) return "expired";

  const status = (neg as { status?: string }).status ?? "active";
  const contactRevealed = Boolean(
    (neg as { contact_revealed?: boolean }).contact_revealed,
  );

  // 1–4: respect the DB's explicit lifecycle state.
  if (status === "accepted") return "accepted";
  if (status === "rejected" || status === "cancelled") return "rejected";
  if (status === "expired") return "expired";

  // 5: contact_revealed is the authoritative "both sides accepted" flag —
  // it is flipped by the API route when the second accept message lands.
  // The DB may still have status='active' at this point because the
  // Phase 1 schema doesn't yet auto-flip status on contact reveal.
  if (contactRevealed) return "accepted";

  // 6: 48h auto-expiry. Anchor on last_message_at when present (the
  // normal case — both parties have been talking); fall back to
  // created_at when no message has been sent yet so a freshly-opened
  // negotiation still has a 48h window.
  const anchorIso =
    (neg as { last_message_at?: string | null }).last_message_at ??
    (neg as { created_at?: string }).created_at ??
    null;
  if (anchorIso) {
    const anchorMs = new Date(anchorIso).getTime();
    if (Number.isFinite(anchorMs)) {
      const elapsed = Date.now() - anchorMs;
      if (elapsed >= NEGOTIATION_EXPIRY_MS) return "expired";
    }
  }

  // 7: awaiting_party column (Phase 2 — populated by the store on offer
  // / counter_offer inserts). When set, the UI shows "Your turn" or
  // "Awaiting response" depending on which side the caller is on.
  const awaitingParty = (neg as {
    awaiting_party?: "A" | "B" | null;
  }).awaiting_party;
  if (awaitingParty === "A" || awaitingParty === "B") return "awaiting";

  // 8: best-effort denormalised last_message_type. The Phase 2 column
  // is optional in the TypeScript interface (the migration doesn't add
  // it yet) so this falls through to "active" when the column is absent.
  const lastMessageType = (neg as {
    last_message_type?: string | null;
  }).last_message_type;
  if (lastMessageType === "offer" || lastMessageType === "counter_offer") {
    return "awaiting";
  }

  // 9: default — the negotiation is open and the ball is in nobody's
  // specific court (e.g. the last message was plain text, or there are
  // no messages yet and the clock hasn't expired).
  return "active";
}

/**
 * Human-readable time-remaining string for the 48h auto-expiry window.
 *
 * Examples:
 *   • "23h remaining"   — negotiation will expire in 23 hours
 *   • "45m remaining"    — under an hour left
 *   • "expired"          — past the 48h window, or status=expired
 *   • "—"                — no anchor available (shouldn't happen, but
 *                          kept as a defensive default)
 *
 * The string is intentionally locale-neutral ("23h" / "45m" / "expired")
 * — the caller may translate "expired" via the i18n store if it wants
 * a localised version. We keep the helper pure so it can be tested
 * without spinning up the i18n store.
 *
 * When the negotiation is already accepted / rejected (i.e. the clock
 * has stopped), returns "—" so the UI can render a non-alarming placeholder
 * instead of a stale countdown.
 */
export function getTimeRemaining(
  neg: MarketplaceNegotiation | Record<string, unknown> | null | undefined,
): string {
  if (!neg) return "expired";

  // Accepted / rejected / cancelled negotiations don't tick down.
  const status = getNegotiationStatus(neg);
  if (status === "accepted" || status === "rejected") return "—";
  if (status === "expired") return "expired";

  // Active or awaiting — compute the remaining window.
  const anchorIso =
    (neg as { last_message_at?: string | null }).last_message_at ??
    (neg as { created_at?: string }).created_at ??
    null;
  if (!anchorIso) return "—";

  const anchorMs = new Date(anchorIso).getTime();
  if (!Number.isFinite(anchorMs)) return "—";

  const remainingMs = NEGOTIATION_EXPIRY_MS - (Date.now() - anchorMs);
  if (remainingMs <= 0) return "expired";

  const remainingMins = Math.floor(remainingMs / 60000);
  if (remainingMins < 60) return `${remainingMins}m remaining`;
  const remainingHours = Math.floor(remainingMins / 60);
  if (remainingHours < 48) return `${remainingHours}h remaining`;
  // Defensive — should never exceed 48h since the helper short-circuits
  // when status is accepted/rejected/expired, but we keep the branch so
  // the function never returns undefined.
  return "48h remaining";
}

/**
 * Absolute expiry timestamp (ms since epoch) for the 48h window. Used
 * by the room's auto-expire banner to render a precise countdown timer
 * (`<time>` element with `dateTime`) instead of the rounded string from
 * `getTimeRemaining`. Returns `null` when the negotiation has no
 * anchor (no `last_message_at` and no `created_at`) or when the
 * negotiation has already reached a terminal state (accepted / rejected
 * / expired) — in those cases there is no future expiry to count down
 * to.
 */
export function getExpiryTimestamp(
  neg: MarketplaceNegotiation | Record<string, unknown> | null | undefined,
): number | null {
  if (!neg) return null;

  const status = getNegotiationStatus(neg);
  if (status === "accepted" || status === "rejected" || status === "expired") {
    return null;
  }

  const anchorIso =
    (neg as { last_message_at?: string | null }).last_message_at ??
    (neg as { created_at?: string }).created_at ??
    null;
  if (!anchorIso) return null;

  const anchorMs = new Date(anchorIso).getTime();
  if (!Number.isFinite(anchorMs)) return null;

  return anchorMs + NEGOTIATION_EXPIRY_MS;
}
