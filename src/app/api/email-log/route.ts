import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId, sanitizeError } from "@/lib/api/helpers";
import { listEmailLog } from "@/lib/email/email-log";

export const runtime = "nodejs";

/**
 * GET /api/email-log
 *
 * TASK 41 — the outbound email audit: every send attempt (success, failure,
 * unconfirmed, no-provider misconfiguration) with the EXACT text that was
 * handed to the provider. This REPLACES the removed mail-queue surface —
 * there is no POST (rows are written exclusively by the email service),
 * no DELETE (append-only audit) and no RETRY (re-sends are a deliberate
 * action from the document send actions, guarded against duplicates).
 *
 * Scoping mirrors the old mail-queue semantics:
 *   • super_admin with no active tenant → cross-tenant listing (platform
 *     delivery observability)
 *   • otherwise → tenant-scoped (resolveTenantId)
 *
 * Query params: search (to/subject), status (sent|failed|unknown|all),
 * limit (default 50, max 200), offset.
 *
 * Bodies are NOT returned by the list (payload size) —
 * GET /api/email-log/[id] returns the full row with the exact body.
 *
 * Auth: mail-queue.read permission (the historical outbound-email
 * observability permission — reused so no DB permission re-granting is
 * needed for existing roles) + module_mail_queue feature flag.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (mail-queue.read — the outbound-email observability
    // permission; kept for existing role grants).
    {
      const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "mail-queue.read");
      if (_d) return _d;
    }
    // Feature gate (module_mail_queue)
    {
      const { requireFeature } = await import("@/lib/api/feature-guard");
      const _f = await requireFeature(auth.tenantId, "module_mail_queue", auth.isSuperAdmin);
      if (_f) return _f;
    }

    const url = new URL(req.url);
    const search = url.searchParams.get("search") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50) || 50, 1), 200);
    const offset = Math.max(Number(url.searchParams.get("offset") || 0) || 0, 0);

    // Super admin without a tenant context sees ALL tenants' attempts
    // (cross-tenant observability); everyone else is tenant-scoped.
    const tid = resolveTenantId(auth, req);

    const result = await listEmailLog({
      tenantId: tid ?? null,
      search,
      status,
      limit,
      offset,
    });

    if (auth.isSuperAdmin && !tid) {
      try {
        await audit(auth.store, auth.user, req, "email_log.read", "email_log", undefined, {
          cross_tenant: true,
          count: result.items.length,
        });
      } catch (e) {
        console.error("[email-log GET cross-tenant audit]", e);
      }
    }

    return NextResponse.json(result);
  } catch (e: any) {
    console.error("[email-log GET]", e);
    return NextResponse.json(
      { error: sanitizeError(e) || "Internal server error" },
      { status: 500 },
    );
  }
}
