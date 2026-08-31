import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId, getIp, sanitizeError } from "@/lib/api/helpers";
import { encrypt, decrypt, currentKeyVersion } from "@/lib/api/vault-crypto";
// P0-2 (Monitoring) — fire `vault.read` when a caller explicitly requests the
// decrypted secret value (reveal=true). This is the high-sensitivity
// surface — anyone revealing vault values is security-relevant. NOTE: super
// admin can reveal values too (they manage the platform); the event fires
// for them as well, but the route never denies them — "super-admin is never
// blocked" is preserved by the audit-time check, not by suppressing the
// report.
import { reportSecurityEvent } from "@/lib/monitoring/security-alerts";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (vault.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "vault.read"); if (_d) return _d; } /* requirePermission wired */
    // Feature gate (module_vault)
    { const { requireFeature } = await import("@/lib/api/feature-guard");
      const _f = await requireFeature(auth.tenantId, "module_vault", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    const tid = resolveTenantId(auth, req);
    if (!tid) {
      return NextResponse.json({ error: "No tenant context." }, { status: 400 });
    }
    const url = new URL(req.url);
    const search = url.searchParams.get("search") || undefined;
    const category = url.searchParams.get("category") || undefined;
    // `?reveal=true` opts IN to returning the decrypted secret value. By
    // default we strip the value from list responses (defense in depth) — the
    // secret is only revealed when the caller explicitly asks for it. Even
    // when revealed, the value is decrypted in-flight; the DB only stores the
    // AES-256-GCM ciphertext.
    const reveal = url.searchParams.get("reveal") === "true";
    const result = await auth.store.listVault(tid, { search, filters: { category } });
    // Defense-in-depth: even though SupabaseStore filters by tenant_id,
    // this post-filter provides an extra safety layer. Do NOT remove.
    if (!auth.isSuperAdmin && auth.tenantId) {
      result.items = result.items.filter((s) => s.tenant_id === auth.tenantId);
      result.total = result.items.length;
    }
    const items = result.items.map((s) => {
      if (reveal) {
        // Decrypt the stored ciphertext before returning.
        return { ...s, encrypted_value: decrypt(s.encrypted_value) };
      }
      // Default: strip encrypted_value from list response (only reveal on
      // explicit reveal request).
      const { encrypted_value, ...rest } = s;
      return rest;
    });
    // Audit: log the count of vault secrets returned (not each one). (Audit
    // finding D P1 #5 — vault reads were silent.)
    try {
      await audit(auth.store, auth.user, req, "vault.read", "vault_secret", undefined, {
        count: items.length,
        reveal,
      });
    } catch (e) {
      console.error("[vault GET audit]", e);
    }
    // P0-2 (Monitoring) — fire `vault.read` ONLY when the caller explicitly
    // requested the decrypted value (reveal=true). The non-reveal list
    // response strips the secret value, so it's not security-relevant
    // beyond the existing audit entry. Super-admin can also reveal; the
    // event reports the access for the audit trail without blocking.
    if (reveal && items.length > 0) {
      reportSecurityEvent({
        type: "vault.read",
        userId: auth.user.id,
        tenantId: auth.tenantId ?? undefined,
        ip: getIp(req),
        details: { count: items.length, reveal: true },
        severity: "info",
      });
    }
    return NextResponse.json({ items, total: result.total });
  } catch (e: any) {
    console.error("[vault GET]", e);
    return NextResponse.json(
      { error: sanitizeError(e)},
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (vault.create)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "vault.create"); if (_d) return _d; } /* requirePermission wired */
    // Feature gate (module_vault)
    { const { requireFeature } = await import("@/lib/api/feature-guard");
      const _f = await requireFeature(auth.tenantId, "module_vault", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    // FIX-FUNC-1: resolve tenant via resolveTenantId so super-admins acting
    // under ?tenant_id=xxx (or impersonation) are scoped correctly. The
    // previous `auth.tenantId ?? undefined` produced a 400 "tenant_id is
    // required" for super-admins without an impersonation context because
    // super-admin's own tenantId is null at the platform level.
    const tid = resolveTenantId(auth, req);
    if (!tid) {
      return NextResponse.json({ error: "tenant_id is required." }, { status: 400 });
    }
    body.tenant_id = tid;

    // 8d-6: whitelist the fields a caller can write to a vault_secret row.
    // Without this, a malicious caller could mass-assign arbitrary columns
    // (e.g. `last_used_by`, `created_at`, `id` to overwrite another row in
    // their tenant via IDOR — the store layer scopes by tenant_id so the
    // IDOR would be intra-tenant, but still lets a malicious admin
    // overwrite the `key` label of another vault row, breaking future
    // lookups). Mirror the `whitelistUserFields()` pattern in users/route.ts.
    const ALLOWED_VAULT_FIELDS = new Set([
      "key",
      "category",
      "metadata",
      "encrypted_value",
      "value", // accepted as plaintext input, encrypted below
      "key_version", // server-set below; allowed here so the override goes through
      "expires_at",
      // `id` is allowed ONLY on the UPDATE path (caller passes the row id to
      // update). On INSERT, smartUpsert generates a fresh uuid.
      "id",
    ]);
    const cleanBody: Record<string, unknown> = {};
    for (const k of Object.keys(body)) {
      if (ALLOWED_VAULT_FIELDS.has(k)) cleanBody[k] = body[k];
    }
    // Re-hydrate body with the whitelisted fields only.
    body = cleanBody;
    body.tenant_id = tid;

    // Encrypt the secret value before it hits the store. Accept either
    // `encrypted_value` (legacy field name) or `value` (newer name) from the
    // caller — both are treated as plaintext here and encrypted with
    // AES-256-GCM. The store only ever sees the ciphertext. Legacy rows that
    // were saved as plaintext are still readable because `decrypt()` falls
    // back to returning the raw value when the format doesn't match.
    const plaintextValue =
      body.encrypted_value != null && body.encrypted_value !== ""
        ? String(body.encrypted_value)
        : body.value != null && body.value !== ""
        ? String(body.value)
        : "";
    body.encrypted_value = encrypt(plaintextValue);
    // Audit P2-3 / task C-7: record the key version used for this encryption
    // on the row. The wire format (`encrypted_value`) ALSO carries the version
    // prefix, so this column is technically redundant — but having it as a
    // real column lets ops query "how many rows still use v1?" with a single
    // SELECT instead of parsing the encrypted blob.
    body.key_version = currentKeyVersion();
    // `value` is not a real column — drop it so smartUpsert doesn't send it.
    delete body.value;

    const created = await auth.store.upsertVaultSecret(body);
    await audit(auth.store, auth.user, req, body.id ? "vault.update" : "vault.create", "vault_secret", created.id, { key: created.key });
    // Never echo the ciphertext back to the client.
    const { encrypted_value, ...safe } = created;
    return NextResponse.json(safe);
  } catch (e: any) {
    console.error("[vault POST]", e);
    return NextResponse.json(
      { error: sanitizeError(e)},
      { status: 500 },
    );
  }
}
