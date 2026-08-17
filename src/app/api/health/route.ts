import { NextResponse } from "next/server";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase/client";

export const runtime = "nodejs";
// Health checks should never be cached — Render polls every ~30s and a
// stale 200 would mask an actual outage.
export const dynamic = "force-dynamic";

/**
 * Lightweight platform health probe for uptime monitors (Render, UptimeRobot,
 * etc.) — see worklog P0/A-3.
 *
 * Behaviour:
 *   • Supabase env vars missing → 503 `{status:"degraded", db:"not_configured"}`
 *   • DB unreachable / query errors → 503 `{status:"degraded", db:"error", error}`
 *   • DB reachable                  → 200 `{status:"ok", db:"connected"}`
 *
 * Implementation note: the previous version called `store.listTenants()` but
 * SWALLOWED the error in the catch block (returning `{status:"ok"}` on
 * failure), which defeated the purpose of a health check. This version
 * surfaces failures with HTTP 503 so Render's health check correctly marks
 * the service as unhealthy.
 *
 * The probe uses a HEAD query against the `tenants` table (always present,
 * tiny) — PostgREST translates this to a `SELECT count(*) FROM tenants`
 * against Postgres, which is enough to verify the DB connection pool,
 * network path, and service_role key are all working. We don't use a raw
 * `SELECT 1` because PostgREST doesn't expose arbitrary SQL — the table
 * query is the cheapest liveness check available via the JS client.
 *
 * P3 / task C-8 — Sentry status. The response now includes a `sentry`
 * field reporting whether error monitoring is enabled. This lets uptime
 * monitors / ops dashboards alert on a misconfigured production deploy
 * (e.g. someone forgot to set SENTRY_DSN on Render). The field does NOT
 * affect the HTTP status — a missing Sentry DSN is a degraded
 * observability state, not a service outage, so we still return 200 if
 * the DB is reachable. The startup-time warning in
 * `sentry.server.config.ts` is the louder signal; this field is the
 * machine-readable counterpart.
 */
export async function GET() {
  // 1) Fail fast if env vars aren't set at all (e.g. preview deploy missing
  //    secrets). Avoids the noisy `getSupabase()` throw below.
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      {
        status: "degraded",
        db: "not_configured",
        error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set",
        // Still report Sentry status even when the DB is down — ops needs
        // to know both independently.
        sentry: getSentryStatus(),
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const supabase = getSupabase();
    // HEAD request: PostgREST returns only the count, no rows — minimal DB
    // load. The `count` value itself is irrelevant; we only care whether the
    // request succeeded.
    const { error } = await supabase
      .from("tenants")
      .select("id", { count: "exact", head: true });

    if (error) {
      return NextResponse.json(
        {
          status: "degraded",
          db: "error",
          error: error.message,
          sentry: getSentryStatus(),
        },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }

    return NextResponse.json(
      {
        status: "ok",
        db: "connected",
        sentry: getSentryStatus(),
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    // `getSupabase()` throws if env vars are missing or the client can't be
    // constructed; surface that as a 503 too.
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json(
      {
        status: "degraded",
        db: "error",
        error: message,
        sentry: getSentryStatus(),
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}

/**
 * Returns the current Sentry configuration status for the health response.
 *
 * - `"enabled"` — both server (`SENTRY_DSN`) and client
 *   (`NEXT_PUBLIC_SENTRY_DSN`) DSNs are set in the environment. Sentry
 *   will report both server-side and client-side errors.
 * - `"server_only"` — only the server DSN is set. Client-side errors are
 *   NOT being reported (the browser has no DSN to send to).
 * - `"client_only"` — only the client DSN is set. Server-side errors are
 *   NOT being reported.
 * - `"disabled"` — neither DSN is set. No error monitoring at all.
 *
 * Note: this only reports whether the ENV VARS are set. The Sentry SDK
 * itself may still be disabled in development (`enabled: process.env.NODE_ENV
 * === "production"` in the config files). The health field is intended for
 * production ops monitoring, so we don't surface the dev-mode toggle here.
 */
function getSentryStatus(): "enabled" | "server_only" | "client_only" | "disabled" {
  const serverDsn = !!process.env.SENTRY_DSN;
  const clientDsn = !!process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (serverDsn && clientDsn) return "enabled";
  if (serverDsn) return "server_only";
  if (clientDsn) return "client_only";
  return "disabled";
}
