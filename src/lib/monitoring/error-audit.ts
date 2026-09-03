/**
 * VELOS — In-house error audit system (task 8-c).
 * ─────────────────────────────────────────────────────────────────────────────
 * Storage + query helpers for the `error_logs` table (migration 086).
 *
 * Why: Sentry is DSN-inactive, so nothing currently captures runtime errors —
 * client JS errors, unhandled promise rejections, React render crashes, and
 * API 500s all disappear into browser consoles / stdout with no aggregation.
 * This module is the server half of a zero-external-services replacement:
 *
 *   • recordError()  — fingerprinted, atomic upsert (one row per distinct
 *     bug signature; recurrences increment occurrence_count). Called by
 *     the PUBLIC /api/client-errors route (source 'client') and by server
 *     code via withErrorCapture() / direct calls (source 'server').
 *   • listErrors() / errorStats() — the admin "Error Audit" view's data
 *     source (GET /api/admin/errors).
 *   • resolveError() / unresolveError() — admin triage actions.
 *   • withErrorCapture() — drop-in route-handler wrapper that records any
 *     THROWN error as source 'server' before rethrowing (mirrors withApm
 *     in src/lib/monitoring/apm.ts).
 *
 * Uses the same supabase client pattern as SupabaseStore (service-role
 * `getSupabase()`), but deliberately does NOT go through the Store
 * interface — error capture must stay standalone (never blocked by store
 * backend switching) and never bubble failures into the captured flow.
 *
 * HARD INVARIANT: nothing in this module may throw. Error capture that
 * throws begets error capture (infinite loop) or breaks the user flow it
 * was supposed to be observing. Every public function swallows failures
 * with a console.error and a null/empty return.
 */

import { createHash } from "crypto";
import { getSupabase } from "@/lib/supabase/client";
import type { ErrorLog, ErrorLogLevel, ErrorLogSource } from "@/lib/supabase/types";
import type { NextRequest, NextResponse } from "next/server";

// ─── Input sanitization ─────────────────────────────────────────────────────
//
// Client-supplied strings are untrusted (the /api/client-errors route is
// PUBLIC). Every field is length-capped and stripped of control characters
// before it reaches the DB — both to bound row size (context jsonb is
// stringified app-side to max 2000 chars) and to keep NUL/ESC/other control
// bytes out of logs that admins read and export.

export const ERROR_FIELD_LIMITS = {
  message: 1000,
  stack: 4000,
  url: 500,
  email: 200,
  userAgent: 500,
  role: 50,
  tenantId: 100,
  context: 2000,
} as const;

/** Remove control characters (C0 + DEL), keeping \n and \t — stacks are
 *  multi-line by nature. \r is normalized away so DB rows contain only \n. */
function stripControlChars(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/** Sanitize + cap an optional string field. Returns null for empty/absent. */
function cleanString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = stripControlChars(value).trim();
  if (!cleaned) return null;
  return cleaned.slice(0, max);
}

/**
 * Sanitize the free-form `context` object: JSON-stringify, cap at 2000 chars
 * (over-long context is truncated, not dropped — the JSON.parse in the admin
 * detail view gets a best-effort object back), strip control chars from the
 * serialized form, and parse it back so PostgREST stores valid JSONB.
 */
export function cleanContext(context: unknown): Record<string, unknown> | null {
  if (context === null || context === undefined) return null;
  let raw: string;
  try {
    raw = typeof context === "string" ? context : JSON.stringify(context);
  } catch {
    return null;
  }
  if (!raw || raw === "{}") return null;
  const capped = stripControlChars(raw).slice(0, ERROR_FIELD_LIMITS.context);
  try {
    const parsed = JSON.parse(capped);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    // Truncation broke the JSON — keep the raw text so the admin still sees
    // what the client sent (wrapped so it round-trips as valid JSONB).
    return { truncated: capped };
  }
}

// ─── Fingerprinting ─────────────────────────────────────────────────────────
//
// A fingerprint identifies a DISTINCT BUG SIGNATURE (not a distinct event):
// sha256(source + message + first stack line), truncated to 16 hex chars.
// The first stack line is included so two different throw sites that share
// a generic message ("Network request failed") stay separate rows, while
// the same crash from different users/timestamps collapses into one row
// whose occurrence_count grows. Stack lines below the first are ignored —
// they carry line/column numbers that differ per build.

/**
 * Compute the stable short fingerprint for an error signature.
 * @param source         'client' | 'server' — separates the two capture halves.
 * @param message        the error message (sanitized before hashing here).
 * @param stackFirstLine the FIRST line of the stack (throw site), or null.
 * @returns 16-char lowercase hex string.
 */
