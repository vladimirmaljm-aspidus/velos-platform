import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError, getIp, resolveTenantId } from "@/lib/api/helpers";
import { decrypt } from "@/lib/api/vault-crypto";
// P0-2 (Monitoring) — fire `cross.tenant.attempt` for IDOR probes against
// the vault. Super-admin bypasses the tenant-ownership check (the guard
// `!auth.isSuperAdmin` is false for super-admin), so the report NEVER
// fires for super-admin callers — only for non-super-admin callers
// probing another tenant's vault secret ID (the IDOR recon pattern).
import { reportSecurityEvent } from "@/lib/monitoring/security-alerts";

export const runtime = "nodejs";

// GET /api/vault/[id]?reveal=true
//
// Returns a single vault secret. When `reveal=true` is passed, the
// decrypted plaintext value is included in the response under
// `encrypted_value` (kept that name for backwards-compat with the list
// endpoint shape). When `reveal` is omitted / false, the value is
// stripped — same defense-in-depth posture as the list endpoint.
//
// Audit: logs `vault.reveal` (when reveal=true) or `vault.read` (otherwise)
// with the secret id + the caller's user id. The decrypted value itself
// is NEVER persisted in the audit trail — only the id of the revealed
// secret, the action, and the actor.
//
// Tenant ownership: non-super-admin callers can only reveal secrets in
// their own tenant. A cross-tenant probe is reported as
// `cross.tenant.attempt` and returned as 404 (existence leak prevention).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (vault.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "vault.read"); if (_d) return _d; } /* requirePermission wired */
    // Feature gate (module_vault)
    { const { requireFeature } = await import("@/lib/api/feature-guard");
      const _f = await requireFeature(auth.tenantId, "module_vault", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    const { id } = await params;
    // Direct fetch by id — works for both tenant-scoped (RLS) and
    // super_admin (no scope). (Mirrors the DELETE handler's posture.)
    const { data: existing, error } = await (auth.store as any)
      .sb()
      .from("vault_secrets")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });

    // Tenant ownership check for non-super-admins. The 404 shape mirrors
    // the "doesn't exist" 404 above so a probe can't tell the difference.
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
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

    const url = new URL(req.url);
    const reveal = url.searchParams.get("reveal") === "true";
    const tid = resolveTenantId(auth, req);

    // Build the safe response. Always strip the ciphertext from the wire
    // shape — when reveal=true we replace `encrypted_value` with the
    // decrypted plaintext; when reveal=false we omit it entirely.
    const { encrypted_value, ...rest } = existing as any;
    const safe = reveal
      ? { ...rest, encrypted_value: decrypt(encrypted_value) }
      : rest;

    // Audit: `vault.reveal` when the caller explicitly asked for the
    // decrypted value (security-relevant); `vault.read` otherwise.
    try {
      await audit(
        auth.store,
        auth.user,
        req,
        reveal ? "vault.reveal" : "vault.read",
        "vault_secret",
        id,
        { key: existing.key, reveal },
      );
    } catch (e) {
      console.error("[vault GET id audit]", e);
    }

    // P0-2 (Monitoring) — fire `vault.reveal` only when the caller
    // explicitly requested the decrypted value. Mirrors the list
    // endpoint's posture (the non-reveal read is not security-relevant
    // beyond the audit entry). Super-admin can also reveal; the event
    // reports the access without blocking.
    if (reveal) {
      reportSecurityEvent({
        type: "vault.reveal",
        userId: auth.user.id,
        tenantId: tid ?? undefined,
        ip: getIp(req),
        details: { secret_id: id, key: existing.key },
        severity: "info",
      });
    }

    // Bump last_accessed_at so the vault UI can surface "last accessed
    // 3s ago" — best-effort, failures don't block the reveal.
    try {
      await (auth.store as any)
        .sb()
        .from("vault_secrets")
        .update({ last_accessed_at: new Date().toISOString() })
        .eq("id", id);
    } catch (e) {
      console.error("[vault GET id last_accessed_at]", e);
    }

    return NextResponse.json(safe);
  } catch (error: any) {
    console.error("[vault GET id]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

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
