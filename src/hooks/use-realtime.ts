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
 * Auth:
 *   The admin SPA's `user` from `useAppStore` is passed in the `auth`
 *   handshake so the gateway can join `user:<id>` and `tenant:<tid>` rooms.
 *   The JWT is NOT yet forwarded (the gateway trusts the handshake in dev);
 *   a follow-up will pass the `crm_session` cookie's payload as `auth.jwt`
 *   so the gateway can verify with `JWT_SECRET`.
 */

import { useEffect, useRef } from "react";
import { io, type Socket } from "socket.io-client";
import { useAppStore } from "@/lib/store/app-store";

// Module-level singleton — one connection per browser tab regardless of how
// many components mount `useRealtime`.
let socket: Socket | null = null;
let connectedUserId: string | null = null;

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

    // Lazy-init the singleton socket the first time we have a user. If the
    // user CHANGES (super-admin impersonation, login-as, etc.) tear down
    // and reconnect so the rooms are correct.
    if (!socket || connectedUserId !== user.id) {
      socket?.disconnect();
      socket = io(getWsUrl(), {
        transports: ["websocket"],
        auth: {
          token: {
            userId: user.id,
            tenantId: user.tenant_id ?? undefined,
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
      connectedUserId = user.id;

      socket.on("connect", () => {
        console.debug("[realtime] connected");
        // P0 / task D-FIX: the WS gateway is reachable — clear the polling
        // fallback so subsequent interval ticks are no-ops and the live
        // push path takes over.
        setPolling(false);
      });
      socket.on("disconnect", (reason) => {
        console.debug("[realtime] disconnected:", reason);
        // A short disconnect may be transient (Socket.IO will auto-retry)
        // but we flip polling on so the 30s interval covers the outage.
        // If the reconnect succeeds, `connect` fires and clears it.
        setPolling(true);
      });
      socket.on("connect_error", (err) => {
        // Likely the gateway is down or not yet deployed (the current
        // state — the mini-service exists in source but is not on
        // Render). Logged at debug so prod doesn't get spammed during an
        // outage; the polling fallback keeps the UI updating.
        console.debug("[realtime] connect_error:", err.message);
        setPolling(true);
      });
    }

    const names = eventKey ? eventKey.split("|") : [];
    // Each event name maps to a stable wrapper that reads the latest handler
    // from the ref. This is what lets callers pass new handler closures on
    // every render without us churning the socket's listener registry.
    const wrappers: Record<string, EventHandler> = {};
    for (const name of names) {
      const wrapper: EventHandler = (data) => handlersRef.current[name]?.(data);
      wrappers[name] = wrapper;
      socket!.on(name, wrapper);
    }

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
    // Reset the polling flag so a subsequent login doesn't inherit the
    // stale "WS is down" state — the new socket attempt will re-set it
    // if the gateway is still unavailable.
    pollingActive = false;
  }
}