export function computeFingerprint(
  source: string,
  message: string,
  stackFirstLine: string | null | undefined,
): string {
  const msg = stripControlChars(String(message || "")).trim().slice(0, ERROR_FIELD_LIMITS.message);
  const stack = stackFirstLine
    ? stripControlChars(String(stackFirstLine)).trim().split("\n")[0].slice(0, 500)
    : "";
  return createHash("sha256")
    .update(`${source}::${msg}::${stack}`)
    .digest("hex")
    .slice(0, 16);
}

// ─── recordError ────────────────────────────────────────────────────────────

export interface RecordErrorInput {
  source: ErrorLogSource;
  level?: ErrorLogLevel;
  message: string;
  stack?: string | null;
  url?: string | null;
  user_agent?: string | null;
  user_email?: string | null;
  user_role?: string | null;
  tenant_id?: string | null;
  /** Free-form context (component stack, digest, HTTP status, …). */
  context?: Record<string, unknown> | string | null;
}

/** Build the sanitized DB row payload for a report (exported for tests). */
export function buildErrorRow(input: RecordErrorInput): Record<string, unknown> {
  const level: ErrorLogLevel = input.level === "warning" ? "warning" : "error";
  const message = cleanString(input.message, ERROR_FIELD_LIMITS.message);
  const stack = cleanString(input.stack, ERROR_FIELD_LIMITS.stack);
  // Fingerprint the THROW SITE (first "at ..." line), not the "Error: msg"
  // header (which just repeats the message). Matches the client-side
  // reporter's fingerprint input so both halves collapse the same bug.
  const stackLines = stack ? stack.split("\n").filter((l) => l.trim()) : [];
  const throwSite =
    stackLines.find((l) => l.trim().startsWith("at ")) || stackLines[0] || null;
  const fingerprint = computeFingerprint(input.source, message ?? "", throwSite);
  return {
    tenant_id: cleanString(input.tenant_id, ERROR_FIELD_LIMITS.tenantId),
    source: input.source,
    level,
    // message is NOT NULL in the schema — a report without a usable message
    // is recorded with a placeholder rather than rejected (capture-everything).
    message: message ?? "(no message)",
    stack,
    url: cleanString(input.url, ERROR_FIELD_LIMITS.url),
    user_agent: cleanString(input.user_agent, ERROR_FIELD_LIMITS.userAgent),
    user_email: cleanString(input.user_email, ERROR_FIELD_LIMITS.email),
    user_role: cleanString(input.user_role, ERROR_FIELD_LIMITS.role),
    context: cleanContext(input.context) ?? {},
    fingerprint,
  };
}

/**
 * Record an error report into error_logs.
 *
 * Primary path: the `record_error` Postgres RPC (migration 086) — a single
 * atomic UPSERT that increments occurrence_count on fingerprint conflict,
 * bumps last_seen_at, coalesces richer fields (never overwrites a non-null
 * stack with null), keeps the earliest first_seen_at, reopens resolved rows
 * (a recurrence is a regression signal), and caps the table at 5000 rows.
 *
 * Fallback path (RPC not installed yet — e.g. the code auto-deployed on
 * push but the SQL hasn't been applied via the Management API): a JS
 * select-then-update/insert two-step that mirrors the same semantics. Not
 * atomic, but the unique index on fingerprint makes the worst case a
 * duplicate-count miss, never data loss.
 *
 * NEVER throws — on failure it logs and returns null.
 */
