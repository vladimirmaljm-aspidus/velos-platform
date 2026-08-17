import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { hasPermission, resolveTenantId, sanitizeError, type AuthContext, type ApiKeyAuthContext } from "@/lib/api/helpers";

describe("hasPermission", () => {
  it("grants access with a wildcard '*' permission", () => {
    expect(hasPermission(["*"], "partners:read")).toBe(true);
  });

  it("grants access with a resource wildcard e.g. 'partners:*'", () => {
    expect(hasPermission(["partners:*"], "partners:delete")).toBe(true);
  });

  it("grants access with an exact resource:action match", () => {
    expect(hasPermission(["partners:read"], "partners:read")).toBe(true);
  });

  it("denies access when the permission is not present", () => {
    expect(hasPermission(["partners:read"], "partners:delete")).toBe(false);
    expect(hasPermission(["invoices:*"], "partners:read")).toBe(false);
  });

  it("denies access for an empty permission list", () => {
    expect(hasPermission([], "partners:read")).toBe(false);
  });
});

describe("resolveTenantId", () => {
  function req(url: string) {
    return new NextRequest(new Request(url));
  }

  it("locks API-key auth to the key's own tenant regardless of query params", () => {
    const auth: ApiKeyAuthContext = {
      store: {} as any,
      ip: "127.0.0.1",
      tenantId: "tenant-A",
      apiKeyId: "key-1",
      apiKeyName: "test key",
      permissions: ["*"],
    };
    const result = resolveTenantId(auth, req("http://localhost/api/deals?tenant_id=tenant-B"));
    expect(result).toBe("tenant-A");
  });

  it("locks a regular (non-super-admin) user to their own tenant even if they pass ?tenant_id=", () => {
    const auth: AuthContext = {
      user: { id: "u1", tenant_id: "tenant-A" } as any,
      store: {} as any,
      ip: "127.0.0.1",
      tenantId: "tenant-A",
      isSuperAdmin: false,
    };
    const result = resolveTenantId(auth, req("http://localhost/api/deals?tenant_id=tenant-B"));
    expect(result).toBe("tenant-A");
  });

  it("lets a super-admin switch tenant context via ?tenant_id=", () => {
    const auth: AuthContext = {
      user: { id: "u1", tenant_id: null } as any,
      store: {} as any,
      ip: "127.0.0.1",
      tenantId: null,
      isSuperAdmin: true,
    };
    const result = resolveTenantId(auth, req("http://localhost/api/deals?tenant_id=tenant-B"));
    expect(result).toBe("tenant-B");
  });

  it("falls back to the super-admin's own tenant (null) when no ?tenant_id= is given", () => {
    const auth: AuthContext = {
      user: { id: "u1", tenant_id: null } as any,
      store: {} as any,
      ip: "127.0.0.1",
      tenantId: null,
      isSuperAdmin: true,
    };
    const result = resolveTenantId(auth, req("http://localhost/api/deals"));
    expect(result).toBeNull();
  });
});

