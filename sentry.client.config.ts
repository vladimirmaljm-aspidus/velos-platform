import * as Sentry from "@sentry/nextjs";

/**
 * Sentry client-side initialization (F-8 — error monitoring).
 *
 * Activates ONLY when NEXT_PUBLIC_SENTRY_DSN is set in the environment —
 * this lets dev / preview deploys run with Sentry disabled (no DSN) and
 * production turn it on by setting the env var on Render.
 *
 * Why NEXT_PUBLIC_: Next.js only exposes env vars prefixed with NEXT_PUBLIC_
 * to the browser bundle. The DSN is public (it's an ingest URL, not a
 * secret) so this is safe.
 *
 * P3 / task C-8 — Sentry no-op warning. Mirrors the server-side check in
 * `sentry.server.config.ts`: if production is running without
 * NEXT_PUBLIC_SENTRY_DSN, emit a `console.warn` so the misconfiguration is
 * visible in the browser console (Render captures browser logs via the
 * `console` event source — this warning surfaces in production builds).
 * The `/api/health` endpoint also reports `sentry: "enabled" | "disabled"`
 * for ops dashboards.
 */
const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    tracesSampleRate: 0.1, // 10% of transactions — Render starter tier
    environment: process.env.NODE_ENV || "development",
    // Don't send errors in dev — they're noisy and usually local-only.
    // Devs can opt in by setting NEXT_PUBLIC_SENTRY_DSN locally.
    enabled: process.env.NODE_ENV === "production",
    // Ignore common browser noise that Sentry reports by default.
    ignoreErrors: [
      "ResizeObserver loop completed with undelivered notifications",
      "Network request failed",
      "Failed to fetch",
      "Load failed",
      "cancelled",
    ],
  });
} else if (process.env.NODE_ENV === "production") {
  // P3 / task C-8 — surface the misconfiguration. Without this, a
  // production deploy with a missing NEXT_PUBLIC_SENTRY_DSN silently
  // swallows every client-side error. The warning appears in the browser
  // console (visible to anyone opening devtools) and is also captured by
  // any client-side error-monitoring shim the operator may have installed.
  console.warn(
    "[Sentry] NEXT_PUBLIC_SENTRY_DSN not set — client-side error monitoring is disabled. " +
      "Set NEXT_PUBLIC_SENTRY_DSN to enable. Browser errors will NOT be reported to Sentry.",
  );
}

