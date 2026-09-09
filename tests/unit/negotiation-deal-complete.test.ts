import { describe, it, expect } from "vitest";
import {
  getNegotiationStatus,
  getTimeRemaining,
  getExpiryTimestamp,
  NEGOTIATION_EXPIRY_MS,
} from "@/lib/marketplace/negotiation-status";

// ── 102 (workflow-audit) — the deal-completion lifecycle flip ──────────────
//
// GAP 5 fix: when the second accept lands, the messages route now flips
// the negotiation row's DB status to "accepted" (previously it only set
// contact_revealed and left status="active" forever). These tests pin
// the display helper's contract for both the DB-status path (now real)
// and the contact_revealed fallback (legacy rows created before the fix
// — they carry contact_revealed=true with status still "active").
describe("getNegotiationStatus — deal completion (102 GAP 5)", () => {
  it("maps DB status=accepted to the accepted display status", () => {
    expect(getNegotiationStatus({ status: "accepted" })).toBe("accepted");
  });

  it("maps legacy contact_revealed=true (status still active) to accepted", () => {
    // Rows completed BEFORE the 102 fix never got the status flip — the
    // contact_revealed fallback keeps them classified correctly.
    expect(
      getNegotiationStatus({ status: "active", contact_revealed: true }),
    ).toBe("accepted");
  });

  it("an active negotiation with a recent message stays active", () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    expect(
      getNegotiationStatus({ status: "active", contact_revealed: false, last_message_at: recent }),
    ).toBe("active");
  });

  it("stops the 48h clock once accepted (never reports an accepted deal as expired)", () => {
    // 72h-old last message — past the 48h window — but the deal is done.
    const stale = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    expect(
      getNegotiationStatus({ status: "accepted", contact_revealed: true, last_message_at: stale }),
    ).toBe("accepted");
    expect(getTimeRemaining({ status: "accepted", last_message_at: stale })).toBe("—");
    expect(getExpiryTimestamp({ status: "accepted", last_message_at: stale })).toBeNull();
  });

  it("expires an active negotiation after 48h of silence", () => {
    const stale = new Date(Date.now() - (NEGOTIATION_EXPIRY_MS + 1_000)).toISOString();
    expect(
      getNegotiationStatus({ status: "active", last_message_at: stale }),
    ).toBe("expired");
  });
});
