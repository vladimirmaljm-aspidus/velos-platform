/**
 * Next.js Instrumentation Hook.
 *
 * 1. Sentry (F-8): registers the Sentry SDK in the Node runtime when
 *    SENTRY_DSN is configured (see sentry.server.config.ts). Without a DSN
 *    the import is inert — Sentry stays disabled (verified 2026-09-07: no
 *    DSN is set on the Vercel project, so the in-house error audit below
 *    is the live capture path).
 *
 * 2. In-house error capture (Task 40): installs the console.error tee +
 *    process-level observers into error_logs. This is what makes server
 *    500s visible in the admin Error Audit view — previously every route's
 *    `console.error("[route]", error)` went ONLY to Vercel function logs
 *    (unbrowsable from the app), which is why the tenant-delete failures
 *    the platform owner hit on 2026-09-06 left no trace in error_logs.
 *    installServerConsoleCapture() is idempotent and never throws.
 */
export async function register() {
  // Server-only instrumentation.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");

    try {
      const { installServerConsoleCapture } = await import(
        "./src/lib/monitoring/error-audit"
      );
      installServerConsoleCapture();
    } catch (e) {
      // Error-capture bootstrap must never break the server. A missing
      // env var (Supabase not configured) is the expected dev case — the
      // tee simply won't be able to write, recordError degrades to
      // console.error (guarded by the reentrancy flag).
      console.warn(
        "[instrumentation] error-audit capture not installed:",
        e instanceof Error ? e.message : String(e),
      );
    }
  }
}
