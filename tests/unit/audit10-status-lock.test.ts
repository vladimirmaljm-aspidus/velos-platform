import { describe, it, expect } from "vitest";
// 11-A-v2 / 8c-11: pure-logic tests for the marketplace negotiation
// status-lock check (Task 10-A-v2). The check lives in
// `src/app/api/marketplace/negotiations/[id]/messages/route.ts` inside
// the POST handler — it fetches the negotiation row's `status` column
// and 409s when the status is in `TERMINAL_STATUSES` BEFORE any side
// effect fires (rate-limit budget burned, notification queued, audit
// row written).
//
// The route file does NOT export `TERMINAL_STATUSES` (it's a local
// `const` inside the POST handler closure), and the prompt says I must
// NOT touch route files to add an export. The prompt's suggested
// fallback is to inline the array as a pure-logic constant and add a
// comment noting the source-file location — that's what this test does.
//
// DRIFT-MONITOR: if the source route file's `TERMINAL_STATUSES` set is
// edited (a new terminal status added, or an existing one renamed),
// this test file MUST be re-synced. The simplest way is to grep for
// `TERMINAL_STATUSES = new Set([` in
// `src/app/api/marketplace/negotiations/[id]/messages/route.ts` and
// re-paste the array below.

// Verbatim copy of the terminal-status set from
// src/app/api/marketplace/negotiations/[id]/messages/route.ts (Task 10-A-v2 / 8c-11).
// The source uses a `new Set([...])` for O(1) membership tests; the
// test below uses an Array for parity with the prompt's example, and
// converts to a Set inline for the membership assertions.
const TERMINAL_STATUSES: string[] = [
  "accepted",
  "rejected",
  "expired",
  "cancelled",
  "signed",
  "closed",
];

// Active / non-terminal statuses that should ALLOW a message to be sent.
// These are NOT in `TERMINAL_STATUSES` — sending a message should be
// permitted (the route's pre-check falls through to the body-parse +
// insert path).
const ACTIVE_STATUSES: string[] = [
  "pending",
  "negotiating",
  "open",
  "active",
  "draft",
];

describe("marketplace negotiation status lock (8c-11)", () => {
  // Sanity: the array we copied is non-empty and has exactly the
  // 6 terminal statuses the source route file enumerates. (If a future
  // agent adds a new terminal status to the source without re-syncing
  // this file, this assertion still passes — the test below would not
  // surface the drift. The grep-callout in the header comment is the
  // human-driven drift-monitor.)
  it("TERMINAL_STATUSES contains the 6 statuses the source route enumerates", () => {
    expect(TERMINAL_STATUSES).toHaveLength(6);
    expect(TERMINAL_STATUSES).toEqual(
      expect.arrayContaining([
        "accepted",
        "rejected",
        "expired",
        "cancelled",
        "signed",
        "closed",
      ]),
    );
  });

  // For each terminal status: assert it's a member of the set (the
  // route's `TERMINAL_STATUSES.has(n.status)` check would 409 on it).
  TERMINAL_STATUSES.forEach((status) => {
    it(`blocks messages on a "${status}" negotiation (409 pre-check)`, () => {
      // The pure-logic check we're verifying: the status string is a
      // member of the TERMINAL_STATUSES set. In the source route, this
      // membership check decides whether to return 409 (blocked) or
      // fall through to the body-parse + insert path (allowed).
      const set = new Set(TERMINAL_STATUSES);
      expect(set.has(status)).toBe(true);
    });
  });

  // For each active status: assert it's NOT a member of the set (the
  // route's check would fall through to insert).
  ACTIVE_STATUSES.forEach((status) => {
    it(`allows messages on a "${status}" negotiation (not in TERMINAL_STATUSES)`, () => {
      const set = new Set(TERMINAL_STATUSES);
      expect(set.has(status)).toBe(false);
    });
  });

  // Edge case: a clearly-malformed / unknown status string must NOT
  // be in the set — the route should fall through to insert (or,
  // depending on downstream validation, return a 4xx for the unknown
  // status, but that's not the status-lock's job). The status-lock
  // only blocks the KNOWN terminal states; it doesn't whitelist.
  it("does not block messages on an unknown status (no whitelist, only blacklist)", () => {
    const set = new Set(TERMINAL_STATUSES);
    expect(set.has("nonexistent_status")).toBe(false);
    expect(set.has("ACCEPTED")).toBe(false); // case-sensitive — no upper-case match
    expect(set.has(" accepted")).toBe(false); // no whitespace-tolerant match
    expect(set.has("")).toBe(false);
  });

  // Edge case: empty / null / undefined status values are NOT in the
  // set (the route's `negRow` fetch would 404 on missing rows BEFORE
  // the status check fires, but the pure-logic check itself doesn't
  // treat these as terminal — they fall through).
  it("does not block messages when the status is null / undefined / empty", () => {
    const set = new Set(TERMINAL_STATUSES);
    expect(set.has(null as unknown as string)).toBe(false);
    expect(set.has(undefined as unknown as string)).toBe(false);
    expect(set.has("")).toBe(false);
  });
});
