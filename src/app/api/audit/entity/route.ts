import { NextRequest, NextResponse } from "next/server";
import { requireAuth, sanitizeError } from "@/lib/api/helpers";
import { redactDetails, TENANT_REDACT_KEYS } from "@/lib/api/redact";

export const runtime = "nodejs";

/**
 * GET /api/audit/entity?entity_type=trade_calculation&entity_id=<uuid>
 *
 * Per-entity change history (audit46) — powers the "History" panels in the
 * Trade Calculator detail and the Referral Commissions admin detail sheet.
 *
 * Why a dedicated endpoint instead of /api/audit:
 *   • /api/audit requires `audit.read` — a trade user with only
 *     trade-calculator.read (or a commissions user with only
 *     commissions.read) would 403 on the full audit log viewer, yet they
 *     can already see the entity itself and deserve its change trail.
 *   • This endpoint grants ONLY the history of ONE entity, gated by the
 *     read permission of the module that owns that entity type.
 *
 * Tenant scoping: the store filters audit rows by the caller's tenant_id,
 * so a foreign entity id simply yields an empty list — no cross-tenant
 * leakage. Super-admins without a tenant context are pointed at the
 * cross-tenant super-admin audit endpoint instead (same contract as
 * /api/audit).
 */

// Entity types that have a dedicated History panel → the module read
// permission that gates them. Anything else falls back to audit.read
// (the general audit permission).
const ENTITY_PERMISSIONS: Record<string, string> = {
  trade_calculation: "trade-calculator.read",
  referral_commission: "commissions.read",
};

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;

    if (!auth.tenantId) {
      return NextResponse.json(
        { error: "Use /api/super-admin/audit for cross-tenant audit." },
        { status: 403 },
      );
    }
    const tid = auth.tenantId;

    const url = new URL(req.url);
    const entityType = url.searchParams.get("entity_type") || "";
    const entityId = url.searchParams.get("entity_id") || "";

    if (!entityType || !/^[a-z_]{2,64}$/.test(entityType)) {
      return NextResponse.json({ error: "Invalid entity_type." }, { status: 400 });
    }
    if (!entityId || entityId.length > 100) {
      return NextResponse.json({ error: "Invalid entity_id." }, { status: 400 });
    }

    // Module-scoped permission gate — see the comment above.
    const permission = ENTITY_PERMISSIONS[entityType] || "audit.read";
    {
      const { requirePermission } = await import("@/lib/permissions/can");
      const denied = requirePermission(auth, permission);
      if (denied) return denied;
    }

    const limit = url.searchParams.get("limit")
      ? Math.min(Number(url.searchParams.get("limit")) || 50, 200)
      : 100;

    const result = await auth.store.listAudit(tid, {
      entity_type: entityType,
      entity_id: entityId,
      limit,
    });

    return NextResponse.json({
      total: result.total,
      limit,
      items: result.items.map((item) => ({
        ...item,
        details: redactDetails(item.details, TENANT_REDACT_KEYS),
      })),
    });
  } catch (error: any) {
    console.error("[audit/entity GET]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
