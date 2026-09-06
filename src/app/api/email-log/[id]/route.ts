import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId, sanitizeError } from "@/lib/api/helpers";
import { getEmailLogRow } from "@/lib/email/email-log";

export const runtime = "nodejs";

/**
 * GET /api/email-log/[id]
 *
 * TASK 41 — full audit row for one send attempt, INCLUDING the exact
 * body_html / body_text that was handed to the provider (the list endpoint
 * omits the bodies for payload size). This is the record the owner asked
 * for: "audit i istorija poslatih mejlova i tacnog teksta koji je poslat".
 *
 * Read-only: no update, no delete, no re-send — re-sending is a deliberate
 * action from the document's own send button (LOI/offer/proforma/invoice),
 * protected by the duplicate guard.
 *
 * Scoping: tenant-scoped for regular admins; super_admin may fetch any row
 * (cross-tenant observability) — mirroring the list endpoint.
 *
 * Auth: mail-queue.read permission + module_mail_queue feature flag.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    {
      const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "mail-queue.read");
      if (_d) return _d;
    }
    {
      const { requireFeature } = await import("@/lib/api/feature-guard");
      const _f = await requireFeature(auth.tenantId, "module_mail_queue", auth.isSuperAdmin);
      if (_f) return _f;
    }

    const { id } = await params;
    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "Missing id." }, { status: 400 });
    }

    // Tenant scoping: super admins may read any row; tenant admins only
    // their own tenant's rows (getEmailLogRow scopes by tenant_id when
    // given one and returns null for rows of other tenants).
    const tid = resolveTenantId(auth, req);
    const scope = auth.isSuperAdmin ? (tid ?? null) : tid;
    const row = await getEmailLogRow(id, scope);
    if (!row) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    try {
      await audit(auth.store, auth.user, req, "email_log.read_detail", "email_log", id, {
        to: row.to_email,
        status: row.status,
      });
    } catch (e) {
      console.error("[email-log detail audit]", e);
    }

    return NextResponse.json({ item: row });
  } catch (e: any) {
    console.error("[email-log detail GET]", e);
    return NextResponse.json(
      { error: sanitizeError(e) || "Internal server error" },
      { status: 500 },
    );
  }
}
