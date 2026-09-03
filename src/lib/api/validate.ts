/**
 * Shared request-body validation helpers (task 31-f — validation hardening).
 *
 * WHY THIS FILE EXISTS
 * ─────────────────────
 * The deep API audit (tasks 30-a / 30-b — see
 * /home/z/audit/apitest/results/30-a-findings.json, findings 30a-07 / 30a-08,
 * and report 30-b.md "BUG-2") found ~20 routes that return **500 on invalid
 * client input** instead of a 4xx:
 *
 *   • POST `{}` (or missing required fields) → the body flows straight into
 *     the store upsert → Postgres NOT NULL violation → generic catch →
 *     `sanitizeError()` → 500 "Missing required field." (or, worse, an
 *     EMPTY error body on webhooks/letterheads/tasks).
 *   • String-where-number payloads (`"unit_price": "cheap"`) → PostgREST
 *     22P02 ("invalid input syntax for type numeric") → 500.
 *   • Negative `?offset=-5` → PostgREST `.range(-5, …)` → 500 "Requested
 *     range not satisfiable".
 *
 * The platform already had the correct pattern (see POST /api/partners and
 * POST /api/products): explicit required-field checks returning
 * `400 {error: "Missing required field(s): x, y."}` + numeric type guards
 * BEFORE the DB write. That pattern was hand-rolled per route, which is why
 * it only landed on ~6 routes. These helpers centralise it so every route
 * uses the SAME wording, the SAME response shape, and the SAME coercion
 * semantics — no per-route drift.
 *
 * RESPONSE CONTRACT
 * ──────────────────
 * All helpers return either `null` (body is valid — continue) or a ready-to
 * -return `NextResponse` with status 400 and the platform error shape
 * `{error: "…"}`. Usage mirrors the existing `requirePermission()` gate
 * idiom already used in every route:
 *
 *   const bad = requireFields(body, ["name", "type"]);
 *   if (bad) return bad;
 *
 * COERCION SEMANTICS (assertNumeric)
 * ───────────────────────────────────
 * JSON numbers arrive as numbers, but form-driven clients occasionally send
 * numeric strings ("42"). The helper FIRST attempts coercion via
 * `Number(value)` and writes the coerced number back onto the body; only
 * when the value cannot be coerced to a finite number ("cheap", {}, null
 * for a required field, …) does it reject with
 * `400 {error: "Field 'unit_price' must be a number."}`. This converts
 * today's 500s into either a clean 400 (garbage) or a successful write
 * (coercible) — never a DB-level type error.
 */

import { NextResponse } from "next/server";

/**
 * Missing / empty required-field check → 400.
 *
 * A field counts as "missing" when it is undefined, null, or a string that
 * trims to "" — the exact semantics of the hand-rolled checks in
 * partners/route.ts and products/route.ts (FIX-ALL-2 / Fix 7), so the error
 * wording stays identical for routes that already used that pattern.
 *
 * Callers should skip the check on upsert-by-id (update) requests where the
 * existing row already satisfies the NOT NULL constraints — mirror the
 * `if (!body.id) { … }` guard used by products/offers/invoices/proformas.
 *
 * @param body    parsed JSON body (mutated only on success-path — never here)
 * @param fields  column names that must be present and non-empty
 * @returns NextResponse(400) listing ALL missing fields, or null if valid.
 */
export function requireFields(
  body: Record<string, unknown>,
  fields: string[],
): NextResponse | null {
  const missing: string[] = [];
  for (const field of fields) {
    const v = body[field];
    if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
      missing.push(field);
    }
  }
  if (missing.length === 0) return null;
  return NextResponse.json(
    { error: `Missing required field(s): ${missing.join(", ")}.` },
    { status: 400 },
  );
}

/**
 * Numeric field coercion + validation → 400 on non-numeric junk.
 *
 * Audit finding 30a-07: string-where-number payloads (unit_price "cheap",
 * commission_rate "ten", total_amount "four hundred", version "one" …)
 * reached PostgREST and came back as 500 "Invalid input format." (Postgres
 * 22P02). This guard runs BEFORE the upsert so the caller gets a clean 400
 * naming the offending field, and — when the value is a coercible numeric
 * string ("42") — the coerced number is written back so the DB receives a
 * proper JSON number.
 *
 * `null`/`undefined` values are left untouched (the column is optional or
 * has a DB default); only PRESENT-but-non-numeric values are rejected.
 *
 * @param body    parsed JSON body — successfully coerced values are written
 *                back in place (so the store layer never sees the string)
 * @param fields  column names that must be numbers when present
 * @returns NextResponse(400) on the first non-numeric field, or null.
 */
