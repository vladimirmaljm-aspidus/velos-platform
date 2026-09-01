import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKey, resolveTenantId, hasPermission, audit, sanitizeError, type AuthContext, type ApiKeyAuthContext, getAuthUser } from "@/lib/api/helpers";

export const runtime = "nodejs";

type ProductBulkAction = "activate" | "deactivate" | "show_in_portal" | "hide_from_portal" | "delete";

interface ResultRow {
  id: string;
  success: boolean;
  error?: string;
}

/**
 * POST /api/products/bulk
 * Body: { ids: string[], action: "activate" | "deactivate" | "show_in_portal" | "hide_from_portal" | "delete" }
 *
 * Products don't have a state machine — they have two independent toggles
 * (`active` for sellable, `show_in_catalog` for portal visibility) plus
 * hard-delete. This route exposes both toggles and delete so the list-view
 * bulk action bar can flip either flag in a single round-trip.
 *
 * Caps:
 *  - Max 100 IDs per call.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;

    if ("apiKeyId" in auth && !hasPermission(auth.permissions, "products:write")) {
      return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
    }
    { const { requirePermission } = await import("@/lib/permissions/can");
      if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "products.update"); if (_d) return _d; } }

    const tid = resolveTenantId(auth, req);

    let body: { ids?: unknown; action?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const ids = body.ids;
    const action = body.action as ProductBulkAction | undefined;

    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: "No IDs provided." }, { status: 400 });
    }
    if (ids.length > 100) {
      return NextResponse.json({ error: "Maximum 100 items per bulk operation." }, { status: 400 });
    }
    const validActions: ProductBulkAction[] = [
      "activate",
      "deactivate",
      "show_in_portal",
      "hide_from_portal",
      "delete",
    ];
    if (!action || !validActions.includes(action)) {
      return NextResponse.json(
        { error: `Invalid action. Must be one of: ${validActions.join(", ")}.` },
        { status: 400 },
      );
    }

    const results: ResultRow[] = [];
    const succeededIds: string[] = [];

    for (const id of ids) {
      if (typeof id !== "string" || !id.trim()) {
        results.push({ id: String(id), success: false, error: "Invalid id." });
        continue;
      }
      try {
        if (action === "delete") {
          // Fetch first to enforce tenant ownership (deleteProduct is by-id
          // and does not return a "not found" indicator).
          const product = await auth.store.getProduct(id);
          if (!product) {
            results.push({ id, success: false, error: "Not found." });
            continue;
          }
          // AUDIT19 / F8 — tenant-less rows are treated as FOREIGN for
          // non-super-admins: the previous `product.tenant_id &&` guard
          // required tenant_id to be truthy, so a NULL/''-tenant row
          // (platform-level or legacy) bypassed the scope check and a
          // tenant admin could delete/toggle platform rows.
          const isSuperAdmin = !!("user" in auth && auth.isSuperAdmin);
          if (tid && !isSuperAdmin && product.tenant_id !== tid) {
            results.push({ id, success: false, error: "Not found." });
            continue;
          }
          await auth.store.deleteProduct(id);
          results.push({ id, success: true });
          succeededIds.push(id);
          continue;
        }

        // Toggle actions — fetch the row, flip the field, upsert.
        const product = await auth.store.getProduct(id);
        if (!product) {
          results.push({ id, success: false, error: "Not found." });
          continue;
        }
        // AUDIT19 / F8 — same tenant-less fix as the delete branch above.
        const isSuperAdmin = !!("user" in auth && auth.isSuperAdmin);
        if (tid && !isSuperAdmin && product.tenant_id !== tid) {
          results.push({ id, success: false, error: "Not found." });
          continue;
        }

        const patch: Record<string, unknown> = {
          ...product,
          tenant_id: product.tenant_id || tid,
          force: true, // skip duplicate-name guard on bulk re-save
        };

        switch (action) {
          case "activate":
            patch.active = true;
            break;
          case "deactivate":
            patch.active = false;
            break;
          case "show_in_portal":
            patch.show_in_catalog = true;
            break;
          case "hide_from_portal":
            patch.show_in_catalog = false;
            break;
        }

        await auth.store.upsertProduct(patch as Parameters<typeof auth.store.upsertProduct>[0]);
        results.push({ id, success: true });
        succeededIds.push(id);
      } catch (e) {
        results.push({
          id,
          success: false,
          error: sanitizeError(e),
        });
      }
    }

    await audit(
      auth.store,
      getAuthUser(auth),
      req,
      `products.bulk_${action}`,
      "products",
      succeededIds.join(","),
      { action, count: ids.length, successCount: succeededIds.length },
    );

    return NextResponse.json({
      results,
      successCount: results.filter((r) => r.success).length,
      failureCount: results.filter((r) => !r.success).length,
    });
  } catch (e) {
    console.error("[products.bulk]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
