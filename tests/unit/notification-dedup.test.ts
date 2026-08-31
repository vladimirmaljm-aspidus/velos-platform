import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Store } from "@/lib/data/store";
import type { Notification, NotificationType } from "@/lib/supabase/types";

// 11-A-v2 / 8c-10: pure-logic tests for `notify()`'s dedup branch.
// The dedup logic was added by Task 10-A-v2 to `src/lib/notif/helper.ts`:
// when a caller supplies BOTH a `dedupKey` AND a `partnerId`, the helper
// consults the store's `findRecentNotification()` probe BEFORE the insert;
// if a recent match exists within `dedupWindowMs` (default 5 min), the
// insert is skipped entirely (best-effort — lookup failures fall through
// to the original insert path so notifications are never silently
// dropped on a degraded store).
//
// Mocking strategy: `vi.hoisted` declares the mock fns so they're
// available inside the `vi.mock` factory (which is hoisted to the top
// of the file by vitest's transformer). The factory replaces
// `@/lib/data/store`'s `getStore` with a fn that returns a mock Store
// whose `findRecentNotification` and `createNotification` are the
// controllable mock fns. (Pattern mirrors `tests/unit/webhook-delivery.test.ts`.)

const { mockFindRecent, mockCreate } = vi.hoisted(() => ({
  mockFindRecent: vi.fn(),
  mockCreate: vi.fn(),
}));

vi.mock("@/lib/data/store", () => ({
  getStore: vi.fn(async () => ({
    findRecentNotification: mockFindRecent,
    createNotification: mockCreate,
  }) as unknown as Store),
}));

import { notify } from "@/lib/notif/helper";

// Common test fixture — a notification row that the mock findRecent
// returns when the test wants to simulate "a recent match was found".
const RECENT_MATCH: Notification = {
  id: "notif-old-1",
  tenant_id: "tenant-A",
  user_id: null,
  partner_id: "partner-B",
  type: "marketplace_message_received" as NotificationType,
  title: "New marketplace message",
  message: "You have a new message.",
  entity_type: "marketplace_negotiation",
  entity_id: "neg-1",
  read: false,
  read_at: null,
  action_url: "/portal/marketplace/negotiations/neg-1",
  action_label: "Open room",
  created_at: new Date(Date.now() - 60_000).toISOString(), // 1 min ago — inside the 5-min window
};

