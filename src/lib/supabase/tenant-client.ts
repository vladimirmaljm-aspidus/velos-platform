import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { mintSupabaseJwt } from "./jwt";

/**
 * RLS-aware Supabase client factory.
 *
 * Returns a client authenticated with the user's Supabase JWT (containing
 * `tenant_id` in app_metadata). PostgREST evaluates RLS policies for this
 * request — so a route that forgets its `.eq('tenant_id', ...)` filter is
 * still protected by the database.
 *
 * Use for TENANT-SCOPED reads/writes. For platform operations (creating
 * tenants, listing all users cross-tenant, etc.) use `getSupabase()` — the
 * service_role client that bypasses RLS.
 */
export async function getTenantSupabase(opts: {
  userId: string;
  tenantId: string | null;
  appRole: string;
  permissions?: string[] | null;
}): Promise<SupabaseClient> {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY are required for RLS-aware queries.");
  }

  const jwt = await mintSupabaseJwt({
    userId: opts.userId,
    tenantId: opts.tenantId,
    appRole: opts.appRole,
    permissions: opts.permissions ?? null,
    ttlSeconds: 60 * 5, // short-lived per-request token
  });

  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}
