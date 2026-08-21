"use client";

import { useEffect, useRef } from "react";

/**
 * Push notification permission prompt.
 *
 * Behaviour:
 *   - On mount, start a 30-second timer that, when it elapses, asks the user
 *     for notification permission (if not already granted/denied).
 *   - If the user clicks anywhere in the document before the 30s timer fires,
 *     cancel the timer AND prompt immediately (the user is engaged, so the
 *     prompt is more likely to land well).
 *   - The decision to *prompt at all* is stored in localStorage so we never
 *     ask twice — even across sessions. If the user denied the OS-level
 *     permission, we won't pester them again.
 *
 * This component renders nothing — it's a side-effect-only mount.
 */
export function PushNotificationsPrompt() {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const promptedRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("Notification" in window)) return;
    // Only run in production — dev serves the SW is disabled, so push
    // subscription would fail anyway.
    if (process.env.NODE_ENV !== "production") return;

    const STORAGE_KEY = "velos:push-prompted";

    // Already prompted (this session or any previous one)?
    try {
      if (localStorage.getItem(STORAGE_KEY) === "1") return;
    } catch {
      // localStorage unavailable (private mode) — proceed; we'll guard with
      // promptedRef instead so we don't re-prompt within this session.
    }

    const alreadyDecided =
      Notification.permission === "granted" ||
      Notification.permission === "denied";
    if (alreadyDecided) return;

    const ask = () => {
      if (promptedRef.current) return;
      promptedRef.current = true;
      try {
        localStorage.setItem(STORAGE_KEY, "1");
      } catch {
        // ignore
      }
      // Best-effort — never block on the result. The browser will surface
      // its own OS-level permission UI; we just trigger it.
      Notification.requestPermission().catch(() => {
        /* Some browsers reject the promise if the user has previously
         * dismissed the prompt; nothing to do. */
      });
    };

    // 30s idle prompt.
    timerRef.current = setTimeout(ask, 30_000);

    // First-click early trigger.
    const onClick = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      ask();
    };
    window.addEventListener("click", onClick, { once: true });

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      window.removeEventListener("click", onClick);
    };
  }, []);

  return null;
}
