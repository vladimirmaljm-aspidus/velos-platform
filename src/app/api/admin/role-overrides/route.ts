import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import { invalidateRoleOverridesCache } from "@/lib/permissions/tenant-roles";

export const runtime = "nodejs";

/**
 * Per-tenant role overrides.
 *
 * A "role override" is a custom set of permissions attached to a
 * (tenant_id, role) pair. The platform ships default permissions per
 * role (`role === "admin"` → tenant-scoped grant via `can()`, `user` →
 * explicit grants in `users.permissions`). A tenant on a stricter
 * compliance regime (e.g. finance, healthcare) may want to ADD or
 * SUBTRACT permissions for a specific role without per-user edits —
 * that's what this table is for.
 *
 * Storage: `settings.key = "role_overrides"`, value is a JSON array of
 * RoleOverride rows. Tenant-scoped (per-tenant rows). For platform-level
 * overrides (applies to ALL tenants), use `tenant_id = NULL`.
 */

export interface RoleOverride {
  id: string;
  tenant_id: string | null; // null = platform-wide override
  role: string; // "admin" | "user" | "manager" | custom
  /** "grant" adds the permissions; "deny" removes them (deny wins). */
  mode: "grant" | "deny";
  permissions: string[];
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * GET /api/admin/role-overrides
 *
 * Returns ALL role overrides across ALL tenants (platform-level +
 * tenant-scoped). Super-admin only — exposing this to tenant admins
 * would leak other tenants' security postures.
 *
 * Optional `?tenant_id=xxx` filters to one tenant (plus the platform
 * rows).
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const sb = getSupabase();
    const { data } = await sb
      .from("settings")
      .select("value, tenant_id, updated_at")
      .eq("key", "role_overrides")
      .maybeSingle();

    const overrides: RoleOverride[] = Array.isArray(data?.value)
      ? (data!.value as RoleOverride[])
      : [];

    const url = new URL(req.url);
    const tenantFilter = url.searchParams.get("tenant_id");
    const filtered = tenantFilter
      ? overrides.filter(
          (o) => o.tenant_id === tenantFilter || o.tenant_id === null,
        )
      : overrides;

    return NextResponse.json({ overrides: filtered });
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

/**
 * POST /api/admin/role-overrides
 *
 * Create a new role override. Body: { role, mode, permissions, notes,
 * tenant_id? }. Generates `id` + timestamps server-side.
 *
 * 9b-N5 — TOCTOU race. The previous implementation did a non-atomic
 * read-modify-write on the `settings.value` JSON column: SELECT →
 * mutate-in-memory → UPDATE. Two concurrent POST requests would both
 * SELECT the same `value` array, both push their new override, both
 * UPDATE — and the second UPDATE would silently overwrite the first
 * (losing one of the two overrides with NO error to the caller).
 *
 * FIX: optimistic concurrency control (OCC) with `updated_at` as the
 * version clock. The SELECT now reads `updated_at`, and the UPDATE
 * includes `.eq("updated_at", <fetched>)` — PostgREST translates this
 * to `WHERE id = $1 AND updated_at = $2`, so if a concurrent write
 * bumped `updated_at` between our SELECT and our UPDATE, the UPDATE
 * affects 0 rows and we retry (re-read, re-mutate, re-UPDATE).
 *
 * The INSERT path (when the `role_overrides` settings row doesn't exist
 * yet) has the analogous race: two concurrent first-POSTs would both
 * see no row and both try to INSERT, with one winning and the other
 * getting `error.code === "23505"` (unique_violation on `key`). We
 * catch 23505 and retry — the next iteration sees the winner's row and
 * takes the UPDATE branch.
 *
 * MAX_RETRIES = 3 with 10ms × attempt backoff. After 3 failures →
 * 409 Conflict (the caller is asked to retry; this is the textbook OCC
 * "lost update" recovery signal). Audit + cache invalidation fire ONLY
 * on a successful write — no false-positive audit entries for failed
 * attempts (which would pollute the audit trail and confuse a forensic
 * reviewer).
 */
export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (!body?.role || typeof body.role !== "string") {
    return NextResponse.json({ error: "role is required." }, { status: 400 });
  }
  if (body.mode !== "grant" && body.mode !== "deny") {
    return NextResponse.json({ error: "mode must be 'grant' or 'deny'." }, { status: 400 });
  }
  if (!Array.isArray(body.permissions)) {
    return NextResponse.json({ error: "permissions must be an array." }, { status: 400 });
  }

