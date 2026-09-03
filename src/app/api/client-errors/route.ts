import { NextRequest, NextResponse } from "next/server";
import { getIp } from "@/lib/api/helpers";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { recordError } from "@/lib/monitoring/error-audit";
import { getSessionFromCookie } from "@/lib/auth/session";
import { getStore } from "@/lib/data/store";

export const runtime = "nodejs";

// ─── /api/client-errors — PUBLIC client-side error ingest (task 8-c) ────────
//
// Endpoint for src/components/error-reporter.tsx (window "error" +
// "unhandledrejection" listeners + explicit reportError() calls from the
// React error boundaries). Design constraints:
//
//   • PUBLIC — no auth. Errors must be reportable BEFORE login (a broken
//     login page is exactly what we need to see). User email/role/tenant
//     are enriched from the session cookie WHEN present, but their absence
//     is not an error.
//   • 30 req/min per IP via the repo's DB-backed checkRateLimit helper
//     (same pattern as /api/auth/login). The reporter client dedupes per
//     page-load, so legit users never come close; the cap exists for a
//     looping script or an abusive client.
//   • Body cap 8KB — oversized payloads (dumped state, giant stacks) are
//     silently dropped with 204.
//   • ALWAYS 204, NEVER an error response (except the 429 rate-limit
//     rejection, which carries Retry-After and tells the reporter to stop
//     for this window). The endpoint itself failing would create an error
//     loop: the reporter POST fails → unhandled rejection → reporter POST…
//     recordError() also never throws, so DB outages degrade to silent
//     drops.
//   • Cache-Control: no-store — POST responses aren't cacheable anyway,
//     but P0-3 (audit "no-cache on /api") made the header universal on
//     /api routes.

const MAX_BODY_BYTES = 8192;
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

/** Best-effort session enrichment — enriches email/role/tenant when the
 *  reporter happens to run while a session cookie is present. NEVER throws
 *  (a failed lookup just yields an anonymous report). */
async function enrichFromSession(): Promise<{
  user_email?: string | null;
  user_role?: string | null;
  tenant_id?: string | null;
}> {
  try {
    const session = await getSessionFromCookie();
    if (!session) return {};
    // Portal sessions carry "portal:<uuid>" as sub — the users table has no
    // such row (getUserById returns null), so record role + tenant only.
    // portal_access.portal_email stays unread here: it's encrypted at rest
    // and the extra lookup isn't worth it for an error report's metadata.
    if (session.role === "portal_client" || session.sub?.startsWith("portal:")) {
      return { user_email: null, user_role: "portal_client", tenant_id: session.tenant_id ?? null };
    }
    const store = await getStore();
    const user = await store.getUserById(session.sub);
    return {
      user_email: user?.email ?? null,
      user_role: session.role,
      tenant_id: session.tenant_id ?? null,
    };
  } catch {
    return {};
  }
}

export async function POST(req: NextRequest) {
  try {
    // ── 1) Rate limit BEFORE reading the body (cheap early reject). ──────
    const ip = getIp(req);
    const rl = await checkRateLimit(
      `client-errors:ip:${ip}`,
      RATE_LIMIT_MAX,
      RATE_LIMIT_WINDOW_MS,
    );
    if (!rl.allowed) {
      // 429 is the ONE non-204 response this route may return: it is not an
      // error, it's the "stop sending" signal, and the reporter never
      // retries (the failing POST is swallowed in a try/catch client-side,
      // never rethrown as an unhandled rejection).
      return new NextResponse(null, {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil((rl.retryAfter ?? 60_000) / 1000)),
          "Cache-Control": "no-store",
        },
      });
    }

    // ── 2) Body cap — oversized payloads are dropped, not rejected. ──────
    const contentLength = Number(req.headers.get("content-length") || "0");
    if (contentLength > MAX_BODY_BYTES) {
      return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    }
    let raw: string;
    try {
      raw = await req.text();
    } catch {
      return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    }
    if (raw.length > MAX_BODY_BYTES) {
      return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    }

    // ── 3) Shape validation — invalid payloads are dropped silently. ─────
    let body: {
      message?: unknown;
      stack?: unknown;
      url?: unknown;
      level?: unknown;
      context?: unknown;
    };
    try {
      body = JSON.parse(raw);
    } catch {
      return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    }
    if (!body || typeof body !== "object" || typeof body.message !== "string" || !body.message.trim()) {
      return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    }
    const level = body.level === "warning" ? "warning" : "error";

    // ── 4) Record (never throws; DB outage → silent drop). ───────────────
    const sessionInfo = await enrichFromSession();
    await recordError({
      source: "client",
      level,
      message: body.message,
      stack: typeof body.stack === "string" ? body.stack : null,
      url: typeof body.url === "string" ? body.url : null,
      user_agent: req.headers.get("user-agent") || null,
      ...sessionInfo,
      context:
        body.context && typeof body.context === "object" ? (body.context as Record<string, unknown>) : null,
    });

    return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch {
    // HARD INVARIANT — never surface an error from the error-reporting
    // endpoint itself (see header comment: a 500 here feeds the loop we
    // exist to observe, not break).
    return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
}
