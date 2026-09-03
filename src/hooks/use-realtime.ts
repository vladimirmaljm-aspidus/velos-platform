"use client";

/**
 * useRealtime — React hook for subscribing to the VELOS notifications gateway.
 * ----------------------------------------------------------------------------
 * Replaces the 30-second polling that previously lived in the Topbar with a
 * single long-lived Socket.IO connection per browser tab.
 *
 * Usage:
 *
 *   useRealtime(
 *     {
 *       "message:new":    (data) => addNotification(data),
 *       "offer:updated":  (data) => invalidateOffersQuery(),
 *       "invoice:paid":   (data) => toast.success("Invoice paid"),
 *       "portal:activity":(data) => addNotification(data),
 *     },
 *     // Optional polling fallback — called every 30s when the WebSocket
 *     // cannot connect (e.g. the notifications mini-service is not yet
 *     // deployed). Pass your existing "loadNotifications" / refresh
 *     // callback so the UI keeps updating even without the live push.
 *     loadNotifications,
 *   );
 *
 * Connection lifecycle:
 *   • One singleton socket per tab (module-level `socket` variable) so the
 *     hook can be mounted in multiple components without spawning multiple
 *     connections.
 *   • The socket is created lazily on first `useRealtime` call after we know
 *     who the user is (auth handshake). If `userId` is null (logged out),
 *     the hook is a no-op.
 *   • Handlers are stored in a ref so changing them doesn't trigger a
 *     resubscribe — only the SET of event names does. This avoids the
 *     "re-subscribe on every render" bug the naive implementation has.
 *
 * Polling fallback (P0 / task D-FIX):
 *   • When the standalone notifications mini-service is not deployed, every
 *     Socket.IO `connect` attempt fails with `connect_error` (ECONNREFUSED
 *     on localhost, 502/503 on the public URL). The previous hook version
 *     logged the error at `debug` and left the user without ANY notification
 *     updates after the initial mount-load — the bell would only update on a
 *     full page refresh.
 *   • We now track a module-level `pollingActive` flag, toggled ON by
 *     `connect_error` / `disconnect` and OFF by `connect`. When the flag is
 *     ON, a 30s interval (same cadence the old polling had) calls the
 *     optional `onPoll` callback so the consumer can re-fetch from
 *     `/api/notifications`. The notification row is always persisted by the
 *     backend (`src/lib/notif/helper.ts`) before the WS push is attempted,
 *     so polling surfaces the same data, just with up to 30s latency.
 *   • When the mini-service IS deployed (option A in the worklog), the
 *     socket connects, `pollingActive` clears, the interval becomes a
 *     no-op inner check, and the WS push path takes over. No code change
 *     needed at that point.
 *
 * Env:
 *   NEXT_PUBLIC_WS_URL — base URL of the WebSocket gateway.
 *     • Dev default: `http://localhost:3001` (the mini-service running locally).
 *     • Prod: the same-origin URL with `?XTransformPort=3001` so Caddy
 *       routes the upgrade to the service (see Caddyfile). Example:
 *       `https://aspidus.onrender.com/?XTransformPort=3001`.
 *
 * Auth (audit H3):
 *   Before connecting we POST /api/realtime/ticket (session-cookie
 *   authenticated) and append the returned HMAC-signed `ticket` query
 *   param to the WS URL — the gateway verifies it with the shared
 *   WS_TICKET_SECRET and no longer trusts the client-asserted userId for
 *   cross-origin sockets. When ticket minting is unavailable (501 —
 *   WS_TICKET_SECRET unset on the app side) we fall back to the legacy
 *   `auth.token` handshake (still accepted while the gateway's secret is
 *   unset too). Same-origin cookie auth is unaffected either way.
 */

import { useEffect, useRef } from "react";
import { io, type Socket } from "socket.io-client";
import { useAppStore } from "@/lib/store/app-store";

// Module-level singleton — one connection per browser tab regardless of how
// many components mount `useRealtime`.
let socket: Socket | null = null;
let connectedUserId: string | null = null;

