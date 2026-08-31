import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * GET /api/webhooks/[id]/deliveries
 *
 * Returns the most recent delivery attempts for a single webhook. Used by
 * the webhooks UI to show a delivery history (status, response status,
 * attempts, timestamps) per webhook.
 *
 * Auth: requires `webhooks.read` permission (parity with the collection
 * route). Tenant ownership is enforced via the store's `tenant_id` filter —
 * deliveries for other tenants are never returned even if the ID is leaked.
 *
 * Query params:
 *   ?limit=50  — cap on results (max 200, default 50)
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (webhooks.read)
    {
      const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "webhooks.read");
      if (_d) return _d;
    }
    // Feature gate (module_webhooks)
    {
      const { requireFeature } = await import("@/lib/api/feature-guard");
      const _f = await requireFeature(auth.tenantId, "module_webhooks", auth.isSuperAdmin);
      if (_f) return _f;
    }

    // FIX-FUNC-5: resolve tenant via resolveTenantId so super-admins
    // acting under ?tenant_id=xxx can inspect a tenant's webhook
    // deliveries. The previous `if (!auth.tenantId)` returned 400 for
    // super-admins (whose own tenantId is null).
    const tid = resolveTenantId(auth, req);
    if (!tid) {
      return NextResponse.json({ error: "Tenant context required." }, { status: 400 });
    }

    const { id } = await params;

    // Tenant ownership check — fetch the webhook by ID + tenant_id so a
    // caller can't query another tenant's deliveries by guessing the UUID.
    // Super-admins can query any tenant (passing no tenant filter), but the
    // store's listWebhookDeliveries call below is still scoped to the
    // resolved tid so we never leak cross-tenant data accidentally.
    const webhook = await auth.store.getWebhookById(id, tid);
    if (!webhook) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    const url = new URL(req.url);
    const limitParam = url.searchParams.get("limit");
    let limit = 50;
    if (limitParam) {
      const parsed = Number(limitParam);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.min(200, Math.floor(parsed));
      }
    }

    const items = await auth.store.listWebhookDeliveries(tid, id, limit);
    return NextResponse.json({ items });
  } catch (error: any) {
    console.error("[webhooks.deliveries GET]", error);
    return NextResponse.json(
      { error: sanitizeError(error) || "Internal server error" },
      { status: 500 },
    );
  }
}
