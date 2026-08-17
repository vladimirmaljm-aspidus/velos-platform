// src/lib/api/cron-auth.ts
// ----------------------------------------------------------------------------
// Shared auth helper for /api/cron/* routes.
//
// P1 timing-attack fix (task C-5 Fix 1): the previous implementation compared
// the presented cron token to `process.env.CRON_TOKEN` with `===`, which is
// vulnerable to timing attacks — a string comparison short-circuits on the
// first byte that differs, so an attacker who can measure response time can
// recover the token one byte at a time. We use `crypto.timingSafeEqual` which
// always compares both buffers in full, regardless of where they differ.
//
// Auth model (unchanged from the per-route inline code that preceded this
// helper): a request is authorised if ANY of the following is true:
//   1. `Authorization: Bearer <CRON_TOKEN>` header — preferred (keeps the
//      token out of URL query strings / logs).
//   2. `?token=<CRON_TOKEN>` URL query — legacy, kept for backward
//      compatibility while pg_cron jobs are migrated to headers.
//   3. A valid super_admin session cookie — for manual runs from the browser.
//
// Usage:
//   const auth = await authorizeCron(req);
//   if (auth) return auth; // 401 NextResponse
//   // …cron body…
// ----------------------------------------------------------------------------

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";

/**
 * Constant-time string comparison. Returns false (not throws) when the
 * lengths differ — `timingSafeEqual` throws on length mismatch, so we have
 * to short-circuit ourselves. The length-check branch itself leaks the
 * token length, but the token length is already public (it's compared
 * against `process.env.CRON_TOKEN` whose length is fixed per deployment)
 * and is not security-sensitive.
 */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/**
 * Authorise a /api/cron/* request.
 *
 * Returns `null` when the request is authorised (the caller should proceed).
 * Returns a `NextResponse` (401) when NOT authorised — the caller should
 * `return` it immediately.
 *
 * The super-admin session fallback is loaded lazily via `requireSuperAdmin`
 * only when the cron-token check fails, so the common case (pg_cron call
 * with a Bearer header) does not pay the cost of a DB round-trip + cookie
 * parse.
 */
export async function authorizeCron(req: NextRequest): Promise<NextResponse | null> {
  const url = new URL(req.url);
  const expected = process.env.CRON_TOKEN;

  // Extract the presented token from either the Authorization header
  // (preferred) or the ?token= query parameter (legacy).
  const authHeader = req.headers.get("authorization") || "";
  const headerToken = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : null;
  const queryToken = url.searchParams.get("token");
  const presentedToken = headerToken || queryToken;

  // Constant-time comparison against the configured CRON_TOKEN. We
  // intentionally do NOT short-circuit on `!expected` — if the operator
  // forgot to set CRON_TOKEN, every cron call should fail loudly with a
  // 401 (and a log line) rather than silently allowing unauthenticated
  // access. The super-admin fallback below is the escape hatch for
  // manual browser runs.
  let authorised = !!expected && !!presentedToken && safeCompare(presentedToken, expected);

  if (!authorised) {
    // Fall back to super_admin session cookie — manual browser runs from
    // the admin UI. Loaded lazily so the common pg_cron path doesn't pay
    // the cost.
    try {
      const { requireSuperAdmin } = await import("@/lib/api/helpers");
      const sa = await requireSuperAdmin(req);
      if (sa instanceof NextResponse) return sa;
      authorised = true;
    } catch (e) {
      console.error("[cron-auth] super_admin fallback failed:", e);
    }
  }

  if (!authorised) {
    return NextResponse.json({ error: "Unauthorised." }, { status: 401 });
  }
  return null;
}