  // 9b-N5 — optimistic-concurrency retry loop.
  const MAX_RETRIES = 3;
  const newOverride: RoleOverride = {
    id: crypto.randomUUID(),
    tenant_id: body.tenant_id ?? null,
    role: body.role,
    mode: body.mode,
    permissions: body.permissions,
    notes: body.notes ?? null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  let lastErr: any = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1) {
      // 10ms × attempt backoff (10ms on attempt 2, 20ms on attempt 3).
      // Short on purpose: the conflict window is microseconds; we just
      // need to let the concurrent transaction commit so our re-SELECT
      // sees the new `updated_at`.
      await new Promise((r) => setTimeout(r, 10 * attempt));
    }

    try {
      const sb = getSupabase();
      // SELECT includes `updated_at` — the OCC version clock.
      const { data, error: selErr } = await sb
        .from("settings")
        .select("id, value, tenant_id, updated_at")
        .eq("key", "role_overrides")
        .maybeSingle();
      if (selErr) {
        lastErr = selErr;
        continue; // transient DB error → retry
      }

      const list: RoleOverride[] = Array.isArray(data?.value)
        ? (data!.value as RoleOverride[])
        : [];
      // Mutate a fresh copy — never mutate the SELECT'd array in place
      // (avoids stale-reference bugs if the retry re-reads the same row).
      const nextList = [...list, newOverride];
      const nowIso = new Date().toISOString();

      if (data?.id) {
        // UPDATE with OCC: WHERE id = $1 AND updated_at = $2.
        // PostgREST translates chained `.eq()` to AND'd predicates.
        // 0 rows affected (concurrent write bumped updated_at) → retry.
        const { data: updated, error: updErr } = await sb
          .from("settings")
          .update({ value: nextList, updated_at: nowIso })
          .eq("id", data.id)
          .eq("updated_at", data.updated_at)
          .select("id");
        if (updErr) {
          // 23505 (unique_violation) shouldn't fire on UPDATE — but
          // defend anyway. Other errors are hard fails.
          if ((updErr as any).code === "23505") {
            lastErr = updErr;
            continue;
          }
          return NextResponse.json({ error: sanitizeError(updErr) }, { status: 500 });
        }
        // supabase-js `PostgrestTransformBuilder.select()` does NOT
        // accept a count option (only `columns?: Query`). Use the
        // returned array length to detect 0-rows-affected.
        if (!updated || updated.length === 0) {
          // Concurrent write won — retry (re-read will see the new
          // updated_at and we'll re-mutate from the new base).
          lastErr = { message: "concurrent write — retry" };
          continue;
        }
        // ── SUCCESS — fire audit + cache invalidation ONLY here. ──
        await audit(auth.store, auth.user, req, "settings.role_override.create", "settings", "role_overrides", {
          role: newOverride.role,
          mode: newOverride.mode,
          tenant_id: newOverride.tenant_id,
          permission_count: newOverride.permissions.length,
        });
        // FIX-V1: drop the in-process cache so the next request that calls
        // `can()` for this (tenant_id, role) pair sees the new override
        // (within milliseconds — not up to the 5-min TTL).
        invalidateRoleOverridesCache(newOverride.tenant_id, newOverride.role);
        return NextResponse.json({ override: newOverride }, { status: 201 });
      } else {
        // INSERT path — no existing row. Two concurrent first-POSTs
        // race: one wins (INSERT succeeds), the other gets 23505
        // (unique_violation on `key`) → retry → next iteration sees the
        // winner's row and takes the UPDATE branch.
        const { error: insErr } = await sb
          .from("settings")
          .insert({
            key: "role_overrides",
            value: nextList,
            tenant_id: null,
            updated_at: nowIso,
          });
        if (insErr) {
          if ((insErr as any).code === "23505") {
            // Concurrent INSERT won — retry (next iteration will
            // SELECT the winner's row and UPDATE instead).
            lastErr = insErr;
            continue;
          }
          return NextResponse.json({ error: sanitizeError(insErr) }, { status: 500 });
        }
        // ── SUCCESS — fire audit + cache invalidation ONLY here. ──
        await audit(auth.store, auth.user, req, "settings.role_override.create", "settings", "role_overrides", {
          role: newOverride.role,
          mode: newOverride.mode,
          tenant_id: newOverride.tenant_id,
          permission_count: newOverride.permissions.length,
        });
        invalidateRoleOverridesCache(newOverride.tenant_id, newOverride.role);
        return NextResponse.json({ override: newOverride }, { status: 201 });
      }
    } catch (e: any) {
      // Unexpected error inside this iteration — record + retry. If
      // we exhaust MAX_RETRIES with this kind of error, surface it.
      lastErr = e;
      continue;
    }
  }

  // 9b-N5 — exhausted retries → 409 Conflict (OCC lost-update signal).
  return NextResponse.json(
    { error: "Concurrent modification — please retry.", detail: sanitizeError(lastErr) },
    { status: 409 },
  );
}

