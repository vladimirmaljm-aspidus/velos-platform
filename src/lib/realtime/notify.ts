/**
 * Real-time notification emitter
 * ----------------------------------------------------------------------------
 * Server-side helper used by Next.js API routes to push a live event to the
 * standalone Socket.IO gateway (`mini-services/notifications-service`).
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
 *   NOTIFICATIONS_SERVICE_URL — base URL of the mini-service.
 *     Defaults to `http://localhost:3001` (dev). In production it points at
 *     the internal service URL (e.g. `http://notifications:3001` in Docker
 *     compose, or `https://aspidus.onrender.com/ws` behind Caddy — the
 *     Caddyfile maps `/ws/*` to the service's port 3001).
 */

const NOTIFICATIONS_SERVICE_URL =
  process.env.NOTIFICATIONS_SERVICE_URL || "http://localhost:3001";

// Single fetch with a hard 2s timeout — if the gateway is slow/down we
// don't want to hold the API request open. The notification is already
// persisted in the DB; the live push is best-effort.
const EMIT_TIMEOUT_MS = 2_000;

export async function emitNotification(params: {
  tenantId?: string;
  userId?: string;
  event: string;
  data: Record<string, unknown>;
}): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMIT_TIMEOUT_MS);
    const res = await fetch(`${NOTIFICATIONS_SERVICE_URL}/emit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    // the live push. Log prominently (rather than silently swallowing) so
    // ops can tell a deployed-but-broken service from a not-deployed
    // service. The latter is the current state — the mini-service exists
    // in `mini-services/notifications-service/` but is NOT deployed to
    // Render, so every emit hits ECONNREFUSED / 502. The frontend falls
    // back to 30s polling (see `src/hooks/use-realtime.ts`'s
    // `pollingActive` flag), so the user still sees the notification, just
    // with up to 30s latency instead of <1s.
    //
    // Logged at `debug` (not `warn`) because the polling fallback makes
    // this an expected, non-actionable state in the current deployment —
    // but the message text is distinctive enough that grepping prod logs
    // for "service may not be deployed" surfaces the gap immediately when
    // someone asks "why aren't notifications instant?".
    console.debug(
      "[realtime] emit failed (service may not be deployed — frontend is polling as fallback):",
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
