import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requirePortalModule } from "@/lib/portal/module-permissions";
import { listMarketplaceCategories } from "@/lib/data/marketplace-store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/categories — the ACTIVE curated taxonomy
// (marketplace_categories, migration 054) for the create-post form.
//
// Previously the form used a hardcoded PRODUCT_CATEGORIES list while the
// admin-curated table was never consumed — 054's promise ("canonical list
// the create-post form validates against") was unwired. The form now
// loads this route and falls back to its static list on failure.
//
// Auth: any active portal session (read-only, no communication gate).
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  // 100 — module permission gate (marketplace).
  const _moduleBlock = await requirePortalModule(access, "marketplace");
  if (_moduleBlock) return _moduleBlock;
  try {
    const items = await listMarketplaceCategories();
    return NextResponse.json({ items });
  } catch (e: any) {
    console.error("[marketplace.categories]", e);
    return NextResponse.json({ error: "Failed to load categories." }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/categories");
