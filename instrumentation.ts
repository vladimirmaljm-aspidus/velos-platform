/**
 * Next.js Instrumentation Hook (F-8 — Sentry error monitoring).
 *
 * Runs once per server instance BEFORE any route handler is invoked.
 * The `register` export is the documented entry point for Sentry's
 * Next.js SDK to attach global listeners (unhandled rejections,
 * uncaught exceptions, etc.) on the Node.js server.
 *
 * See: https://docs.sentry.io/platforms/javascript/guides/nextjs/
 *
 * NOTE: The actual `Sentry.init()` call lives in `sentry.server.config.ts`
 * (auto-loaded by `@sentry/nextjs` during build). This hook is what wires
 * the SDK into the server runtime.
 */
export async function register() {
  // Server-only instrumentation.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
}
