import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

/**
 * Platform configuration — feature flags per tenant + module
 * activation per tenant + tenant management (suspend/cancel/activate)
 * + plan/subscription management.
 *
 * The actual tenant management (CRUD) lives at /api/tenants and
 * /api/tenants/[id]. This route is a READ-ONLY aggregator that
 * returns the data the Platform Configuration tab needs in one round
 * trip:
 *
 *   • tenants — every tenant + its feature_flags row, plan, status,
 *               and counts (user_count, partner_count, etc.) for the
 *               management table.
 *   • plans   — every plan definition from the `plans` table (if
 *               it exists in the live DB; otherwise an empty list).
 *   • feature_flag_keys — the static list of TenantFeatureFlags
 *               boolean fields, so the UI can render a per-tenant
 *               matrix without hardcoding the keys.
 *
 * Mutations (suspend / cancel / activate / change plan / toggle
 * module) are POSTed to /api/tenants/[id] directly from the UI —
 * those routes already exist and do the heavy lifting (atomic status
 * transition, audit logging, session kill cascade on suspend).
 *
 * Auth: super_admin only.
 */

export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const sb = getSupabase();

    // Tenants + their feature flags.
    const { data: tenants, error: tErr } = await sb
      .from("tenants")
      .select("*")
      .order("created_at", { ascending: true });
    if (tErr) throw tErr;

    // Read from the REAL `feature_flags` table (matches feature-guard.ts
    // and supabase-store). The phantom `tenant_feature_flags` table never
    // existed in any migration — every read/write against it silently
    // failed (GET swallowed the error, POST returned 500).
    const { data: flags, error: fErr } = await sb.from("feature_flags").select("*");
    if (fErr) throw fErr;

    const flagByTenant: Record<string, any> = {};
    for (const f of (flags ?? []) as any[]) {
      flagByTenant[f.tenant_id] = f;
    }

    // Per-tenant counts — capped at 1000 per table for the matrix.
    const countTables = ["users", "partners", "deals", "offers", "invoices"];
    const countsByTenant: Record<string, Record<string, number>> = {};
    for (const t of (tenants ?? []) as any[]) {
      countsByTenant[t.id] = {};
      for (const table of countTables) {
        const { count } = await sb
          .from(table)
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", t.id);
        countsByTenant[t.id][table] = count ?? 0;
      }
    }

    // Plans — best-effort; the table may not exist in this env.
    let plans: any[] = [];
    try {
      const { data: planRows } = await sb
        .from("plans")
        .select("*")
        .order("price_monthly", { ascending: true });
      plans = planRows ?? [];
    } catch {
      // Plans table not present in this env — the UI degrades to a
      // static list of plan names ("trial" | "starter" | "business"
      // | "enterprise" | "custom") from the Tenant type.
      plans = [];
    }

    return NextResponse.json({
      tenants: (tenants ?? []).map((t: any) => ({
        ...t,
        flags: flagByTenant[t.id] ?? null,
        counts: countsByTenant[t.id] ?? {},
      })),
      plans,
      feature_flag_keys: FEATURE_FLAG_KEYS,
      plan_options: ["trial", "starter", "business", "enterprise", "custom"],
      status_options: ["active", "suspended", "cancelled"],
    });
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

/**
 * Toggles a single feature flag for a tenant. Body:
 *   { tenant_id, flag, value }
 *
 * Forwards the write to /api/feature-flags which is the canonical
 * writer. Kept here so the super-admin settings UI has a single
 * mutation endpoint per tab.
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

  if (!body?.tenant_id || !body?.flag) {
    return NextResponse.json({ error: "tenant_id and flag are required." }, { status: 400 });
  }

  try {
    // Fetch current flags from the REAL `feature_flags` table.
    const sb = getSupabase();
    const { data: existing, error: loadErr } = await sb
      .from("feature_flags")
      .select("*")
      .eq("tenant_id", body.tenant_id)
      .maybeSingle();
    if (loadErr) throw loadErr;

    const current = existing ?? blankFlags(body.tenant_id);
    // Only boolean flag keys are mutable.
    if (!(body.flag in current) || typeof current[body.flag] !== "boolean") {
      return NextResponse.json(
        { error: `'${body.flag}' is not a boolean feature flag.` },
        { status: 400 },
      );
    }
    current[body.flag] = !!body.value;
    current.updated_at = new Date().toISOString();
    current.updated_by = auth.user.id;

    const { error } = await sb
      .from("feature_flags")
      .upsert(current, { onConflict: "tenant_id" });

    if (error) return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });

    // Invalidate the in-memory feature-guard cache so the new flag is
    // seen on the next request (otherwise it lags up to TTL_MS = 30s).
    const { invalidateFeatureCache } = await import("@/lib/api/feature-guard");
    invalidateFeatureCache(body.tenant_id);

    await audit(auth.store, auth.user, req, "feature_flag.toggle", "feature_flags", body.tenant_id, {
      flag: body.flag,
      value: body.value,
    });

    return NextResponse.json({ ok: true, flag: body.flag, value: body.value });
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

function blankFlags(tenant_id: string) {
  return {
    tenant_id,
    module_crm: true,
    module_trade: true,
    module_finance: true,
    module_inventory: true,
    module_portal: true,
    module_logistics: true,
    module_kyc: true,
    module_document_templates: true,
    module_document_verification: true,
    module_vault: true,
    module_api_keys: true,
    module_webhooks: true,
    module_mail_queue: true,
    module_security: true,
    max_partners: 0,
    max_users: 0,
    max_monthly_documents: 0,
    beta_ai_assistant: false,
    beta_advanced_analytics: false,
    updated_by: null,
    updated_at: new Date().toISOString(),
  };
}

// Static list of boolean feature-flag keys (mirrors
// lib/supabase/types.ts → TenantFeatureFlags). Used by the UI matrix.
export const FEATURE_FLAG_KEYS: Array<{ key: string; label: string; group: string }> = [
  { key: "module_crm", label: "CRM", group: "Modules" },
  { key: "module_trade", label: "Trade", group: "Modules" },
  { key: "module_finance", label: "Finance", group: "Modules" },
  { key: "module_inventory", label: "Inventory", group: "Modules" },
  { key: "module_portal", label: "Client Portal", group: "Modules" },
  { key: "module_logistics", label: "Logistics", group: "Modules" },
  { key: "module_kyc", label: "KYC", group: "Modules" },
  { key: "module_document_templates", label: "Doc Templates", group: "Modules" },
  { key: "module_document_verification", label: "Doc Verification", group: "Modules" },
  { key: "module_vault", label: "Vault", group: "Modules" },
  { key: "module_api_keys", label: "API Keys", group: "Modules" },
  { key: "module_webhooks", label: "Webhooks", group: "Modules" },
  { key: "module_mail_queue", label: "Mail Queue", group: "Modules" },
  { key: "module_security", label: "Security Center", group: "Modules" },
  { key: "beta_ai_assistant", label: "AI Assistant", group: "Beta features" },
  { key: "beta_advanced_analytics", label: "Advanced Analytics", group: "Beta features" },
];
