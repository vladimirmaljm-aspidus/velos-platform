import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { hashPassword } from "@/lib/auth/password";
import { validatePasswordWithPlatformPolicy } from "@/lib/auth/password-policy";
import { enforceQuota } from "@/lib/api/plan-limits";

export const runtime = "nodejs";

function whitelistUserFields(body: Record<string, unknown>): Record<string, unknown> {
  // NOTE (audit F-6/P1 password_hash backdoor): `password_hash` is
  // intentionally NOT in this whitelist. Previously a client could send
  // `password_hash: "$2a$10$..."` directly to /api/users and have it
  // persisted verbatim, bypassing the server-side `hashPassword()` step.
  // That let any admin set an arbitrary hash on any account without
  // knowing the plaintext password — full account hijack via the user
  // management API.
  //
  // Passwords now flow exclusively through the dedicated endpoints:
  //   - /api/auth/change-password  (CRM users, self-service)
  //   - /api/portal/change-password (portal clients, self-service)
  //   - /api/users POST/PUT with a plaintext `password` field (hashed
  //     server-side and re-attached to the sanitized body AFTER the
  //     whitelist filter, so a client-supplied hash can never survive).
  const allowed = new Set([
    "tenant_id", "username", "email", "full_name", "role",
    "permissions", "active", "must_change_password",
  ]);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (allowed.has(key)) result[key] = value;
  }
  return result;
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (users.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "users.read"); if (_d) return _d; } /* requirePermission wired */

    // Super-admin with no tenant_id: list users from a specific tenant if requested
    let tid = auth.tenantId;
    if (auth.isSuperAdmin && !tid) {
      const url = new URL(req.url);
      tid = url.searchParams.get("tenant_id") || null;
    }
    if (!tid) {
      return NextResponse.json({ items: [] });
    }
    const users = await auth.store.listUsers(tid);

    // ── Tenant isolation ────────────────────────────────────────────────
    // Regular (non-super) admins must NOT see platform-level users
    // (super_admin accounts) or users from other tenants. Only super_admin
    // can see the full list.
    let visible = users;
    if (!auth.isSuperAdmin) {
      visible = users.filter(
        (u) => u.role !== "super_admin" && u.tenant_id === auth.tenantId
      );
    }

    // strip hashes
    const safe = visible.map(({ password_hash, totp_secret, ...u }) => u);
    return NextResponse.json({ items: safe });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (users.create)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "users.create"); if (_d) return _d; } /* requirePermission wired */

    const body = await req.json();

    // Only a super-admin can grant super-admin (platform-level) access —
    // otherwise any tenant admin could self-promote via this endpoint.
    if (body.role === "super_admin" && !auth.isSuperAdmin) {
      return NextResponse.json({ error: "Only a super-admin can grant super-admin access." }, { status: 403 });
    }

    // Only a super-admin can grant wildcard ("*") permissions — otherwise a
    // tenant admin could escalate themselves or another user to super-admin
    // equivalent by setting permissions: ["*"].
    if (!auth.isSuperAdmin && Array.isArray(body.permissions) && body.permissions.includes("*")) {
      return NextResponse.json({ error: "Only super-admin can grant wildcard permissions." }, { status: 403 });
    }

    // Enforce tenant on new user
    // Super-admin can pick which tenant the user belongs to
    // Regular admin can only create users in their own tenant
    if (auth.isSuperAdmin && body.tenant_id) {
      // super_admin explicitly chose a tenant — keep it
    } else {
      body.tenant_id = auth.tenantId!;
    }

    // Prevent more than 2 admins per tenant
    if (body.role === "admin") {
      const targetTenantId = body.tenant_id as string;
      const existingUsers = await auth.store.listUsers(targetTenantId);
      const adminCount = existingUsers.filter(u => u.role === "admin" && u.active).length;
      if (adminCount >= 2) {
        return NextResponse.json({ error: "Maximum 2 admins allowed per company. Remove an existing admin first." }, { status: 400 });
      }
    }

    // hash password if provided (create or reset). The server-computed
    // hash is re-attached to the sanitized body AFTER the whitelist filter
    // so a client-supplied `password_hash` can never be persisted verbatim
    // (audit F-6/P1 password_hash backdoor).
    let serverHashedPassword: string | null = null;
    if (body.password) {
      // FIX-V1: validate the plaintext password against the platform-wide
      // policy BEFORE hashing. Previously this route skipped validation
      // entirely — an admin could set a 1-char password on any user,
      // bypassing the super-admin's configured minLength / char-class
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
      // Strip BOTH the plaintext password AND any client-supplied hash
      // before the whitelist runs (defense in depth — the whitelist would
      // drop `password_hash` anyway, but explicit deletion makes the
      // intent clear and prevents future regressions if the whitelist
      // is ever widened).
      delete body.password;
      delete body.password_hash;
    }
    // Plan limit — only on CREATE (updates carry a body.id).
    if (!body.id) {
      const denied = await enforceQuota(body.tenant_id, "users", auth.isSuperAdmin);
      if (denied) return denied;
    }
    const sanitizedBody = whitelistUserFields(body);
    if (serverHashedPassword) {
      sanitizedBody.password_hash = serverHashedPassword;
    }
    const created = await auth.store.upsertUser(sanitizedBody);
    await audit(auth.store, auth.user, req, body.id ? "user.update" : "user.create", "user", created.id, { username: created.username });
    const { password_hash, totp_secret, ...safe } = created;
    return NextResponse.json(safe);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
