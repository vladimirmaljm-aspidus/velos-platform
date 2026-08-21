import { getSupabase, isSupabaseConfigured } from "@/lib/supabase/client";

/**
 * F-7 (CSRF + Rate Limiting) — DB-backed rate limiter.
 *
 * The existing in-memory rate limiter (src/middleware.ts) is per-instance:
 * on Render's multi-instance setup each replica has its own Map, so an
 * attacker rotating across instances (or simply lucky enough to land on a
 * fresh one) bypasses the cap entirely. This module uses a shared
 * `rate_limits` table (see supabase/migrations/024_rate_limits.sql) and a
 * Postgres `check_rate_limit()` RPC for an atomic increment + window
 * rollover via a single SQL UPSERT (INSERT … ON CONFLICT DO UPDATE).
 *
 * USAGE
 *   const { allowed, remaining, retryAfter } = await checkRateLimit(
 *     `login:ip:${ip}`,
 *     20,             // 20 attempts
 *     15 * 60 * 1000, // per 15 minutes
 *   );
 *   if (!allowed) {
 *     return NextResponse.json(
 *       { error: "Too many login attempts. Try again later." },
 *       { status: 429, headers: { "Retry-After": String(Math.ceil(retryAfter! / 1000)) } },
 *     );
 *   }
 *
 * FALLBACK
 *   If Supabase is not configured (e.g. local dev with DB_BACKEND=mock), the
 *   limiter returns `{ allowed: true }` and lets the request through. The
 *   in-memory middleware limiter is still in front as a defense-in-depth
 *   layer, so dev environments are not wide open. If Supabase IS configured
 *   but the `check_rate_limit` RPC isn't installed (migration not yet
 *   applied), the limiter ALSO fails open — same rationale (rate-limiting is
 *   defense-in-depth, not the primary auth gate).
 *
 * ATOMICITY
 *   The RPC is a single SQL statement — `INSERT … ON CONFLICT (key)
 *   DO UPDATE SET count = …` — so concurrent requests cannot race the
 *   count. Postgres row-level locks on the conflicting row serialize the
 *   increments.
 */

export interface RateLimitResult {
  /** Whether the request is allowed under the limit. */
  allowed: boolean;
  /** Remaining attempts in the current window (>= 0). */
  remaining: number;
  /** Milliseconds until the window resets (only set when `allowed` is false). */
  retryAfter?: number;
  /** Current count in the window (for observability). */
  count: number;
}

/** Shape returned by the `check_rate_limit` Postgres RPC.
 *
 * NOTE: the column is named `cnt` (not `count`) in the RPC definition to
 * avoid ambiguity with the `rate_limits.count` table column inside the
 * RETURNING clause — see migration 024.
 */
interface RateLimitRpcRow {
  cnt: number;
  window_start: string;
  allowed: boolean;
}

/**
 * Check (and increment) a rate-limit counter.
 *
 * @param key         Rate-limit key, e.g. `login:ip:1.2.3.4`.
 * @param maxAttempts Maximum hits allowed within the window.
 * @param windowMs    Window duration in milliseconds.
 * @returns           {@link RateLimitResult} — caller MUST return 429 if
 *                    `allowed === false`.
 */
export async function checkRateLimit(
  key: string,
  maxAttempts: number,
  windowMs: number,
): Promise<RateLimitResult> {
  // ── Fallback: Supabase not configured → allow. ──────────────────────────
  // The in-memory middleware limiter (src/middleware.ts) is still in front.
  if (!isSupabaseConfigured()) {
    return { allowed: true, remaining: maxAttempts, count: 1 };
  }

  const supabase = getSupabase();
  const nowMs = Date.now();

  // ── Atomic RPC: single-statement UPSERT + window rollover ──────────────
  // The `check_rate_limit` function (migration 024) does:
  //   INSERT INTO rate_limits(key, count, window_start) VALUES (key, 1, now)
  //   ON CONFLICT (key) DO UPDATE
  //     SET count = CASE WHEN in-window THEN count+1 ELSE 1 END,
  //         window_start = CASE WHEN in-window THEN window_start ELSE now END
  //   RETURNING count, window_start, (count <= max_attempts) AS allowed;
  //
  // Postgres serializes conflicts on the UNIQUE(key) constraint, so two
  // concurrent requests will see count=N and count=N+1 respectively — never
  // both count=N.
  try {
    const { data, error } = await supabase.rpc("check_rate_limit", {
      p_key: key,
      p_max_attempts: maxAttempts,
      p_window_ms: windowMs,
    });

    if (error) {
      // RPC not installed (migration hasn't run) — fail open with a loud log.
      console.warn(
        "[rate-limiter] check_rate_limit RPC unavailable (migration 024 not applied?). " +
          "Failing open — in-memory middleware limiter still in front. Error:",
        error.message,
      );
      return { allowed: true, remaining: maxAttempts, count: 0 };
    }

    if (!data || typeof data !== "object") {
      console.warn("[rate-limiter] RPC returned unexpected payload:", data);
      return { allowed: true, remaining: maxAttempts, count: 0 };
    }

    // The RPC uses `RETURN QUERY SELECT ...` which the Supabase JS client
    // returns as an ARRAY of rows, not a single object. A single-row result
    // looks like `[{ cnt: 1, window_start: "...", allowed: true }]`.
    // Extract the first (and only) row. If somehow empty, fail open.
    const row = (Array.isArray(data) ? data[0] : data) as RateLimitRpcRow | undefined;
    if (!row) {
      console.warn("[rate-limiter] RPC returned empty array, allowing request");
      return { allowed: true, remaining: maxAttempts, count: 0 };
    }

    const allowed = !!row.allowed;
    const currentCount = row.cnt;
    const remaining = Math.max(0, maxAttempts - currentCount);
    const retryAfter = allowed
      ? undefined
      : Math.max(1000, new Date(row.window_start).getTime() + windowMs - nowMs);
    return { allowed, remaining, retryAfter, count: currentCount };
  } catch (e) {
    // ── Hard failure: fail OPEN (allow the request). ─────────────────────
    // Rationale: rate-limiting is a defense-in-depth layer, not the primary
    // auth gate. The actual login still goes through password verification,
    // per-account lockout, and session controls. Failing closed would lock
    // every user out during a transient DB outage.
    console.error("[rate-limiter] check failed, allowing request:", e);
    return { allowed: true, remaining: maxAttempts, count: 0 };
  }
}

/**
 * Reset a rate-limit counter (e.g. on successful login, so the user doesn't
 * carry a partial failed-attempt count forward into the next window).
 *
 * Best-effort: errors are swallowed. The window will roll over naturally
 * anyway, so this is purely an optimization to avoid false-positive blocks
 * immediately after a successful auth.
 */
export async function resetRateLimit(key: string): Promise<void> {
  if (!isSupabaseConfigured()) return;
  try {
    const supabase = getSupabase();
    await supabase.from("rate_limits").delete().eq("key", key);
  } catch (e) {
    // Non-critical — see JSDOC above.
    console.debug("[rate-limiter] reset failed:", e);
  }
}
