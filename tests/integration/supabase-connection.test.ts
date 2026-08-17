import { describe, it, expect } from "vitest";
import { isSupabaseConfigured, getSupabase } from "@/lib/supabase/client";

/**
 * Verifies the app's actual Supabase client (src/lib/supabase/client.ts) can
 * reach the database using SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from the
 * environment. Skips instead of failing when those aren't set locally, since
 * this repo intentionally keeps real credentials out of source control.
 */
describe("Supabase connectivity", () => {
  const configured = isSupabaseConfigured();

  it.skipIf(!configured)("connects and can query the tenants table", async () => {
    const supabase = getSupabase();
    const { error, status } = await supabase.from("tenants").select("id").limit(1);
    expect(error).toBeNull();
    expect(status).toBeLessThan(300);
  });

  it.skipIf(configured)("is skipped: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in this environment", () => {
    expect(configured).toBe(false);
  });
});
