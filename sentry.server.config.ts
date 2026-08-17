import * as Sentry from "@sentry/nextjs";

/**
 * Sentry server-side initialization (F-8 — error monitoring).
 *
 * Activates ONLY when SENTRY_DSN is set in the environment — this lets
 * dev / preview deploys run with Sentry disabled (no DSN) and production
 * turn it on by setting the env var on Render.
 *
 * The server DSN does NOT need the NEXT_PUBLIC_ prefix because it's only
 * read by Node.js (never shipped to the browser). Use the same DSN as the
 * client if you want both server + client events in one project.
 *
 * P3 / task C-8 — Sentry no-op warning. Previously, if SENTRY_DSN was
 * unset in production, Sentry silently no-op'd: every error was invisible
 * (no Sentry events, no warning, nothing in the health check). Now we
 * emit a loud `console.warn` on server startup when production is running
 * without a DSN, so the misconfiguration is discoverable from the
 * Render logs. The `/api/health` endpoint also surfaces `sentry: "enabled"
 * | "disabled"` so uptime monitors / ops dashboards can alert on it.
 */
const SENTRY_DSN = process.env.SENTRY_DSN;

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    tracesSampleRate: 0.1, // 10% of transactions — Render starter tier
    environment: process.env.NODE_ENV || "development",
    enabled: process.env.NODE_ENV === "production",
    // Capture unhandled rejections + uncaught exceptions automatically.
    // Next.js already routes these through its error boundary, but the
    // Sentry server SDK adds them to the global scope so they reach the
    // ingest endpoint even if the route handler doesn't catch them.
  });
} else if (process.env.NODE_ENV === "production") {
  // P3 / task C-8 — surface the misconfiguration. Without this, a
  // production deploy with a missing SENTRY_DSN silently swallows every
  // server-side error (the only signal would be the absence of Sentry
  // events, which is impossible to distinguish from "no errors
  // occurred"). The warning is emitted once at server startup (this
  // module is loaded by `instrumentation.ts` per server instance).
  console.warn(
    "[Sentry] SENTRY_DSN not set — error monitoring is disabled. " +
      "Set SENTRY_DSN to enable. Server-side errors will NOT be reported to Sentry. " +
      "See /api/health for the current sentry status.",
  );
}

