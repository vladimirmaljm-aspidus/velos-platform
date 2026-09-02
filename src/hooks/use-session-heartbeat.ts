"use client";

import { useEffect, useRef } from "react";

/**
 * useSessionHeartbeat — keep an authenticated session alive while the
 * user is ACTUALLY using the app.
 *
 * WHY THIS EXISTS (P0 fix)
 * ------------------------
 * Since the C1/8b-2 session hardening, every non-super_admin session
 * (admin, user AND portal_client) enforces an idle timeout
 * (`SessionConfig.idleTimeoutMs`, default 30 min) against the
 * `last_activity_at` claim baked into the session JWT at issue time.
 * The claim is ONLY ever refreshed by POST /api/auth/touch — but no
 * frontend code called it. Net effect: every admin/user/portal client
 * was silently logged out 30 minutes after LOGIN, even while actively
 * clicking through the app. Portal users mid-form lost their work;
 * the shell then hard-redirected to /login on the next 401.
 *
 * BEHAVIOUR
 * ---------
 * • POST /api/auth/touch every `intervalMs` (default 5 min) while the
 *   tab is VISIBLE — a hidden tab stops heartbeating, so a backgrounded
 *   tab genuinely counts as idle (security semantics preserved).
 * • The refreshed JWT (new last_activity_at, same exp) is written back
 *   by the route as the session cookie — nothing to do client-side.
 * • On 401 the session is gone (idle/absolute expiry or revoked):
 *   `onExpired` decides the redirect (portal → /portal/login,
 *   admin → /login). We do NOT redirect from inside the hook so it can
 *   be mounted by both shells with their own expiry UX.
 * • Failures are swallowed (best-effort): a transient network blip
 *   must not log anyone out; the next beat retries.
 * • Also fires once shortly after mount so short-lived (dev) idle
 *   windows are covered.
 *
 * audit25 (random-logout fix) — PROACTIVE EXPIRY WARNING:
 * The touch route now returns `expiresAt` (ms epoch) and `idleTimeoutMs`.
 * When the ABSOLUTE session expiry is less than `warnThresholdMs`
 * (default 15 min) away, `onExpiringSoon({ minutesLeft })` fires ONCE
 * per threshold-crossing so the shell can toast "Your session expires
 * in N minutes — save your work". Previously an admin working past
 * their absolute TTL (8h default) was dropped onto the login screen
 * mid-work with zero explanation ("app logs me out for no reason").
 */
export function useSessionHeartbeat({
  intervalMs = 5 * 60 * 1000,
  onExpired,
  onExpiringSoon,
  warnThresholdMs = 15 * 60 * 1000,
}: {
  /** Heartbeat period. Default 5 min — comfortably below the 30 min
   *  default idle timeout, resilient to one dropped beat. */
  intervalMs?: number;
  /** Called when the server answers 401 (session expired / revoked). */
  onExpired?: () => void;
  /** Called ONCE when the absolute session expiry is < warnThresholdMs
   *  away — surface a "save your work" warning to the user. */
  onExpiringSoon?: (info: { minutesLeft: number }) => void;
  /** How close (ms) to the absolute expiry the warning should fire. */
  warnThresholdMs?: number;
} = {}) {
  const onExpiredRef = useRef(onExpired);
  const onExpiringSoonRef = useRef(onExpiringSoon);

  // Keep the latest callbacks without re-running the heartbeat interval —
  // assignments must live INSIDE an effect (react-hooks/refs: never write
  // refs during render).
  useEffect(() => {
    onExpiredRef.current = onExpired;
    onExpiringSoonRef.current = onExpiringSoon;
  }, [onExpired, onExpiringSoon]);

  useEffect(() => {
    let stopped = false;
    // Fire the expiring-soon warning only once per threshold crossing —
    // otherwise every 5-min beat inside the final 15 min would re-toast.
    let warned = false;

    const beat = async () => {
      if (stopped) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return; // backgrounded tab = genuinely idle
      }
      try {
        const r = await fetch("/api/auth/touch", { method: "POST" });
        if (stopped) return;
        if (r.status === 401) {
          onExpiredRef.current?.();
          return;
        }
        // audit25: parse the enriched response so we can warn before the
        // ABSOLUTE expiry drops the user. Best-effort — old/deployed
        // versions without these fields simply skip the warning.
        if (r.ok && !warned) {
          try {
            const data = (await r.json()) as {
              expiresAt?: number;
            } | null;
            if (
              data &&
              typeof data.expiresAt === "number" &&
              Number.isFinite(data.expiresAt)
            ) {
              const msLeft = data.expiresAt - Date.now();
              if (msLeft > 0 && msLeft <= warnThresholdMs) {
                warned = true;
                onExpiringSoonRef.current?.({
                  minutesLeft: Math.max(1, Math.round(msLeft / 60_000)),
                });
              } else if (msLeft > warnThresholdMs) {
                // Still comfortably far from expiry — nothing to warn about.
              }
            }
          } catch {
            /* malformed JSON — ignore, warning is best-effort */
          }
        }
        // 200 / anything else — nothing to do (super_admin returns
        // {ok:true,bypassed:true}; transient 5xx retries next beat).
      } catch {
        /* offline / server restart — ignore, next beat retries */
      }
    };

    // Early first beat (covers refreshes near the idle boundary), then
    // the steady interval.
    const firstBeat = window.setTimeout(beat, 15_000);
    const id = window.setInterval(beat, intervalMs);

    // Resume heartbeat when the tab becomes visible again — the interval
    // kept running while hidden but beats were skipped, so fire one
    // immediately to re-validate before the user's next click does.
    const onVisible = () => {
      if (document.visibilityState === "visible") void beat();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stopped = true;
      window.clearTimeout(firstBeat);
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs, warnThresholdMs]);
}
