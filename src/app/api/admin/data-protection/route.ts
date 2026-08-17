import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import { RETENTION_POLICY } from "@/lib/compliance/retention";
import { ENCRYPTED_FIELDS } from "@/app/api/admin/vault-management/route";

export const runtime = "nodejs";

/**
 * Data-protection configuration.
 *
 *   • Vault key management — alias of /api/admin/vault-management;
 *              GET returns the same shape so this tab has a single
 *              canonical endpoint. (POST for rotation lives on
 *              vault-management.)
 *   • Field encryption catalog — exported from vault-management.ts
 *              (single source of truth).
 *   • Data-retention policy — READ-ONLY mirror of
 *              lib/compliance/retention.ts. The policy is enforced
 *              by /api/cron/data-retention; changing it requires a
 *              deploy (we expose it here for visibility + audit).
 *   • GDPR settings — right-to-erasure, data-export, breach
 *              notification toggles stored under
 *              settings.key = "gdpr_config".
 */

export interface GdprConfig {
  // Right-to-erasure: when enabled, deleting a user anonymises
  // their PII in audit_logs (migration 030) and cascades to their
  // dependent rows (migration 029).
  rightToErasure: boolean;
  // Data export: when enabled, users can request a CSV export of
  // their own data via /api/export. Super-admin can disable this
  // for compliance / abuse reasons.
  dataExportEnabled: boolean;
  // Breach notification: when enabled, creating an incident with
  // type="breach" auto-computes the 72-hour deadline and surfaces
  // it in the incident UI.
  breachNotificationTracking: boolean;
  // DPO contact email — shown in the privacy policy + breach
  // notification workflow.
  dpoEmail: string;
  // Data residency: a label shown to clients in the privacy policy
  // ("EU", "US", "EU+US-mirror", etc.).
  dataResidency: string;
}

export const DEFAULT_GDPR_CONFIG: GdprConfig = {
  rightToErasure: true,
  dataExportEnabled: true,
  breachNotificationTracking: true,
  dpoEmail: "dpo@example.com",
  dataResidency: "EU",
};

function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true";
  return fallback;
}

function mergeGdpr(stored: Record<string, unknown> | null): GdprConfig {
  if (!stored) return { ...DEFAULT_GDPR_CONFIG };
  return {
    rightToErasure: asBool(stored.rightToErasure, DEFAULT_GDPR_CONFIG.rightToErasure),
    dataExportEnabled: asBool(stored.dataExportEnabled, DEFAULT_GDPR_CONFIG.dataExportEnabled),
    breachNotificationTracking: asBool(stored.breachNotificationTracking, DEFAULT_GDPR_CONFIG.breachNotificationTracking),
    dpoEmail: typeof stored.dpoEmail === "string" ? stored.dpoEmail : DEFAULT_GDPR_CONFIG.dpoEmail,
    dataResidency: typeof stored.dataResidency === "string" ? stored.dataResidency : DEFAULT_GDPR_CONFIG.dataResidency,
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const sb = getSupabase();

    // Vault management summary — count + current version.
    const { currentKeyVersion } = await import("@/lib/api/vault-crypto");
    const currentVersion = currentKeyVersion();
    const { data: vaultRows } = await sb
      .from("vault_secrets")
      .select("key_version, category, tenant_id");

    const rows = (vaultRows ?? []) as Array<{
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

    // GDPR config
    const { data: gdprRow } = await sb
      .from("settings")
      .select("value")
      .eq("key", "gdpr_config")
      .is("tenant_id", "null")
      .maybeSingle();
    const gdpr = mergeGdpr((gdprRow?.value as Record<string, unknown> | null) ?? null);

    return NextResponse.json({
      vault: {
        current_version: currentVersion,
        total_secrets: rows.length,
        legacy_count: nullCount,
        by_version: byVersion,
        needs_rotation: nullCount > 0,
      },
      encrypted_fields: ENCRYPTED_FIELDS,
      retention_policy: RETENTION_POLICY,
      gdpr,
      defaults: { gdpr: DEFAULT_GDPR_CONFIG },
    });
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (!body?.gdpr || typeof body.gdpr !== "object") {
    return NextResponse.json({ error: "gdpr object is required." }, { status: 400 });
  }

  const gdpr = mergeGdpr(body.gdpr as Record<string, unknown>);

  try {
    const sb = getSupabase();
    const { data: existing } = await sb
      .from("settings")
      .select("id")
      .eq("key", "gdpr_config")
      .is("tenant_id", "null")
      .maybeSingle();

    if (existing) {
      const { error } = await sb
        .from("settings")
        .update({ value: gdpr, updated_at: new Date().toISOString() })
        .eq("id", (existing as any).id);
      if (error) return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
    } else {
      const { error } = await sb
        .from("settings")
        .insert({
          key: "gdpr_config",
          value: gdpr,
          tenant_id: null,
          updated_at: new Date().toISOString(),
        });
      if (error) return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
    }

    await audit(auth.store, auth.user, req, "settings.gdpr.update", "settings", "gdpr_config", {
      right_to_erasure: gdpr.rightToErasure,
      data_export_enabled: gdpr.dataExportEnabled,
      breach_tracking: gdpr.breachNotificationTracking,
    });

    // Invalidate the in-process cache so the next read (DELETE /api/users/[id],
    // GET /api/export, POST /api/admin/incidents/[id]/notify, getDpoContactEmail)
    // picks up the new toggles immediately. See src/lib/compliance/gdpr-config.ts.
    try {
      const { invalidateGdprConfigCache } = await import("@/lib/compliance/gdpr-config");
      invalidateGdprConfigCache();
    } catch {
      // Non-fatal — the cache TTL is 5 minutes so the change still
      // propagates within that window even if the invalidate call fails.
    }

    return NextResponse.json({ gdpr });
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