// Guards async socket creation (ticket fetch → io()): every creation attempt
// bumps the sequence; an attempt whose socket resolves after a NEWER attempt
// started (user switch, logout, ticket re-mint) discards its socket.
let connectSeq = 0;

// Live event-wrapper registrations — one entry per mounted `useRealtime`
// effect. The ticket re-mint path below re-attaches ALL of them to the
// replacement socket (a bare module var would only remember the last
// hook's set and silently drop the other subscribers' events).
const activeSubscriptions = new Map<number, Record<string, EventHandler>>();

// Throttle for the ticket re-mint reconnect: at most one attempt per 30s so
// an unreachable/misconfigured gateway can't spin a fetch+connect loop.
let ticketRetryTimer: ReturnType<typeof setTimeout> | null = null;

// Sequence for per-effect subscription registration (see
// activeSubscriptions) — unique id per mounted hook effect.
let subscriptionSeq = 0;

// P0 / task D-FIX: polling-fallback state. Module-level so the WS event
// listeners (attached once per socket lifetime) can toggle it without going
// through React state (which would re-render + re-run the WS effect +
// recurse). The interval in the WS effect reads this flag on every tick.
let pollingActive = false;

function setPolling(active: boolean): void {
  if (active === pollingActive) return;
  pollingActive = active;
  if (active) {
    console.debug(
      "[realtime] WebSocket unavailable — falling back to 30s polling. " +
      "(If the notifications mini-service is deployed, the next successful " +
      "reconnect will switch back to live push.)",
    );
  } else {
    console.debug("[realtime] WebSocket reconnected — polling fallback cleared.");
  }
}

function getWsUrl(): string {
  if (process.env.NEXT_PUBLIC_WS_URL) return process.env.NEXT_PUBLIC_WS_URL;
  // Dev default: same-origin bypassed to the local mini-service. In prod
  // the env var is always set, so this branch only fires on a developer's
  // machine.
  if (typeof window !== "undefined" && window.location.hostname === "localhost") {
    return "http://localhost:3001";
  }
  // Same-origin with the Caddy XTransformPort query param so the upgrade
  // goes through the same TLS cert as the SPA. Caddyfile maps this to
  // the mini-service port 3001.
  return typeof window !== "undefined" ? `${window.location.origin}/?XTransformPort=3001` : "";
}

type EventHandler = (data: any) => void;
type EventMap = Record<string, EventHandler>;

// ── Audit H3 (4-b): HMAC-signed WS ticket plumbing ─────────────────────────

/**
 * Fetch a short-lived HMAC-signed ticket from the session-authenticated
 * mint route (POST /api/realtime/ticket). Returns null when minting is
 * unavailable (not configured / logged out / network error) — the caller
 * then falls back to the legacy `auth.token` handshake, which the gateway
 * still accepts while ITS WS_TICKET_SECRET is also unset.
 */
async function fetchRealtimeTicket(): Promise<string | null> {
  try {
    const res = await fetch("/api/realtime/ticket", { method: "POST" });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const ticket = (data as { ticket?: unknown } | null)?.ticket;
    return typeof ticket === "string" && ticket ? ticket : null;
  } catch {
    return null;
  }
}