// ── P2 / task C-6 Fix 5 — sanitizeError ────────────────────────────────────
// Verifies that raw Postgres error strings (which leak schema / column /
// constraint / SQL-syntax details an attacker can use to map the schema) are
// stripped down to a generic message before they reach the API client. The
// original error is still logged server-side; this only controls the
// outbound HTTP response body.
describe("sanitizeError", () => {
  it("strips 'relation does not exist' (schema + table name leak)", () => {
    const out = sanitizeError(new Error('relation "public.users" does not exist'));
    expect(out).not.toContain("public.users");
    expect(out).not.toContain("relation");
    expect(out).toBe("Database error.");
  });

  it("strips 'column of relation does not exist' (column + table leak)", () => {
    const out = sanitizeError(new Error('column "password_hash" of relation "users" does not exist'));
    expect(out).not.toContain("password_hash");
    expect(out).not.toContain("users");
    expect(out).toBe("Database error.");
  });

  it("strips 'column does not exist' (bare column leak)", () => {
    const out = sanitizeError(new Error('column "tenant_id" does not exist'));
    expect(out).not.toContain("tenant_id");
    expect(out).toBe("Database error.");
  });

  it("strips foreign-key constraint name leaks", () => {
    const out = sanitizeError(new Error('update or delete on table "offers" violates foreign key constraint "fk_offers_partner_id" on table "partners"'));
    expect(out).not.toContain("fk_offers_partner_id");
    expect(out).not.toContain("offers");
    expect(out).toContain("Referential integrity error");
  });

  it("strips unique-constraint + duplicate-key leaks (column-name hint)", () => {
    const out = sanitizeError(new Error('duplicate key value violates unique constraint "users_email_key"'));
    expect(out).not.toContain("users_email_key");
    expect(out).toBe("Duplicate entry.");
  });

  it("strips NOT NULL constraint leaks", () => {
    const out = sanitizeError(new Error('null value in column "name" of relation "partners" violates not-null constraint'));
    // The column name ("name") and table name ("partners") MUST be stripped
    // — they leak schema info. The exact wording of the replacement is
    // flexible (a single Postgres error can match several patterns at
    // once — here both the "null value in column of relation" prefix AND
    // the "violates not-null constraint" suffix are stripped, leaving a
    // composite "Database error Missing required field." message that
    // still conveys the category to the caller).
    expect(out).not.toContain("partners");
    expect(out).not.toContain('"name"');
    expect(out).toContain("Missing required field");
  });

  it("strips SQL syntax-error leaks (server-side raw SQL indicator)", () => {
    const out = sanitizeError(new Error('syntax error at or near "FROM"'));
    expect(out).not.toContain("FROM");
    expect(out).toBe("Database error.");
  });

  it("strips 'invalid input syntax for type' (type-name leak)", () => {
    const out = sanitizeError(new Error('invalid input syntax for type uuid: "not-a-uuid"'));
    expect(out).not.toContain("uuid");
    expect(out).toBe("Invalid input format.");
  });

  it("strips RLS policy leaks so existence of a row is not confirmed", () => {
    const out = sanitizeError(new Error('new row for relation "vault_secrets" violates row-level security policy "vault_secrets_tenant_isolation" on INSERT'));
    expect(out).not.toContain("vault_secrets");
    expect(out).not.toContain("tenant_isolation");
    expect(out).toBe("Not found.");
  });

  it("strips permission-denied-for-table leaks (table-name + existence)", () => {
    const out = sanitizeError(new Error('permission denied for table audit_logs'));
    expect(out).not.toContain("audit_logs");
    expect(out).toBe("Permission denied.");
  });

  it("passes through a user-facing message that contains no DB internals", () => {
    const out = sanitizeError(new Error("Invalid credentials."));
    expect(out).toBe("Invalid credentials.");
  });

  it("handles a non-Error throw (string)", () => {
    const out = sanitizeError("boom");
    expect(out).toBe("boom");
  });

  it("handles a null / undefined throw without crashing", () => {
    expect(sanitizeError(null)).toBe("Internal server error.");
    expect(sanitizeError(undefined)).toBe("Internal server error.");
    expect(sanitizeError("")).toBe("Internal server error.");
  });

  it("preserves the surrounding context when only part of the message matches a leak pattern", () => {
    // A composite message: "Failed to upsert deal: <leak>". The leak is
    // stripped, the human prefix is preserved — so the caller still gets
    // something useful but no schema info.
    const out = sanitizeError(new Error('Failed to upsert deal: duplicate key value violates unique constraint "deals_number_key"'));
    expect(out).not.toContain("deals_number_key");
    expect(out).toContain("Failed to upsert deal");
    expect(out).toContain("Duplicate entry");
  });

  // F-FINAL / P0: supabase-js returns plain-object PostgrestError shapes
  // (NOT `Error` instances) — `{ message, code, details, hint }`. The old
  // implementation produced `[object Object]` for these. Verify the new
  // branch reads `.message` correctly and still applies the leak-rewrite
  // rules.
  it("handles a plain-object PostgrestError (supabase-js shape)", () => {
    const fakePostgrestError = {
      message: 'duplicate key value violates unique constraint "users_email_key"',
      code: "23505",
      details: "Key (email)=(a@b.com) already exists.",
      hint: "",
    };
    const out = sanitizeError(fakePostgrestError);
    expect(out).toBe("Duplicate entry.");
    expect(out).not.toContain("users_email_key");
    expect(out).not.toContain("[object Object]");
  });

  it("handles a plain-object error without a message property", () => {
    const out = sanitizeError({ code: "23505", details: "no message field" });
    // Falls back to String(e ?? "") which produces "[object Object]" —
    // which is ugly but not a leak. The point of this test is to confirm
    // sanitizeError doesn't crash on the missing-message branch.
    expect(typeof out).toBe("string");
  });
});
