import { SignJWT } from "jose";

/**
 * Mint a Supabase-compatible JWT for the given user + tenant. This JWT is
 * consumed by PostgREST / Supabase Auth and evaluated by RLS policies via
 * `auth.jwt()`. The `app_metadata.tenant_id` claim is read by our
 * `get_current_tenant_id()` SQL function to scope every query.
 *
 * When paired with the ANON key (see `getTenantSupabase`) this activates RLS —
 * unlike the service_role key which bypasses all policies.
 *
 * The JWT secret is base64-encoded in Supabase's `SUPABASE_JWT_SECRET` env var.
 */

function getSupabaseJwtSecret(): Uint8Array {
  const raw = process.env.SUPABASE_JWT_SECRET;
  if (!raw) {
    throw new Error(
      "SUPABASE_JWT_SECRET is not set. Get it from Supabase Dashboard → Settings → API → JWT Settings → JWT Secret."
    );
  }
  // Supabase stores the JWT secret base64-encoded; jose wants raw bytes.
  // Some projects use the plain-string form too — try base64 first, fall back to utf8.
  try {
    return Uint8Array.from(Buffer.from(raw, "base64"));
  } catch {
    return new TextEncoder().encode(raw);
  }
}

export interface MintOptions {
  userId: string;
  tenantId: string | null;
  role?: "authenticated" | "anon";
  appRole: string;              // our app-level role (admin/user/super_admin)
  permissions?: string[] | null;
  ttlSeconds?: number;
}

/**
 * Sign a JWT that Supabase will accept for RLS-aware queries.
 *
 * The claims follow Supabase's convention:
 *   - `sub`  → user_id
 *   - `role` → PostgreSQL role ("authenticated" for logged-in users, "anon" for public)
 *   - `aud`  → "authenticated"
 *   - `iss`  → "supabase"
 *   - `app_metadata.tenant_id` → tenant scope
 *   - `app_metadata.role`      → application role (admin/user/super_admin)
 *   - `app_metadata.permissions` → granular permission grants
 */
export async function mintSupabaseJwt(opts: MintOptions): Promise<string> {
  const secret = getSupabaseJwtSecret();
  const ttl = opts.ttlSeconds ?? 60 * 60; // default 1h
  const payload = {
    sub: opts.userId,
    role: opts.role ?? "authenticated",
    aud: "authenticated",
    app_metadata: {
      tenant_id: opts.tenantId,
      role: opts.appRole,
      permissions: opts.permissions ?? [],
    },
    user_metadata: {},
  };

  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("supabase")
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(secret);
}
