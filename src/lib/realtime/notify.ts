/**
 * Real-time notification emitter
 * ----------------------------------------------------------------------------
 * Server-side helper used by Next.js API routes to push a live event to the
 * standalone Socket.IO gateway (`mini-services/realtime`).
 *
 * Why a separate service instead of a Next.js WebSocket route?
 *   • Next.js App-Router route handlers don't natively host WebSocket
 *     upgrades — they're HTTP-only. A standalone Node/Bun process can hold
 *     thousands of idle WS connections cheaply and survives Next.js hot
 *     reloads during dev.
 *   • Decoupling the push channel from the request/response cycle means an
 *     emit failure can NEVER fail the originating API call. The notification
 *     row has already been persisted in the DB by the time this is called
 *     (see `src/lib/notif/helper.ts`); this is just the "ping the browser"
 *     side of the write.
 *
 * Contract:
 *   • Fire-and-forget — callers should NOT await this from a hot path. The
 *     convenience wrappers below are async only so they can `await fetch`,
 *     but every call site uses `void notifyX(...)` or `.catch(() => {})`.
 *   • Non-critical — any error (network, 5xx, JSON parse) is swallowed and
 *     logged at `debug` level. The persisted notification is still there.
 *   • `userId` wins over `tenantId` when both are present (narrower audience).
 *
 * Env:
 *   REALTIME_WS_URL — public base URL of the realtime mini-service.
 *     • When set (production), emits go to `${REALTIME_WS_URL}/emit`.
 *     • When unset (local dev, or the service is not yet deployed), emit
 *       is a no-op — the useRealtime hook on the client falls back to its
 *       30-second polling and surfaces the same notification from the DB.
 *       This is intentional: a half-configured service URL would produce
 *       connection errors on every emit; a missing var produces silence,
 *       which is the correct state for "not deployed yet".
 *
 *   CRON_TOKEN — shared secret between this Next.js app and the realtime
 *     service's /emit endpoint. Same value as `src/lib/api/cron-auth.ts`
 *     uses for /api/cron/* — there is exactly one shared-secret per
 *     deployment, so reusing it keeps the surface area tight.
 */

const REALTIME_WS_URL = process.env.REALTIME_WS_URL || "";
const CRON_TOKEN = process.env.CRON_TOKEN || "";

// Single fetch with a hard 2s timeout — if the gateway is slow/down we
// don't want to hold the API request open. The notification is already
// persisted in the DB; the live push is best-effort.
const EMIT_TIMEOUT_MS = 2_000;

export async function emitNotification(params: {
  tenantId?: string;
  userId?: string;
  event: string;
  data: Record<string, unknown>;
  /** Broadcast to the cross-tenant `super_admins` room as well
   * (used by signup:request etc.). Default false. */
  superAdmins?: boolean;
}): Promise<void> {
  // No-op when the realtime service is not configured — the useRealtime
  // client hook falls back to 30s polling and the persisted notification
  // is still surfaced (with up to 30s latency instead of <1s).
  if (!REALTIME_WS_URL) return;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMIT_TIMEOUT_MS);
    const res = await fetch(`${REALTIME_WS_URL}/emit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Shared secret with the realtime service. The service uses a
        // constant-time compare so a missing/wrong token is rejected
        // without leaking the correct value via timing.
        ...(CRON_TOKEN ? { Authorization: `Bearer ${CRON_TOKEN}` } : {}),
      },
      body: JSON.stringify(params),
      signal: controller.signal,
      // Internal service-to-service call — no cookies/credentials needed.
      credentials: "omit",
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.debug(
        `[realtime] emit returned ${res.status} for event=${params.event}`,
      );
    }
  } catch (e) {
    // Non-critical — the notification is already in the DB; this is just
    // the live push. Logged at `debug` (not `warn`) because the polling
    // fallback makes a transient emit failure non-actionable: the user
    // still sees the notification, just with up to 30s extra latency.
    console.debug(
      "[realtime] emit failed (client may be polling as fallback):",
      e instanceof Error ? e.message : String(e),
    );
  }
}

// ── Convenience wrappers ─────────────────────────────────────────────────────
// One helper per domain event so call sites read cleanly:
//   `void notifyNewMessage(tenantId, userId, { message });`
// All wrappers are async (return Promise<void>) so callers can `void` them
// or attach `.catch(() => {})` if they want to be explicit.

export const notifyNewMessage = (
  tenantId: string,
  userId: string,
  data: Record<string, unknown>,
) =>
  emitNotification({ tenantId, userId, event: "message:new", data });

export const notifyOfferUpdate = (
  tenantId: string,
  data: Record<string, unknown>,
) =>
  emitNotification({ tenantId, event: "offer:updated", data });

export const notifyInvoicePayment = (
  tenantId: string,
  data: Record<string, unknown>,
) =>
  emitNotification({ tenantId, event: "invoice:paid", data });

export const notifyPortalActivity = (
  tenantId: string,
  data: Record<string, unknown>,
) =>
  emitNotification({ tenantId, event: "portal:activity", data });

export const notifyNewNotification = (
  tenantId: string,
  data: Record<string, unknown>,
) =>
  emitNotification({ tenantId, event: "notification:new", data });

/**
 * Broadcast a signup request to every super_admin in real time. The
 * `superAdmins: true` flag tells the realtime service to also emit to
 * the cross-tenant `super_admins` room (not just a single tenant room).
 */
export const notifySignupRequest = (
  data: Record<string, unknown>,
) =>
  emitNotification({ event: "signup:request", data, superAdmins: true });
