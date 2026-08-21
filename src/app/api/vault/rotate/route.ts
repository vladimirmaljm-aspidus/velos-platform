import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, audit } from "@/lib/api/helpers";
import { rotateAllVaultSecrets, currentKeyVersion } from "@/lib/api/vault-crypto";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

/**
 * POST /api/vault/rotate  (super-admin only)
 *
 * Re-encrypt every vault_secrets row with the CURRENT key version
 * (`process.env.VAULT_KEY_VERSION`, default "1"). Used during a key
 * rotation: deploy code that knows about both the old and new keys,
 * then call this endpoint to migrate every row to the new key.
 *
 * Audit P2-3 / task C-7 — see `src/lib/api/vault-crypto.ts` for the full
 * rotation procedure and `supabase/migrations/035_vault_key_versioning.sql`
 * for the `key_version` column this endpoint populates.
 *
 * Returns a summary: { target_version, total, rotated, skipped, errors }.
 * The caller can poll `SELECT count(*) FROM vault_secrets WHERE
 * key_version IS DISTINCT FROM '<target>'` to verify completion.
 *
 * Auth: super-admin only. Vault rotation is a platform-level operation
 * (it touches rows across ALL tenants) and must not be exposed to tenant
 * admins — they could otherwise use it to side-channel-decrypt other
 * tenants' secrets by observing timing / error patterns.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireSuperAdmin(req);
    if (auth instanceof NextResponse) return auth;

    const sb = getSupabase();

    // List ALL vault_secrets rows across ALL tenants. The service_role key
    // bypasses RLS, so this sees platform-level (tenant_id IS NULL) rows
    // too — those are the SMTP/Postmark tokens that motivated the rotation
    // feature in the first place.
    const { data: rows, error: listErr } = await sb
      .from("vault_secrets")
      .select("id, encrypted_value")
      .order("created_at", { ascending: true });
    if (listErr) throw listErr;

    const result = await rotateAllVaultSecrets(
      async () => (rows as Array<{ id: string; encrypted_value: string }>) || [],
      async (id, encrypted_value, key_version) => {
        const { error: updErr } = await sb
          .from("vault_secrets")
          .update({ encrypted_value, key_version })
          .eq("id", id);
        if (updErr) throw updErr;
      },
    );

    // Audit the rotation (don't log individual row ids — too noisy). The
    // summary is enough for ops to verify the rotation completed.
    try {
      await audit(
        auth.store,
        auth.user,
        req,
        "vault.rotate",
        "vault_secret",
        undefined,
        {
          target_version: currentKeyVersion(),
          total: result.total,
          rotated: result.rotated,
          skipped: result.skipped,
          error_count: result.errors.length,
        },
      );
    } catch (e) {
      console.error("[vault rotate audit]", e);
    }

    return NextResponse.json({
      target_version: currentKeyVersion(),
      ...result,
    });
  } catch (e: any) {
    console.error("[vault rotate]", e);
    return NextResponse.json(
      { error: e?.message || "Internal server error" },
      { status: 500 },
    );
  }
}
