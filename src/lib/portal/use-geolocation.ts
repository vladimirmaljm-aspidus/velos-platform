"use client";

import { useEffect, useRef, useState } from "react";
import type { PortalAccess } from "@/lib/supabase/types";
import { getTierMeta } from "@/lib/portal/tiers";

/**
 * Captures the browser geolocation of the signed-in portal client and POSTs
 * it to /api/portal/log-location for audit logging.
 *
 * Behavior is driven by the portal tier:
 *  - Premium: location sharing is OPTIONAL — we still ask once, but if the
 *    user denies or the browser doesn't support it, we don't block.
 *  - All other tiers (Business / Standard / Basic): location is REQUIRED.
 *    The hook exposes `required` = true and `shared` = false until the
 *    browser grants permission. The portal shell can gate content behind
 *    this state.
 *
 * Location is captured ONCE per login (per access.id). No periodic re-logging
 * — the audit entry belongs to the login event, not to session activity.
 *
 * FIX (P1-7): after 23 hours (1 hour before the 24h server-side expiry),
 * the hook automatically re-requests GPS so the user doesn't get stuck
 * with empty lists when the server expires the verification.
 */
export function usePortalGeolocation(access: PortalAccess | null) {
  const [state, setState] = useState<{
    loading: boolean;
    shared: boolean;
    required: boolean;
    error: string | null;
    coords: { latitude: number; longitude: number; accuracy?: number } | null;
  }>({
    loading: false,
    shared: false,
    required: false,
    error: null,
    coords: null,
  });

  const sentRef = useRef(false);
  const verifiedAtRef = useRef<number>(0);

  useEffect(() => {
    if (!access) return;
    const meta = getTierMeta(access.tier);
    const required = meta.requiresLocation;

    // Use microtask to avoid synchronous setState in effect body
    queueMicrotask(() => setState((s) => ({ ...s, required })));

    const sendLocation = (
      coords: { latitude: number; longitude: number; accuracy?: number },
      source: string
    ) => {
      fetch("/api/portal/log-location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...coords, source }),
        keepalive: true,
      }).then((r) => {
        if (r.ok) {
          verifiedAtRef.current = Date.now();
        }
      }).catch((e) => {
        // P1-9: surface the failure to the user instead of silently
        // swallowing it. Reset `shared` to false so the GPS gate
        // re-appears — the location was NOT recorded by the server.
        console.error("[portal-gps] Failed to log location:", e);
        setState((s) => ({
          ...s,
          shared: false,
          error: "Failed to verify your location. Please try again.",
        }));
      });
    };

    const onSuccess = (pos: GeolocationPosition) => {
      const coords = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      };
      setState((s) => ({
        ...s,
        loading: false,
        shared: true,
        error: null,
        coords,
      }));
      sendLocation(coords, "browser");
      sentRef.current = true;
    };

    const onError = (err: GeolocationPositionError) => {
      // Always log an IP-only entry so the audit trail has a record even if
      // the browser denied geolocation.
      sendLocation({ latitude: 0, longitude: 0, accuracy: 0 }, "ip");
      setState((s) => ({
        ...s,
        loading: false,
        shared: !required, // premium: still "ok" — required tiers stay blocked
        error: err.message || "Geolocation denied",
      }));
      sentRef.current = true;
    };

    const request = () => {
      if (!navigator.geolocation) {
        onError({ message: "Geolocation not supported" } as GeolocationPositionError);
        return;
      }
      setState((s) => ({ ...s, loading: true }));
      navigator.geolocation.getCurrentPosition(onSuccess, onError, {
        enableHighAccuracy: true,
        timeout: 10_000,
        maximumAge: 5 * 60 * 1000,
      });
    };

    // Fire once per login. `sentRef` protects against React strict-mode
    // double-invoke and against any accidental re-render loop.
    if (!sentRef.current) request();

    // FIX (P1-7): check every 5 minutes if the 23-hour window is approaching.
    // If so, re-request GPS so the user doesn't get stuck when the server
    // expires the verification at 24 hours.
    const RE_VERIFY_MS = 23 * 60 * 60 * 1000; // 23 hours (1h before 24h expiry)
    const CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
    const interval = setInterval(() => {
      if (!required || !state.shared) return;
      const elapsed = Date.now() - (verifiedAtRef.current || 0);
      if (elapsed > RE_VERIFY_MS) {
        // GPS verification is about to expire — re-request.
        setState((s) => ({ ...s, loading: true, shared: false }));
        sentRef.current = false;
        request();
      }
    }, CHECK_INTERVAL);

    return () => clearInterval(interval);
  }, [access?.id, access?.tier, state.shared]);

  return state;
}
