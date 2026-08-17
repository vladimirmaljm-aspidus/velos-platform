import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError, getIp } from "@/lib/api/helpers";
// P0-2 (Monitoring) — fire `cross.tenant.attempt` for IDOR probes against
// the vault. Super-admin bypasses the tenant-ownership check (the guard
// `!auth.isSuperAdmin` is false for super-admin), so the report NEVER
// fires for super-admin callers — only for non-super-admin callers
// probing another tenant's vault secret ID (the IDOR recon pattern).
import { reportSecurityEvent } from "@/lib/monitoring/security-alerts";

export const runtime = "nodejs";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (vault.delete)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "vault.delete"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_vault)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_vault", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  const { id } = await params;
  // Use a direct fetch by ID — works for both regular users (tenant-scoped
  // at the policy level) and super_admin (no scope). (Audit finding H-9.)
  const { data: existing, error } = await (auth.store as any)
    .sb()
    .from("vault_secrets")
    .select("id, tenant_id, key")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
  // Tenant ownership check for non-super-admins.
  if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
    // P0-2 (Monitoring) — IDOR probe against a cross-tenant vault secret.
    // The 404 returned here is the SAME shape as the "doesn't exist" 404
    // above (defense-in-depth: no tenant-existence leak). The security
    // event carries the resolved-attempt details for Sentry / the IDS /
    // webhook fan-out — the anomaly-detector.ts `cross-tenant-probe`
    // rule escalates when 3+ of these accumulate from the same IP in 5
    // min (the IDOR-recon pattern). Never fires for super-admin callers.
    reportSecurityEvent({
      type: "cross.tenant.attempt",
      userId: auth.user.id,
      tenantId: auth.tenantId ?? undefined,
      ip: getIp(req),
      details: {
        resource: "vault_secret",
        resource_id: id,
        owner_tenant_id: existing.tenant_id,
      },
      severity: "critical",
    });
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  await auth.store.deleteVaultSecret(id);
  await audit(auth.store, auth.user, req, "vault.delete", "vault_secret", id);
  return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("[vault DELETE id]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
