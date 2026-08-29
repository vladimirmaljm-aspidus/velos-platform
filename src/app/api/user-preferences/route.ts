import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";
import { checkRateLimit } from "@/lib/security/rate-limiter";

export const runtime = "nodejs";

// ADMIN-M7: validation constants for the preference key + value.
//  - KEY_REJECT restricts keys to a safe, low-cardinality alphabet
//    (lowercase letters, digits, dots, dashes, underscores, colons) — this
//    prevents stored-XSS via the key name surfacing in any admin UI that
//    lists preferences, and prevents path-traversal shenanigans if a key
//    ever gets used as part of a file path.
//  - MAX_VALUE_BYTES caps the JSON-serialised value at 64 KB so a
//    malicious or buggy client can't bloat the preferences table with
//    megabyte-sized blobs (the column is jsonb, but unbounded writes
//    still hurt the table's TOAST + cache behaviour).
const KEY_REJECT = /^[a-z0-9_:.-]{1,128}$/;
const MAX_VALUE_BYTES = 64 * 1024;

// GET /api/user-preferences — list all preferences for the current user
export async function GET() {
  try {
    const auth = await requireAuth();
    if (auth instanceof NextResponse) return auth;
    const prefs = await auth.store.listUserPreferences(auth.user.id);
    // Return as key-value map for easy consumption
    const map: Record<string, unknown> = {};
    for (const p of prefs) {
      try {
        map[p.preference_key] = JSON.parse(p.preference_value);
      } catch {
        map[p.preference_key] = p.preference_value;
      }
    }
    return NextResponse.json({ items: prefs, map });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}

// PUT /api/user-preferences — set a single preference
// Body: { key: string, value: unknown }
export async function PUT(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;

    // ADMIN-M7: per-user rate limit. The previous PUT had no limit, so a
    // single client could write the preferences table thousands of times
    // per minute (the locale-change handler fires on every keystroke if
    // the UI ever wires an immediate PUT). 60 writes / 60s / user is more
    // than enough for any legitimate preference churn (locale, theme,
    // layout, etc.) and stops a runaway client from turning the table
    // into a write-amplification target. Super-admin is NOT bypassed —
    // this is a per-user resource, not a privileged operation.
    const rl = await checkRateLimit(`user-prefs:${auth.user.id}`, 60, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many preference updates. Please slow down." },
        {
          status: 429,
          headers: rl.retryAfter ? { "Retry-After": String(Math.ceil(rl.retryAfter / 1000)) } : {},
        },
      );
    }

    const body = await req.json();
    const { key, value } = body;

    // ADMIN-M7: validate the key against a strict alphabet. Without
    // this a caller could submit a key with HTML special chars that
    // later gets rendered in an admin UI without escaping, or a key
    // that's 100 KB long (the column is `text`, no length cap).
    if (!key || typeof key !== "string" || !KEY_REJECT.test(key)) {
      return NextResponse.json(
        { error: "Invalid preference key. Allowed: lowercase letters, digits, '.', '-', '_', ':' (max 128 chars)." },
        { status: 400 },
      );
    }

    // ADMIN-M7: cap the serialised value at 64 KB. The column is jsonb
    // so unbounded writes don't blow up the row physically, but a 1 MB
    // JSON blob per user still degrades the table's TOAST + cache hit
    // rate for everyone. 64 KB is generous for any structured preference
    // (locale, theme, dashboard layout, saved filters) and small enough
    // that abuse is contained.
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return NextResponse.json(
        { error: "Preference value is not JSON-serialisable." },
        { status: 400 },
      );
    }
    if (serialized.length > MAX_VALUE_BYTES) {
      return NextResponse.json(
        { error: "Preference value too large (max 64 KB)." },
        { status: 413 },
      );
    }

    const pref = await auth.store.setUserPreference(auth.user.id, key, value);
    try {
      await audit(auth.store, auth.user, req, "user_preference.update", "user_preference", undefined, { keys: Object.keys(body) });
    } catch (e) { console.error("[audit]", e); }
    return NextResponse.json({ ok: true, preference: pref });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
