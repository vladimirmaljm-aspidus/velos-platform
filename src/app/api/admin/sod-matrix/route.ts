import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import { invalidateSodMatrixCache } from "@/lib/permissions/sod-matrix";

export const runtime = "nodejs";

/**
 * Separation-of-Duties (SoD) matrix.
 *
 * SoD rules prevent a single user from holding two permissions that
 * together would enable a fraud path (classic SOX control). Example:
 *   • `invoices.create` + `invoices.send` → could create AND send a
 *     fraudulent invoice without review.
 *   • `erp.journal_post` + `erp.bank_reconcile` → could book and
 *     reconcile a misappropriation.
 *
 * The rules are evaluated at user-create / user-permission-edit time
 * (see `lib/permissions/can.ts` audit) — when a user's grant set
 * intersects BOTH sides of any rule, the action is blocked and the
 * violation is logged to audit_logs.
 *
 * Storage: `settings.key = "sod_matrix"`, value is a JSON array of
 * SodRule rows. tenant_id = NULL (platform-level — SoD is a
 * platform-wide control, not per-tenant).
 */

export interface SodRule {
  id: string;
  name: string;
  description: string | null;
  /** Permission set A — any one match counts. */
  permissions_a: string[];
  /** Permission set B — any one match counts. */
  permissions_b: string[];
  /**
   * "block" — the grant is rejected at user-permission-edit time.
   * "warn"  — the grant goes through, but the violation is logged
   *          to audit_logs for review.
   */
  severity: "block" | "warn";
  active: boolean;
  created_at: string;
  updated_at: string;
}

export const DEFAULT_SOD_MATRIX: SodRule[] = [
  {
    id: "sod-default-1",
    name: "Invoice create + send",
    description:
      "A single user should not be able to both create and send an invoice without review.",
    permissions_a: ["invoices.create"],
    permissions_b: ["invoices.send"],
    severity: "warn",
    active: true,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  },
  {
    id: "sod-default-2",
    name: "ERP journal post + bank reconcile",
    description:
      "Posting a journal entry and reconciling the bank transaction that matches it is a classic SOX control break.",
    permissions_a: ["erp.post"],
    permissions_b: ["erp.reconcile"],
    severity: "block",
    active: true,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  },
];

/**
 * GET /api/admin/sod-matrix — returns the current matrix.
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const sb = getSupabase();
    const { data } = await sb
      .from("settings")
      .select("value")
      .eq("key", "sod_matrix")
      .is("tenant_id", "null")
      .maybeSingle();

    const rules: SodRule[] = Array.isArray(data?.value)
      ? (data!.value as SodRule[])
      : DEFAULT_SOD_MATRIX;

    return NextResponse.json({ rules, defaults: DEFAULT_SOD_MATRIX });
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

/**
 * PUT /api/admin/sod-matrix — replaces the matrix wholesale.
 * The client is expected to send the complete rules array (the GET
 * shape). Omitted rules are dropped — there is no merge.
 */
export async function PUT(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (!body?.rules || !Array.isArray(body.rules)) {
    return NextResponse.json({ error: "rules array is required." }, { status: 400 });
  }

  // Normalize — ensure id + timestamps; reject malformed rows.
  const now = new Date().toISOString();
  const rules: SodRule[] = body.rules.map((r: any, i: number) => ({
    id: typeof r.id === "string" && r.id ? r.id : `sod-${Date.now()}-${i}`,
    name: String(r.name ?? `Rule ${i + 1}`),
    description: r.description ? String(r.description) : null,
    permissions_a: Array.isArray(r.permissions_a) ? r.permissions_a.map(String) : [],
    permissions_b: Array.isArray(r.permissions_b) ? r.permissions_b.map(String) : [],
    severity: r.severity === "block" || r.severity === "warn" ? r.severity : "warn",
    active: r.active !== false,
    created_at: typeof r.created_at === "string" ? r.created_at : now,
    updated_at: now,
  }));

  try {
    const sb = getSupabase();
    const { data: existing } = await sb
      .from("settings")
      .select("id")
      .eq("key", "sod_matrix")
      .is("tenant_id", "null")
      .maybeSingle();

    if (existing) {
      const { error } = await sb
        .from("settings")
        .update({ value: rules, updated_at: now })
        .eq("id", (existing as any).id);
      if (error) return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
    } else {
      const { error } = await sb
        .from("settings")
        .insert({
          key: "sod_matrix",
          value: rules,
          tenant_id: null,
          updated_at: now,
        });
      if (error) return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
    }

    await audit(auth.store, auth.user, req, "settings.sod_matrix.update", "settings", "sod_matrix", {
      rule_count: rules.length,
      active_count: rules.filter((r) => r.active).length,
    });

    // FIX-V1: drop the in-process SoD matrix cache so the next
    // `assertNoSoDViolation` call picks up the new rules immediately
    // (within milliseconds — not up to the 5-min TTL). Without this,
    // a super-admin would save a new rule and not see it enforced
    // until the next serverless cold-start or 5 min later.
    invalidateSodMatrixCache();

    return NextResponse.json({ rules });
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