export async function recordError(input: RecordErrorInput): Promise<ErrorLog | null> {
  try {
    const row = buildErrorRow(input);
    const sb = getSupabase();

    // ── 1) Atomic RPC path ──────────────────────────────────────────────
    const { data, error } = await sb.rpc("record_error", { p_payload: row });
    if (!error && data) {
      // SECURITY DEFINER RETURNS error_logs → single JSON object (the
      // supabase-js client surfaces it as an object, not an array).
      const out = Array.isArray(data) ? (data[0] as ErrorLog) : (data as ErrorLog);
      if (out && typeof out === "object") return out;
    }

    // ── 2) Fallback: RPC unavailable (PGRST202 / migration not applied) ─
    if (error) {
      console.warn(
        "[error-audit] record_error RPC unavailable (migration 086 not applied?) — using JS fallback. Error:",
        error.message,
      );
    }

    const existing = await sb
      .from("error_logs")
      .select("*")
      .eq("fingerprint", String(row.fingerprint))
      .maybeSingle();

    if (existing.error) throw existing.error;

    if (existing.data) {
      // Mirror the RPC's coalesce semantics in JS.
      const current = existing.data as ErrorLog;
      const { data: updated, error: updErr } = await sb
        .from("error_logs")
        .update({
          occurrence_count: (current.occurrence_count || 0) + 1,
          last_seen_at: new Date().toISOString(),
          tenant_id: row.tenant_id ?? current.tenant_id,
          stack: (row.stack as string | null) ?? current.stack,
          url: (row.url as string | null) ?? current.url,
          user_agent: (row.user_agent as string | null) ?? current.user_agent,
          user_email: (row.user_email as string | null) ?? current.user_email,
          user_role: (row.user_role as string | null) ?? current.user_role,
          context:
            current.context && Object.keys(current.context).length > 0
              ? current.context
              : (row.context as Record<string, unknown>),
          level: row.level === "error" ? "error" : current.level,
          resolved_at: null,
          resolved_by: null,
        })
        .eq("id", current.id)
        .select()
        .single();
      if (updErr) throw updErr;
      return (updated as ErrorLog) ?? null;
    }

    const { data: inserted, error: insErr } = await sb
      .from("error_logs")
      .insert({
        ...row,
        first_seen_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (insErr) throw insErr;
    return inserted as ErrorLog;
  } catch (e) {
    // HARD INVARIANT: never throw out of the capture path — a failing
    // error-capture call must not break the flow it observes or start a
    // capture loop.
    console.error(
      "[error-audit] recordError failed:",
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

// ─── Admin queries ──────────────────────────────────────────────────────────

export interface ErrorLogFilters {
  source?: string;
  level?: string;
  /** 'all' (default) | 'open' | 'resolved'. */
  resolved?: string;
  /** Case-insensitive substring over message + user_email. */
  q?: string;
  limit?: number;
  offset?: number;
  /**
   * Tenant scoping. UNDEFINED = no filter (super-admin / cross-tenant view).
   * A string = tenant admins see ONLY their own tenant's rows — error
   * messages and user emails can contain tenant data, so cross-tenant
   * visibility must stay super-admin-only (mirrors /api/audit's split of
   * tenant vs platform audit).
   */
  tenantId?: string;
}

export interface ErrorLogListResult {
  items: ErrorLog[];
  total: number;
}

export interface ErrorStats {
  total: number;
  open: number;
  client: number;
  server: number;
  last24h: number;
}

/**
 * Sanitize a user-provided search term before interpolating it into a
 * PostgREST `.or()` filter string (same hazard + same strip set as
 * safeSearch in supabase-store.ts — commas/parens/dots reshape the filter).
 */
function safeSearch(value: string): string {
  return value.replace(/[(),.\\]/g, " ");
}

/**
 * List error_logs for the admin Error Audit view, newest first.
 * Filters are pushed down to PostgREST (`.eq` / `.is` / `.or` + `.range`)
 * following the ADMIN-H12 pattern — no in-memory filtering of big tables.
 * Throws on DB errors so the route's catch can return a sanitized 500.
 */
export async function listErrors(filters: ErrorLogFilters = {}): Promise<ErrorLogListResult> {
  const sb = getSupabase();
  let q = sb.from("error_logs").select("*", { count: "exact" });

  if (filters.tenantId !== undefined) {
    q = q.eq("tenant_id", filters.tenantId);
  }
  if (filters.source === "client" || filters.source === "server") {
    q = q.eq("source", filters.source);
  }
  if (filters.level === "error" || filters.level === "warning") {
    q = q.eq("level", filters.level);
  }
  if (filters.resolved === "open") {
    q = q.is("resolved_at", null);
  } else if (filters.resolved === "resolved") {
    q = q.not("resolved_at", "is", null);
  }
  if (filters.q) {
    const term = safeSearch(filters.q);
    q = q.or(`message.ilike.%${term}%,user_email.ilike.%${term}%`);
  }

  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);
  const { data, error, count } = await q
    .order("last_seen_at", { ascending: false })
    .order("first_seen_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return { items: (data as ErrorLog[]) || [], total: count ?? 0 };
}

/**
 * Aggregate stats for the Error Audit view's KPI row. Each stat is a single
 * exact-count head query — bounded by the 5000-row table cap from
 * migration 086. Pass a tenantId to scope like listErrors (tenant admins);
 * omit it for the cross-tenant super-admin view.
 * Throws on DB errors so the route can surface a sanitized 500.
 */
export async function errorStats(tenantId?: string): Promise<ErrorStats> {
  const sb = getSupabase();
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  const base = () => sb.from("error_logs").select("*", { count: "exact", head: true });
  const scoped = () =>
    tenantId === undefined ? base() : base().eq("tenant_id", tenantId);

  const queries = [
    scoped(),
    scoped().is("resolved_at", null),
    scoped().eq("source", "client"),
    scoped().eq("source", "server"),
    scoped().gte("last_seen_at", dayAgo),
  ] as const;

  const [totalR, openR, clientR, serverR, last24hR] = await Promise.all(queries);
  const errors = [totalR.error, openR.error, clientR.error, serverR.error, last24hR.error];
  const firstError = errors.find((e) => !!e);
  if (firstError) throw new Error(firstError.message);

  return {
    total: totalR.count ?? 0,
    open: openR.count ?? 0,
    client: clientR.count ?? 0,
    server: serverR.count ?? 0,
    last24h: last24hR.count ?? 0,
  };
}

/**
 * Mark an error as resolved. Sets resolved_at=now() + resolved_by.
 * Returns false when the row doesn't exist (route turns that into a 404).
 * Pass a tenantId to scope the update like listErrors — a tenant admin
 * resolving a foreign tenant's row id gets a 404, not a state change.
 * Never throws on DB failure — the route's catch handles 500s.
 */
export async function resolveError(
  id: string,
  resolvedBy: string,
  tenantId?: string,
): Promise<boolean> {
  try {
    const sb = getSupabase();
    let q = sb
      .from("error_logs")
      .update({
        resolved_at: new Date().toISOString(),
        resolved_by: resolvedBy.slice(0, ERROR_FIELD_LIMITS.email),
      })
      .eq("id", id)
      .is("resolved_at", null);
    if (tenantId !== undefined) q = q.eq("tenant_id", tenantId);
    const { data, error } = await q.select("id").maybeSingle();
    if (error) throw error;
    return !!data;
  } catch (e) {
    console.error("[error-audit] resolveError failed:", e instanceof Error ? e.message : String(e));
    return false;
  }
}

/**
 * Re-open a resolved error (admin undo). Returns false when the row doesn't
 * exist / isn't resolved. Pass a tenantId to scope like resolveError.
 * Never throws.
 */
export async function unresolveError(id: string, tenantId?: string): Promise<boolean> {
  try {
    const sb = getSupabase();
    let q = sb
      .from("error_logs")
      .update({ resolved_at: null, resolved_by: null })
      .eq("id", id)
      .not("resolved_at", "is", null);
    if (tenantId !== undefined) q = q.eq("tenant_id", tenantId);
    const { data, error } = await q.select("id").maybeSingle();
    if (error) throw error;
    return !!data;
  } catch (e) {
    console.error("[error-audit] unresolveError failed:", e instanceof Error ? e.message : String(e));
    return false;
  }
}

// ─── Server-route capture wrapper ───────────────────────────────────────────

type AnyRouteHandler = (req: NextRequest, ...args: unknown[]) => Promise<NextResponse>;

/**
 * Wrap an API route handler so a THROWN error is recorded into error_logs
 * (source 'server') before it propagates. Mirrors `withApm` in apm.ts —
 * the two compose freely (withErrorCapture(withApm(handler))).
 *
 * Handlers in this codebase already catch their own errors and return
 * sanitized 500 responses; those NEVER reach this wrapper. Adoption is
 * therefore incremental: routes that want 500-recording either call
 * recordError({source:'server', ...}) in their catch block directly, or are
 * wrapped here when their catch rethrows. (See the admin errors route for
 * the direct-call pattern.)
 *
 * Recording failure is swallowed (console.error) — capture must never make
 * the original error worse.
 */
export function withErrorCapture<T extends AnyRouteHandler>(handler: T, routeName?: string): T {
  return (async (req: NextRequest, ...args: unknown[]) => {
    try {
      return await handler(req, ...args);
    } catch (error) {
      try {
        const route =
          routeName || (req?.url ? String(req.url).split("?")[0] : "unknown");
        await recordError({
          source: "server",
          level: "error",
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : null,
          url: route,
          context: { method: req?.method || "GET", capturedBy: "withErrorCapture" },
        });
      } catch {
        // Swallow — see docblock. (recordError itself never throws, but a
        // future refactor could break that invariant; this guard holds.)
      }
      throw error;
    }
  }) as T;
}