/** Append the ticket as a query param (base64url + encodeURIComponent). */
function withTicketParam(url: string, ticket: string): string {
  // NEXT_PUBLIC_WS_URL may already carry a query (e.g. ?XTransformPort=3001).
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}ticket=${encodeURIComponent(ticket)}`;
}

/**
 * Create the singleton socket. Async because the ticket is fetched first
 * (same-origin POST, session cookie) — the ticket must be in the handshake
 * URL, and a socket's URL is fixed at creation.
 *
 * On a ticket-related connect_error (expired after a long-lived tab
 * re-handshakes, or the service just started enforcing tickets) we tear the
 * socket down and re-mint — throttled to one attempt per 30s. The polling
 * fallback covers the gap, so no events are lost.
 */
async function createRealtimeSocket(
  userId: string,
  tenantId: string | undefined,
): Promise<Socket> {
  const base = getWsUrl();
  const ticket = await fetchRealtimeTicket();
  const url = ticket ? withTicketParam(base, ticket) : base;
  const s = io(url, {
    transports: ["websocket"],
    // Legacy fallback handshake — ignored by the gateway whenever it
    // enforces tickets (WS_TICKET_SECRET set); still needed while both
    // sides run in the backward-compat (unset) mode.
    auth: {
      token: {
        userId,
        tenantId,
      },
    },
    // Auto-reconnect with exponential backoff. Socket.IO's defaults
    // are reasonable; we just cap the retry to avoid hammering the
    // gateway during an outage.
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 15_000,
  });

  s.on("connect", () => {
    console.debug("[realtime] connected");
    // P0 / task D-FIX: the WS gateway is reachable — clear the polling
    // fallback so subsequent interval ticks are no-ops and the live
    // push path takes over.
    setPolling(false);
  });
  s.on("disconnect", (reason) => {
    console.debug("[realtime] disconnected:", reason);
    // A short disconnect may be transient (Socket.IO will auto-retry)
    // but we flip polling on so the 30s interval covers the outage.
    // If the reconnect succeeds, `connect` fires and clears it.
    setPolling(true);
  });
  s.on("connect_error", (err) => {
    // Likely the gateway is down or not yet deployed (the current
    // state — the mini-service exists in source but is not on
    // Render). Logged at debug so prod doesn't get spammed during an
    // outage; the polling fallback keeps the UI updating.
    console.debug("[realtime] connect_error:", err.message);
    setPolling(true);
    // Audit H3: a rejected ticket (expiry is the recoverable case — the
    // tab outlived the 1h TTL and re-handshook) is fixed by re-minting.
    // Gateway-down errors don't match, so they keep the plain polling
    // fallback instead of churning fetch+connect cycles.
    if (/ticket|unauthenticated/i.test(err.message)) {
      scheduleTicketRemint(userId, tenantId);
    }
  });
  return s;
}

/**
 * Attach every live subscription to a socket. Only called on a FRESHLY
 * created socket (nobody could have attached during the async creation —
 * `socket` was null), so no double-registration risk.
 */
function attachAllSubscriptions(s: Socket): void {
  for (const wrappers of activeSubscriptions.values()) {
    for (const name of Object.keys(wrappers)) {
      s.on(name, wrappers[name]);
    }
  }
}

/**
 * Tear down the failing singleton and reconnect with a fresh ticket.
 * Throttled (one attempt / 30s) and a no-op when a newer user has since
 * connected. Re-attaches every live subscription to the replacement socket.
 */
function scheduleTicketRemint(userId: string, tenantId: string | undefined): void {
  if (ticketRetryTimer) return; // already scheduled
  ticketRetryTimer = setTimeout(() => {
    ticketRetryTimer = null;
    if (connectedUserId !== userId) return; // user changed / logged out
    console.debug("[realtime] re-minting WS ticket and reconnecting…");
    socket?.disconnect();
    socket = null;
    connectedUserId = null;
    const seq = ++connectSeq;
    void createRealtimeSocket(userId, tenantId).then((s) => {
      if (seq !== connectSeq) {
        s.disconnect();
        return;
      }
      socket = s;
      connectedUserId = userId;
      attachAllSubscriptions(s);
    });
  }, 30_000);
}

export function useRealtime(events: EventMap, onPoll?: () => void): void {
  const user = useAppStore((s) => s.user);
  // Latest handlers kept in a ref so we never need to resubscribe when a
  // caller passes a fresh object literal (which happens on every render).
  // Updated inside a passive effect (NOT in the render body) per the
  // react-hooks/refs rule — refs must not be mutated during render.
  const handlersRef = useRef<EventMap>(events);
  useEffect(() => {
    handlersRef.current = events;
  });

  // Polling callback is also kept in a ref — when the interval fires it
  // always calls the latest closure, without re-running the WS effect.
  const pollRef = useRef<(() => void) | undefined>(onPoll);
  useEffect(() => {
    pollRef.current = onPoll;
  });

  // Stable event-name list — only when the SET of subscribed events changes
  // do we touch the socket's listener registry.
  const eventKey = Object.keys(events).sort().join("|");

  useEffect(() => {
    if (!user?.id) return; // logged out — nothing to subscribe to

    // Each event name maps to a stable wrapper that reads the latest handler
    // from the ref. This is what lets callers pass new handler closures on
    // every render without us churning the socket's listener registry.
    const names = eventKey ? eventKey.split("|") : [];
    const wrappers: Record<string, EventHandler> = {};
    for (const name of names) {
      const wrapper: EventHandler = (data) => handlersRef.current[name]?.(data);
      wrappers[name] = wrapper;
    }
    const attach = (s: Socket): void => {
      for (const name of names) s.on(name, wrappers[name]);
    };

    // Lazy-init the singleton socket the first time we have a user. If the
    // user CHANGES (super-admin impersonation, login-as, etc.) tear down
    // and reconnect so the rooms are correct. Async (audit H3): the signed
    // ticket is fetched before the socket is created so it rides the
    // handshake URL.
    if (!socket || connectedUserId !== user.id) {
      socket?.disconnect();
      socket = null;
      connectedUserId = null;
      const userId = user.id;
      const tenantId = user.tenant_id ?? undefined;
      const seq = ++connectSeq;
      void createRealtimeSocket(userId, tenantId).then((s) => {
        if (seq !== connectSeq) {
          // A newer attempt (user switch / logout / re-mint) superseded us —
          // discard this socket instead of leaking it.
          s.disconnect();
          return;
        }
        socket = s;
        connectedUserId = userId;
        // Attach ALL live subscriptions, not just this run's — an effect run
        // that re-ran during the async creation (eventKey change) saw
        // `socket == null` and could not attach its own wrappers.
        attachAllSubscriptions(s);
      });
    } else if (socket) {
      attach(socket);
    }

    // Track this effect's wrappers so the ticket re-mint path can re-attach
    // them to the replacement socket (see activeSubscriptions above).
    const subId = ++subscriptionSeq;
    activeSubscriptions.set(subId, wrappers);

    // ── P0 / task D-FIX: 30s polling fallback ───────────────────────────
    // The interval is always running while the hook is mounted; the inner
    // `pollingActive` check gates the actual fetch so we don't double-fetch
    // when the socket is healthy (the live WS handlers already cover the
    // refresh). When `onPoll` is not provided by the caller, the interval
    // is a no-op (the optional chaining handles it).
    const POLLING_INTERVAL_MS = 30_000;
    const interval = setInterval(() => {
      if (pollingActive) pollRef.current?.();
    }, POLLING_INTERVAL_MS);

    return () => {
      for (const name of Object.keys(wrappers)) {
        socket?.off(name, wrappers[name]);
      }
      activeSubscriptions.delete(subId);
      clearInterval(interval);
      // NOTE: we intentionally do NOT disconnect the socket here — the
      // singleton survives unmount so a re-mount (e.g. route change in the
      // SPA) doesn't pay the reconnect cost. The socket is torn down only
      // when the user changes (handled above) or the tab closes.
    };
    // `eventKey` is the only dep — when the SET of subscribed event names
    // changes we re-register. `user.id` is captured but the only user-driven
    // trigger for re-running is the lazy-init branch above (which compares
    // connectedUserId against user.id).
  }, [eventKey, user?.id]);
}

/**
 * Manually disconnect the realtime socket — useful for the logout flow so a
 * logged-out tab doesn't keep an open connection under a stale identity.
 * Called from the Topbar's logout handler.
 */
export function disconnectRealtime(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
    connectedUserId = null;
  }
  // Invalidate any in-flight creation so its socket is discarded instead
  // of re-assigning the singleton after logout (audit H3 plumbing). Runs
  // even when `socket` is null — a creation may still be in flight.
  connectSeq++;
  // Cancel a pending ticket re-mint — the login flow re-creates the socket
  // with a fresh ticket when a new user logs in.
  if (ticketRetryTimer) {
    clearTimeout(ticketRetryTimer);
    ticketRetryTimer = null;
  }
  // Reset the polling flag so a subsequent login doesn't inherit the
  // stale "WS is down" state — the new socket attempt will re-set it
  // if the gateway is still unavailable.
  pollingActive = false;
}
