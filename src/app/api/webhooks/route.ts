import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId } from "@/lib/api/helpers";
// 31-f — shared required-field validation (audit 30-b BUG-2: a name-less
// POST /api/webhooks returned a 500 with an EMPTY error body because the
// webhooks.name NOT NULL violation was swallowed by sanitizeError; now a
// clean 400 listing the missing fields).
import { requireFields } from "@/lib/api/validate";
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
  // AUDIT17 / P1 — POST with a body.id performs an UPDATE (smartUpsert), so
  // it must ALSO require webhooks.update. Previously a user holding only
  // webhooks.create could rewrite an existing webhook's URL/secret/events —
  // redirecting the tenant's event stream to an attacker URL — because the
  // create gate was the only check. Peek at the body BEFORE parsing errors
  // would matter: we re-check after the parse below.
  let _peek: any = null;
  try { _peek = await req.clone().json(); } catch { _peek = null; }
  if (_peek && typeof _peek === "object" && _peek.id) {
    const { requirePermission } = await import("@/lib/permissions/can");
    const _u = requirePermission(auth, "webhooks.update"); if (_u) return _u;
  }
  // Feature gate (module_webhooks)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_webhooks", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  // 31-f — required-field validation BEFORE the upsert (audit 30-b BUG-2:
  // POST {url, events} without `name` → webhooks.name NOT NULL → 500 with
  // an EMPTY error body — sanitizeError swallowed the actual DB error,
  // leaving the client with a bare 500). name / url / events are all NOT
  // NULL without DB defaults (secret is auto-generated below, active has
  // a default), so a create needs all three from the caller. Skipped on
  // the update path (body.id) — the existing row already satisfies NOT
  // NULL.
  if (!body.id) {
    const bad = requireFields(body, ["name", "url", "events"]);
    if (bad) return bad;
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
