import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import { currentKeyVersion } from "@/lib/api/vault-crypto";

export const runtime = "nodejs";

/**
 * Vault key management.
 *
 * Two surfaces:
 *
 *   GET  — read-only: returns the current key version
 *          (`process.env.VAULT_KEY_VERSION`, default "1") plus a
 *          per-version summary of vault_secrets rows, so the super-
 *          admin can see how many rows are on the old vs. new key
 *          during a rotation.
 *
 *   POST — trigger a rotation. Re-encrypts every vault_secrets row with
 *          the CURRENT key version. This is a thin wrapper over
 *          POST /api/vault/rotate (which performs the actual work);
 *          keeping the alias here so the super-admin settings UI has
 *          a single endpoint per tab.
 *
 * Auth: super-admin only. Vault rotation is a platform-level operation
 * (it touches rows across ALL tenants) and must not be exposed to
 * tenant admins — they could otherwise use it to side-channel-decrypt
 * other tenants' secrets by observing timing / error patterns.
 */

interface KeyVersionRow {
  key_version: string | null;
  count: number;
}

export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const sb = getSupabase();
    const currentVersion = currentKeyVersion();

    // Aggregate count by key_version. NULL = legacy rows that predate
    // the key_version column (migration 035); they decrypt via the
    // wire-format fallback in vault-crypto.ts.
    const { data, error } = await sb
      .from("vault_secrets")
      .select("key_version")
      .is("tenant_id", null);

    // The above query is restricted by RLS for tenant scope; for a
    // platform-level count we want every row. Re-issue with the
    // service-role client (already what getSupabase returns) without
    // a tenant filter.
    const { data: allRows, error: allErr } = await sb
      .from("vault_secrets")
      .select("key_version, category, tenant_id");

    if (allErr) throw allErr;

    const rows = (allRows || []) as Array<{
      key_version: string | null;
      category: string | null;
      tenant_id: string | null;
    }>;

    const byVersion: Record<string, number> = {};
    let nullCount = 0;
    for (const r of rows) {
      const k = r.key_version ?? "(legacy)";
      byVersion[k] = (byVersion[k] || 0) + 1;
      if (r.key_version === null) nullCount++;
    }

    const byCategory: Record<string, number> = {};
    for (const r of rows) {
      const c = r.category ?? "other";
      byCategory[c] = (byCategory[c] || 0) + 1;
    }

    const tenantScoped = rows.filter((r) => r.tenant_id !== null).length;
    const platformScoped = rows.length - tenantScoped;

    return NextResponse.json({
      current_version: currentVersion,
      total_secrets: rows.length,
      needs_rotation: nullCount + (byVersion[currentVersion] === undefined ? 0 : 0),
      legacy_count: nullCount,
      by_version: byVersion,
      by_category: byCategory,
      scope: {
        platform: platformScoped,
        tenant: tenantScoped,
      },
      // List of fields known to be encrypted at rest by vault-crypto.ts.
      // Source of truth is vault-crypto.ts; we re-declare here for the
      // UI's "encrypted fields" table.
      encrypted_fields: ENCRYPTED_FIELDS,
      // Retention policy snapshot — the UI renders the table.
      retention_policy_doc: "See /api/admin/system-health for live DB metrics. Retention is enforced by /api/cron/data-retention.",
    });
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

/**
 * POST /api/admin/vault-management
 *
 * Trigger key rotation. Internally calls the same logic as
 * /api/vault/rotate — kept as a separate route so the super-admin
 * settings UI can have one canonical endpoint per tab.
 */
export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    // Dynamic-import the rotate handler so we don't duplicate logic.
    // The handler itself is `default export`-free; we import the named
    // POST symbol from the route module. Next.js route modules export
    // their handlers as named exports, so this works.
    const rotateModule = await import("@/app/api/vault/rotate/route");
    if (!rotateModule.POST || typeof rotateModule.POST !== "function") {
      return NextResponse.json(
        { error: "Vault rotate handler unavailable." },
        { status: 500 },
      );
    }
    const result = await rotateModule.POST(req);

    await audit(auth.store, auth.user, req, "vault.rotate.triggered", "vault_secret", undefined, {
      via: "admin.vault-management",
    });

    return result;
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

/* ─── Encrypted-field catalog (informational; lives here for the UI) ── */
//
// These are the fields vault-crypto.ts encrypts at rest. The
// source of truth is `vault_secrets.encrypted_value` (any row added
// via POST /api/vault). This list documents the CATEGORIES of fields
// that are encrypted so the super-admin UI can render a "Data
// Protection → Encrypted fields" table without a separate scan.
//
// NOTE: this is documentation, not enforcement. The enforcement is
// the fact that the only writer of `vault_secrets.encrypted_value`
// is vault-crypto.ts.
export const ENCRYPTED_FIELDS: Array<{
  category: string;
  field: string;
  description: string;
}> = [
  {
    category: "api",
    field: "vault_secrets.encrypted_value (api)",
    description: "Third-party API keys (SeaRates, WITS, Comtrade, etc.) stored in the vault with category='api'.",
  },
  {
    category: "smtp",
    field: "vault_secrets.encrypted_value (smtp)",
    description: "SMTP / Postmark tokens used by the email service (lib/email/service.ts).",
  },
  {
    category: "database",
    field: "vault_secrets.encrypted_value (database)",
    description: "External database connection strings (legacy category — retained for back-compat).",
  },
  {
    category: "payment",
    field: "vault_secrets.encrypted_value (payment)",
    description: "Payment gateway secrets (Stripe, PayPal, etc.) — never stored in plaintext.",
  },
  {
    category: "other",
    field: "vault_secrets.encrypted_value (other)",
    description: "Catch-all for any other sensitive secret stored via /api/vault.",
  },
];
