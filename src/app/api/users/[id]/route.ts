import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { hashPassword } from "@/lib/auth/password";
import { validatePasswordWithPlatformPolicy } from "@/lib/auth/password-policy";
import { rotateUserSessions } from "@/lib/auth/session";

export const runtime = "nodejs";

function whitelistUserFields(body: Record<string, unknown>): Record<string, unknown> {
  // NOTE (audit F-6/P1 password_hash backdoor): `password_hash` is
  // intentionally NOT in this whitelist — see /api/users/route.ts for the
  // full rationale. Clients must never set a password hash directly; the
  // server-side `hashPassword()` result is re-attached AFTER the filter.
  // `token_version` IS still allowed here because PUT may bump it on
  // password change (the bump is computed from `existing.token_version`,
  // not from client input — but a malicious bump would only log the user
  // out, which is a harmless nuisance, not a privilege escalation).
  const allowed = new Set([
    "tenant_id", "username", "email", "full_name", "role",
    "permissions", "active", "must_change_password",
    "token_version",
  ]);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (allowed.has(key)) result[key] = value;
  }
  return result;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(_req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (users.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "users.read"); if (_d) return _d; } /* requirePermission wired */

    const { id } = await params;
    const u = await auth.store.getUserById(id);
    if (!u) return NextResponse.json({ error: "Not found." }, { status: 404 });
    // Tenant ownership check: regular users can only see users in their own tenant.
    // Super_admin can see any user. Also hide super_admin accounts from non-super_admins.
    if (!auth.isSuperAdmin) {
      if (u.role === "super_admin" || u.tenant_id !== auth.tenantId) {
        return NextResponse.json({ error: "Not found." }, { status: 404 });
      }
    }
    const { password_hash, totp_secret, ...safe } = u;
    return NextResponse.json(safe);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (users.update)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "users.update"); if (_d) return _d; } /* requirePermission wired */

    const { id } = await params;
    const existing = await auth.store.getUserById(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });

    // Tenant ownership check:
    // - Super_admin can edit any user.
    // - Regular admins can only edit users in their own tenant (and never super_admin accounts).
    // - Regular non-admin users can only edit themselves.
    if (!auth.isSuperAdmin) {
      if (existing.role === "super_admin" || existing.tenant_id !== auth.tenantId) {
        return NextResponse.json({ error: "Not found." }, { status: 404 });
      }
      // Note: requirePermission("users.update") above already gates this —
      // admins pass implicitly, and a non-admin only reaches here with an
      // explicit users.update grant. No further role check needed; the
      // self-edit restriction below still blocks privilege self-escalation.
    }

    const body = await req.json();

    // Only a super-admin can grant super-admin (platform-level) access —
    // otherwise any user could self-promote via PUT on their own record.
    if (body.role === "super_admin" && existing.role !== "super_admin" && !auth.isSuperAdmin) {
      return NextResponse.json({ error: "Only a super-admin can grant super-admin access." }, { status: 403 });
    }

    // Only a super-admin can grant wildcard ("*") permissions — otherwise a
    // tenant admin (or a regular user editing their own record before the
    // self-service stripping below) could escalate to super-admin equivalent.
    if (!auth.isSuperAdmin && Array.isArray(body.permissions) && body.permissions.includes("*")) {
      return NextResponse.json({ error: "Only super-admin can grant wildcard permissions." }, { status: 403 });
    }

    // Prevent more than 2 admins per tenant when promoting to admin
    if (body.role === "admin" && existing.role !== "admin" && existing.tenant_id) {
      const existingUsers = await auth.store.listUsers(existing.tenant_id);
      const adminCount = existingUsers.filter(u => u.role === "admin" && u.active).length;
      if (adminCount >= 2) {
        return NextResponse.json({ error: "Maximum 2 admins allowed per company. Remove an existing admin first." }, { status: 400 });
      }
    }

    // Prevent demoting the last admin
    if (existing.role === "admin" && body.role && body.role !== "admin" && existing.tenant_id) {
      const users = await auth.store.listUsers(existing.tenant_id);
      const adminCount = users.filter(u => u.role === "admin" && u.active && u.id !== existing.id).length;
      if (adminCount < 1) {
        return NextResponse.json({ error: "Cannot demote the last admin. Promote another user first." }, { status: 400 });
      }
    }

    // Hash password server-side if provided. The server-computed hash is
    // re-attached to the sanitized body AFTER the whitelist filter so a
    // client-supplied `password_hash` can never be persisted verbatim
    // (audit F-6/P1 password_hash backdoor).
    let serverHashedPassword: string | null = null;
    if (body.password) {
      // FIX-V1: validate the plaintext password against the platform-wide
      // policy BEFORE hashing. Previously this route skipped validation
      // entirely — an admin could set a 1-char password on any user via
      // PUT, bypassing the super-admin's configured minLength / char-class
      // toggles. Falls back to DEFAULT_POLICY when security_config is
      // missing or the DB is unreachable (fresh deploy).
      const pwValidation = await validatePasswordWithPlatformPolicy(body.password);
      if (!pwValidation.ok) {
        return NextResponse.json(
          { error: pwValidation.errors.join(" ") },
          { status: 400 },
        );
      }
      serverHashedPassword = await hashPassword(body.password);
      delete body.password;
      delete body.password_hash; // defense in depth — strip client-supplied hash
      body.must_change_password = false;
      // Bump token_version so every JWT issued before this password change
      // is rejected on its next request (see requireAuth's token_version
      // check). Without this, old cookies on lost / stolen devices stay
      // valid for up to 7 days after a password reset.
      body.token_version = (existing.token_version || 0) + 1;
    }
    // Preserve the user's tenant_id (regular users/admins cannot move users to another tenant)
    const whitelisted = whitelistUserFields(body);
    delete whitelisted.tenant_id;
    if (serverHashedPassword) {
      whitelisted.password_hash = serverHashedPassword;
    }

    // A non-admin editing their own record must not be able to change their
    // own role, permissions, or active flag — otherwise self-service profile
    // editing doubles as a self-promotion path.
    if (!auth.isSuperAdmin && auth.user.role !== "admin" && auth.user.id === id) {
      delete whitelisted.role;
      delete whitelisted.permissions;
      delete whitelisted.active;
    }
    const updated = await auth.store.upsertUser({ ...whitelisted, id });
    await audit(auth.store, auth.user, req, "user.update", "user", id, { username: updated.username });

    // ── Session rotation on password change ───────────────────────────────
    // If the password (and therefore token_version) was changed, every
    // previously-issued session must be torn down — both the stateless JWT
    // (handled by the token_version bump above) and the DB rows in
    // `sessions` (handled here). Without this, an attacker who stole a
    // cookie before the password reset could keep using the dashboard until
    // the JWT's natural 7-day expiry.
    if (serverHashedPassword) {
      await rotateUserSessions(updated.id, updated.tenant_id);
    }

    const { password_hash, totp_secret, ...safe } = updated;
    return NextResponse.json(safe);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (users.delete) — admins pass implicitly; a non-admin
  // needs an explicit users.delete grant. No further role check needed.
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "users.delete"); if (_d) return _d; } /* requirePermission wired */

    const { id } = await params;
    if (id === auth.user.id) {
      return NextResponse.json({ error: "You cannot delete yourself." }, { status: 400 });
    }
    const existing = await auth.store.getUserById(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });

    // Tenant Ownership check
    if (!auth.isSuperAdmin) {
      if (existing.role === "super_admin" || existing.tenant_id !== auth.tenantId) {
        return NextResponse.json({ error: "Not found." }, { status: 404 });
      }
    }

    // Prevent deleting the last admin
    if (existing.role === "admin" && existing.tenant_id) {
      const users = await auth.store.listUsers(existing.tenant_id);
      const adminCount = users.filter(u => u.role === "admin" && u.active && u.id !== existing.id).length;
      if (adminCount < 1) {
        return NextResponse.json({ error: "Cannot delete the last admin." }, { status: 400 });
      }
    }

    // ── GDPR Article 17 — right to erasure ─────────────────────────────────
    // audit_logs is append-only (migration 010) for tamper-evidence, but it
    // stores PII (username, ip, user_agent) for every action this user ever
    // took. We cannot DELETE those rows (trigger blocks it, and we want to
    // preserve the audit trail), but we MUST strip the PII before the user
    // row goes away — otherwise the PII persists forever and GDPR Article 17
    // is violated.
    //
    // The anonymisation happens BEFORE `deleteUserCascade` because the
    // function matches audit_logs rows by `WHERE user_id = p_user_id`; if we
    // deleted the user first there would be nothing to join on
    // (audit_logs.user_id has no FK to users, so it isn't cascaded).
    //
    // ── P0 / task C-1 — orphan prevention cascade ─────────────────────────
    // The live DB has no FK CASCADE from sessions / user_tasks /
    // entity_notes / user_preferences / login_history / known_ips /
    // trusted_devices / notifications → users.id, so a plain
    // `DELETE FROM users WHERE id=?` orphans every row that references
    // this user. `deleteUserCascade` walks those tables in dependency
    // order and then deletes the user row last. The list is a superset —
    // any table that doesn't exist in a given env is skipped silently
    // (the per-table delete is wrapped in try/catch inside the store).
    //
    // The append-only `audit_logs` table is NOT in that list — it is
    // handled separately by `anonymizeUserAuditLogs` above (migration
    // 030), which strips PII but preserves the audit trail per GDPR
    // Article 17 / financial-audit retention rules.
    let auditRowsAnonymised = 0;
    try {
      auditRowsAnonymised = await auth.store.anonymizeUserAuditLogs(id);
    } catch (e: any) {
      // A failed right-to-erasure is a GDPR violation — surface it as a
      // 500 with a clear message rather than silently continuing with the
      // user deletion and leaving PII behind. Operators must investigate
      // (most likely cause: migration 030 not yet applied to this env).
      return NextResponse.json(
        {
          error:
            "User deletion aborted: failed to anonymise audit_logs PII " +
            "(GDPR Article 17). " + (e?.message ?? String(e)),
        },
        { status: 500 },
      );
    }

    await auth.store.deleteUserCascade(id);
    await audit(auth.store, auth.user, req, "user.delete", "user", id, {
      gdpr_audit_logs_anonymised: auditRowsAnonymised,
    });
    return NextResponse.json({ ok: true, auditRowsAnonymised });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