export function assertNumeric(
  body: Record<string, unknown>,
  fields: string[],
): NextResponse | null {
  for (const field of fields) {
    const v = body[field];
    if (v === undefined || v === null) continue; // optional / defaulted column
    // Empty string: leave untouched. The store's sanitizePayload() converts
    // "" → NULL before the upsert (letting the DB default / NULL apply), and
    // optional-numeric form fields routinely submit "" — rejecting here would
    // break those legitimate flows.
    if (typeof v === "string" && v.trim() === "") continue;
    if (typeof v === "number") {
      if (Number.isNaN(v) || !Number.isFinite(v)) {
        return NextResponse.json(
          { error: `Field '${field}' must be a number.` },
          { status: 400 },
        );
      }
      continue; // already a clean number
    }
    // Attempt coercion (numeric strings from form-driven clients).
    const coerced = Number(v);
    if (typeof v !== "string" || Number.isNaN(coerced) || !Number.isFinite(coerced)) {
      return NextResponse.json(
        { error: `Field '${field}' must be a number.` },
        { status: 400 },
      );
    }
    body[field] = coerced;
  }
  return null;
}

/**
 * Clamp list-route `?limit=` / `?offset=` query params into a safe range.
 *
 * Audit finding 30a-03: `GET /api/partners?offset=-5` → PostgREST
 * `.range(-5, …)` → 500 "Requested range not satisfiable". The products and
 * document-register routes already clamp offset via `Math.max(…, 0)`;
 * partners did not. Negative / zero / NaN values are clamped here so the
 * PostgREST range request is always well-formed.
 *
 * Semantics:
 *   • `limit`  — clamped to [minLimit(1), maxLimit] when a value was
 *     supplied; garbage ("abc") → undefined (store default applies, 50).
 *   • `offset` — clamped to >= 0; garbage → 0 (first page).
 *
 * The central equivalent lives in `paginateQuery()` (supabase-store.ts) —
 * this route-level helper is used by routes that parse the params
 * themselves (so the value they forward is already clean) and by tests.
 *
 * @param rawLimit   parsed `Number(limitParam)` or undefined
 * @param rawOffset  parsed `Number(offsetParam)` or undefined
 * @param maxLimit   upper bound for limit (routes use 500 — the platform
 *                   list ceiling; see F-9-3 in partners/route.ts)
 */
export function clampPagination(
  rawLimit: number | undefined,
  rawOffset: number | undefined,
  maxLimit = 500,
): { limit: number | undefined; offset: number | undefined } {
  let limit: number | undefined;
  if (rawLimit !== undefined && Number.isFinite(rawLimit)) {
    limit = Math.min(Math.max(Math.floor(rawLimit), 1), maxLimit);
  }
  let offset: number | undefined;
  if (rawOffset !== undefined && Number.isFinite(rawOffset)) {
    offset = Math.max(Math.floor(rawOffset), 0);
  }
  return { limit, offset };
}

/**
 * Boolean field coercion + validation → 400 on non-boolean junk.
 *
 * Companion to `assertNumeric()` for the same bug class (audit 30a-07:
 * `product-catalog {active: "yes-please"}` → 500). Accepts real booleans
 * and the common string spellings ("true"/"false"/"1"/"0"); anything else
 * is rejected with a 400 naming the field.
 *
 * @param body    parsed JSON body — coerced values are written back in place
 * @param fields  column names that must be booleans when present
 * @returns NextResponse(400) on the first non-coercible field, or null.
 */
export function assertBoolean(
  body: Record<string, unknown>,
  fields: string[],
): NextResponse | null {
  for (const field of fields) {
    const v = body[field];
    if (v === undefined || v === null) continue; // optional / defaulted column
    if (typeof v === "boolean") continue;
    if (v === "true" || v === 1) { body[field] = true; continue; }
    if (v === "false" || v === 0) { body[field] = false; continue; }
    return NextResponse.json(
      { error: `Field '${field}' must be a boolean.` },
      { status: 400 },
    );
  }
  return null;
}
