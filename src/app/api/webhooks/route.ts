import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId } from "@/lib/api/helpers";
// FIX-AUDIT4-SEC / Fix 10 — SSRF validation for the webhook target URL.
// The previous implementation accepted any URL string and stored it
// verbatim — a `webhooks:create` caller could register a webhook pointing
// at http://169.254.169.254/... (cloud metadata endpoint) or any
// RFC-1918 / loopback address, and the delivery worker would happily
// POST the tenant's event payload to it, leaking the instance's
// service-account token / internal service state. The new helper
// resolves the hostname via dns.lookup and rejects non-routable /
// loopback / link-local / cloud-metadata addresses.
import { assertSafeWebhookUrl } from "@/lib/webhooks/url-validation";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (webhooks.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "webhooks.read"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_webhooks)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_webhooks", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  // FIX-FUNC-2: resolve tenant via resolveTenantId so super-admins acting
  // under ?tenant_id=xxx (or impersonation) are scoped correctly. The
  // previous `if (!auth.tenantId)` check returned 400 "Tenant context
  // required" for super-admins without an impersonation context because
  // super-admin's own tenantId is null at the platform level.
  const tid = resolveTenantId(auth, req);
  if (!tid) return NextResponse.json({ error: "Tenant context required." }, { status: 400 });
  const items = await auth.store.listWebhooks(tid);
  // AUDIT2-LOGIC-UX H3 — redact the webhook secret in the GET response.
  // listWebhooks returns full rows including the secret column; a
  // `webhooks:read` caller can list webhooks but should NOT see the
  // shared-secret value (anyone who lists them could then forge
  // webhook deliveries). The secret is shown ONCE in the POST response
  // at creation time; here we strip it from every row.
  const safeItems = items.map((row) => {
    const { secret, ...rest } = row as unknown as { secret?: string } & Record<string, unknown>;
    return rest;
  });
  return NextResponse.json({ items: safeItems });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (webhooks.create)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "webhooks.create"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_webhooks)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_webhooks", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  // FIX-AUDIT4-SEC / Fix 10 — SSRF validation BEFORE the upsert. The
  // helper resolves the hostname and rejects non-routable / loopback /
  // link-local / cloud-metadata addresses. This is the create-time gate;
  // the delivery worker should re-resolve at delivery time to close the
  // DNS-rebinding gap between this check and the actual outbound POST.
  if (body.url != null) {
    const urlCheck = await assertSafeWebhookUrl(String(body.url));
    if (!urlCheck.ok) {
      return NextResponse.json({ error: urlCheck.error }, { status: 400 });
    }
  }
  // FIX-FUNC-2: resolve tenant via resolveTenantId so super-admins acting
  // under ?tenant_id=xxx (or impersonation) are scoped correctly. See
  // the matching note in GET above.
  const tid = resolveTenantId(auth, req);
  if (!tid) return NextResponse.json({ error: "Tenant context required." }, { status: 400 });
  body.tenant_id = tid;
  // Auto-generate webhook secret if not provided (DB column is NOT NULL).
  if (!body.secret) {
    body.secret = crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  }
  const created = await auth.store.upsertWebhook(body);
  await audit(auth.store, auth.user, req, body.id ? "webhook.update" : "webhook.create", "webhook", created.id, { name: created.name });
  return NextResponse.json(created);
}