/**
 * DELETE /api/admin/role-overrides?id=xxx
 *
 * Removes a single override by id.
 *
 * 9b-N5 — same TOCTOU race as POST. Two concurrent DELETE requests for
 * different override ids would both SELECT the same `value` array,
 * both filter out their target, both UPDATE — the second UPDATE would
 * overwrite the first, restoring the first's target override (silent
 * data loss). A concurrent POST + DELETE could similarly lose the POST.
 *
 * FIX: same OCC pattern as POST — SELECT includes `updated_at`, UPDATE
 * adds `.eq("updated_at", <fetched>)`, 0 rows affected → retry. After
 * MAX_RETRIES → 409 Conflict. Audit + cache invalidation only on
 * successful write.
 */
export async function DELETE(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  // 9b-N5 — optimistic-concurrency retry loop.
  const MAX_RETRIES = 3;
  let lastErr: any = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1) {
      // 10ms × attempt backoff (mirrors POST).
      await new Promise((r) => setTimeout(r, 10 * attempt));
    }

    try {
      const sb = getSupabase();
      // SELECT includes `updated_at` — the OCC version clock.
      const { data, error: selErr } = await sb
        .from("settings")
        .select("id, value, updated_at")
        .eq("key", "role_overrides")
        .maybeSingle();
      if (selErr) {
        lastErr = selErr;
        continue; // transient DB error → retry
      }

      const list: RoleOverride[] = Array.isArray(data?.value)
        ? (data!.value as RoleOverride[])
        : [];
      const next = list.filter((o) => o.id !== id);
      if (next.length === list.length) {
        // Override not found in this iteration's snapshot. This is a
        // STABLE verdict — a concurrent write could only have ADDED or
        // MUTATED overrides; it couldn't have added back an override
        // we just confirmed was missing. Return 404 directly (no
        // retry — there's nothing to win).
        return NextResponse.json({ error: "Override not found." }, { status: 404 });
      }

      // Snapshot the override being deleted so we can drop the matching
      // cache entry below (FIX-V1 — avoids up to 5-min staleness).
      const deleted = list.find((o) => o.id === id);

      if (data?.id) {
        // UPDATE with OCC: WHERE id = $1 AND updated_at = $2.
        // 0 rows affected (concurrent write bumped updated_at) → retry.
        const nowIso = new Date().toISOString();
        const { data: updated, error: updErr } = await sb
          .from("settings")
          .update({ value: next, updated_at: nowIso })
          .eq("id", data.id)
          .eq("updated_at", data.updated_at)
          .select("id");
        if (updErr) {
          if ((updErr as any).code === "23505") {
            lastErr = updErr;
            continue;
          }
          return NextResponse.json({ error: sanitizeError(updErr) }, { status: 500 });
        }
        // supabase-js PostgrestTransformBuilder.select() does NOT
        // accept a count option — use the returned array length to
        // detect 0-rows-affected.
        if (!updated || updated.length === 0) {
          // Concurrent write won — retry (re-read sees the new
          // updated_at + new value array; we re-filter from the new base).
          lastErr = { message: "concurrent write — retry" };
          continue;
        }
        // ── SUCCESS — fire audit + cache invalidation ONLY here. ──
        await audit(auth.store, auth.user, req, "settings.role_override.delete", "settings", "role_overrides", {
          override_id: id,
        });
        // FIX-V1: drop the cache entry for the deleted override's
        // (tenant_id, role) pair so the next `can()` for that pair sees
        // the updated diff. If we couldn't determine the pair (data was
        // missing), drop the whole cache — safer to over-invalidate
        // than leave stale grants.
        if (deleted) {
          invalidateRoleOverridesCache(deleted.tenant_id, deleted.role);
        } else {
          invalidateRoleOverridesCache();
        }
        return NextResponse.json({ deleted: id });
      } else {
        // No settings row exists at all. Same stable verdict as "not
        // found in list" — return 404 directly, no retry.
        return NextResponse.json({ error: "Override not found." }, { status: 404 });
      }
    } catch (e: any) {
      lastErr = e;
      continue;
    }
  }

  // 9b-N5 — exhausted retries → 409 Conflict (OCC lost-update signal).
  return NextResponse.json(
    { error: "Concurrent modification — please retry.", detail: sanitizeError(lastErr) },
    { status: 409 },
  );
}
