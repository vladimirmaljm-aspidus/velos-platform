import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requirePortalModule } from "@/lib/portal/module-permissions";
import { requireMarketplaceEnabled } from "@/lib/portal/marketplace-gate";
import { deleteSavedSearch } from "@/lib/data/marketplace-store";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// DELETE /api/marketplace/saved-searches/[id] — delete one of the
// CALLER'S saved searches. Ownership is enforced in the store
// (tenant_id + portal_access_id must match), so a user can never delete
// a colleague's saved search by guessing ids. Response: { ok: true },
// 404 when the row does not exist / is not owned by the caller.
async function _delete(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  // 100 — module permission gate (marketplace).
  const _moduleBlock = await requirePortalModule(access, "marketplace");
  if (_moduleBlock) return _moduleBlock;
  // 100 — tenant marketplace switch (Layer 0).
  const _enabledBlock = await requireMarketplaceEnabled(access);
  if (_enabledBlock) return _enabledBlock;

  const { id } = await ctx.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: "Invalid saved-search id." }, { status: 400 });
  }

  try {
    const deleted = await deleteSavedSearch(access.tenant_id, access.id, id);
    if (!deleted) {
      return NextResponse.json({ error: "Saved search not found." }, { status: 404 });
    }
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.saved_search_deleted",
        "marketplace_saved_search",
        id,
      );
    } catch (e) {
      console.error("[marketplace.saved-searches.delete] audit failed:", e);
    }
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    console.error("[marketplace.saved-searches.delete]", e);
    return NextResponse.json(
      { error: sanitizeError(e) || "Failed to delete saved search." },
      { status: 500 },
    );
  }
}

export const DELETE = withApm(_delete, "DELETE /api/marketplace/saved-searches/[id]");