describe("notify — dedup logic (8c-10)", () => {
  beforeEach(() => {
    mockFindRecent.mockReset();
    mockCreate.mockReset();
    // By default, the createNotification mock returns a fully-formed
    // notification row (so the helper's `await` resolves cleanly).
    mockCreate.mockResolvedValue({
      ...RECENT_MATCH,
      id: "notif-new",
      created_at: new Date().toISOString(),
    });
  });

  // ── 1. Same dedupKey twice → second call no-ops ─────────────────────
  it("skips the insert on the second call with the same dedupKey (within the dedup window)", async () => {
    // First call: no recent match → falls through to createNotification.
    mockFindRecent.mockResolvedValueOnce(null);
    // Second call: recent match found → dedup skips the insert.
    mockFindRecent.mockResolvedValueOnce(RECENT_MATCH);

    const opts = {
      tenantId: "tenant-A",
      partnerId: "partner-B",
      type: "marketplace_message_received" as NotificationType,
      title: "New marketplace message",
      message: "You have a new message.",
      entityType: "marketplace_negotiation",
      entityId: "neg-1",
      dedupKey: "marketplace_negotiation:neg-1:message",
      dedupWindowMs: 5 * 60 * 1000,
    };

    await notify(opts);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockFindRecent).toHaveBeenCalledTimes(1);

    await notify(opts);
    // The findRecent probe was consulted a second time and returned a
    // match — the insert was skipped.
    expect(mockFindRecent).toHaveBeenCalledTimes(2);
    // createNotification was NOT called the second time.
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  // ── 2. Same dedupKey 5 min apart → both insert ──────────────────────
  it("inserts both calls when they fall outside the dedup window (5 min apart)", async () => {
    // Both calls: findRecentNotification returns null (no recent match
    // — the first because nothing exists yet, the second because the
    // first call's notification is now 5 min old and outside the
    // window — the store impl filters by created_at >= now - windowMs).
    mockFindRecent.mockResolvedValue(null);

    const opts = {
      tenantId: "tenant-A",
      partnerId: "partner-B",
      type: "marketplace_message_received" as NotificationType,
      title: "New marketplace message",
      message: "You have a new message.",
      entityType: "marketplace_negotiation",
      entityId: "neg-1",
      dedupKey: "marketplace_negotiation:neg-1:message",
      dedupWindowMs: 5 * 60 * 1000,
    };

    await notify(opts);
    await notify(opts);
    // Both calls consulted the dedup probe; both fell through to the
    // insert path because no recent match existed.
    expect(mockFindRecent).toHaveBeenCalledTimes(2);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  // ── 3. Different dedupKeys → both insert ────────────────────────────
  it("inserts both calls when the dedupKeys differ (scoped by entityId)", async () => {
    // Different dedupKeys in the route handler manifest as different
    // entityId values passed to notify() — the dedup probe is scoped
    // by (partner, type, entityType, entityId), so two parallel
    // negotiations on the same post don't collapse into each other.
    // The mock returns null for both probes (no recent match for
    // either distinct entityId).
    mockFindRecent.mockResolvedValue(null);

    await notify({
      tenantId: "tenant-A",
      partnerId: "partner-B",
      type: "marketplace_message_received" as NotificationType,
      title: "New marketplace message",
      message: "msg in negotiation 1",
      entityType: "marketplace_negotiation",
      entityId: "neg-1", // ← dedupKey scoped to neg-1
      dedupKey: "marketplace_negotiation:neg-1:message",
      dedupWindowMs: 5 * 60 * 1000,
    });
    await notify({
      tenantId: "tenant-A",
      partnerId: "partner-B",
      type: "marketplace_message_received" as NotificationType,
      title: "New marketplace message",
      message: "msg in negotiation 2",
      entityType: "marketplace_negotiation",
      entityId: "neg-2", // ← dedupKey scoped to neg-2 (different)
      dedupKey: "marketplace_negotiation:neg-2:message",
      dedupWindowMs: 5 * 60 * 1000,
    });

    expect(mockFindRecent).toHaveBeenCalledTimes(2);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  // ── 4. No dedupKey → both insert (back-compat) ──────────────────────
  it("inserts both calls when no dedupKey is supplied (back-compat path)", async () => {
    // When dedupKey is absent, the dedup branch is skipped entirely —
    // the helper never calls findRecentNotification. Both calls go
    // straight to createNotification. This preserves back-compat for
    // every existing caller that doesn't yet pass a dedupKey.
    await notify({
      tenantId: "tenant-A",
      partnerId: "partner-B",
      type: "kyc_submitted" as NotificationType,
      title: "KYC Submission Received",
      message: "Acme Corp submitted KYC for review.",
      entityType: "kyc_submission",
      entityId: "sub-1",
      // ← no dedupKey
    });
    await notify({
      tenantId: "tenant-A",
      partnerId: "partner-B",
      type: "kyc_submitted" as NotificationType,
      title: "KYC Submission Received",
      message: "Globex submitted KYC for review.",
      entityType: "kyc_submission",
      entityId: "sub-2",
      // ← no dedupKey
    });

    // findRecentNotification was NEVER called (no dedupKey → no probe).
    expect(mockFindRecent).not.toHaveBeenCalled();
    // Both notifications were inserted.
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  // ── 5. Broadcast (partnerId === null) → bypasses dedup ─────────────
  it("bypasses dedup for broadcast notifications (partnerId === null)", async () => {
    // Broadcast notifications go to all tenant admins — they may need
    // every instance even when the caller supplies a dedupKey, so the
    // helper skips the dedup probe entirely. (Bonus regression guard
    // for the `dedupKey && opts.partnerId` short-circuit in source.)
    await notify({
      tenantId: "tenant-A",
      partnerId: null, // ← broadcast
      type: "signup_request_received" as NotificationType,
      title: "New signup request",
      message: "A new tenant requested signup.",
      entityType: "signup_request",
      entityId: "sr-1",
      dedupKey: "signup:sr-1", // ← supplied but ignored for broadcasts
      dedupWindowMs: 5 * 60 * 1000,
    });
    await notify({
      tenantId: "tenant-A",
      partnerId: null,
      type: "signup_request_received" as NotificationType,
      title: "New signup request",
      message: "Another tenant requested signup.",
      entityType: "signup_request",
      entityId: "sr-2",
      dedupKey: "signup:sr-2",
      dedupWindowMs: 5 * 60 * 1000,
    });

    // findRecentNotification was NEVER called (broadcast bypass).
    expect(mockFindRecent).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  // ── 6. Degraded store → lookup failure falls through to insert ─────
  it("falls through to insert when the dedup probe throws (degraded store)", async () => {
    // Best-effort contract: a lookup failure must NOT silently swallow
    // the notification. The helper catches the throw and falls through
    // to the original insert path. (Bonus regression guard for the
    // `try { ... } catch (dedupErr) { ... }` block in source.)
    mockFindRecent.mockRejectedValueOnce(new Error("connection refused"));

    await notify({
      tenantId: "tenant-A",
      partnerId: "partner-B",
      type: "marketplace_message_received" as NotificationType,
      title: "New marketplace message",
      message: "msg",
      entityType: "marketplace_negotiation",
      entityId: "neg-1",
      dedupKey: "marketplace_negotiation:neg-1:message",
      dedupWindowMs: 5 * 60 * 1000,
    });

    // The probe threw; the helper caught it and fell through to insert.
    expect(mockFindRecent).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
