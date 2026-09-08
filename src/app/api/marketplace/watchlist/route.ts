import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requirePortalModule } from "@/lib/portal/module-permissions";
import { requireMarketplaceEnabled } from "@/lib/portal/marketplace-gate";
import {
  listWatchlistIds,
  listWatchlistPosts,
  toggleWatchlist,
} from "@/lib/data/marketplace-store";
import { withApm } from "@/lib/monitoring/apm";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";

export const runtime = "nodejs";

// GET /api/marketplace/watchlist          → { post_ids: string[] }
// GET /api/marketplace/watchlist?hydrate=1&limit=&offset=
//                                         → { items: PublicPost[], total }
//
// Watching is a PERSONAL, read-only feature: available to every tier
// (it is not marketplace communication). The hydrated feed returns the
// same public post shape as GET /api/marketplace (incl.
// poster_kyc_verified).
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  // 099 — module permission gate (marketplace).
  const _moduleBlock = await requirePortalModule(access, "marketplace");
  if (_moduleBlock) return _moduleBlock;
  // 100 — tenant marketplace switch (Layer 0).
  const _enabledBlock = await requireMarketplaceEnabled(access);
  if (_enabledBlock) return _enabledBlock;
  const url = new URL(req.url);
  const hydrate = url.searchParams.get("hydrate") === "1";
  try {
    if (!hydrate) {
      const postIds = await listWatchlistIds(access.tenant_id, access.partner_id);
      return NextResponse.json({ post_ids: postIds });
    }
    const limit = url.searchParams.get("limit")
      ? Number(url.searchParams.get("limit"))
      : undefined;
    const offset = url.searchParams.get("offset")
      ? Number(url.searchParams.get("offset"))
      : undefined;
    const result = await listWatchlistPosts(
      access.tenant_id,
      access.partner_id,
      limit,
      offset,
    );
    return NextResponse.json(result);
  } catch (e: any) {
    console.error("[marketplace.watchlist.get]", e);
    return NextResponse.json({ error: sanitizeError(e) || "Failed to load watchlist." }, { status: 500 });
  }
}

// POST /api/marketplace/watchlist — body: { post_id } → toggles.
// Returns { on_watchlist: boolean } (the NEW state).
async function _post(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  // 099 — module permission gate (marketplace).
  const _moduleBlock = await requirePortalModule(access, "marketplace");
  if (_moduleBlock) return _moduleBlock;
  // 100 — tenant marketplace switch (Layer 0).
  const _enabledBlock = await requireMarketplaceEnabled(access);
  if (_enabledBlock) return _enabledBlock;
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const postId = typeof body?.post_id === "string" ? body.post_id : "";
  if (!postId) {
    return NextResponse.json({ error: "post_id is required." }, { status: 400 });
  }
  try {
    const onWatchlist = await toggleWatchlist(access.tenant_id, access.partner_id, postId);
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        onWatchlist ? "marketplace.watchlist_added" : "marketplace.watchlist_removed",
        "marketplace_post",
        postId,
        {},
      );
    } catch (e) {
      console.error("[marketplace.watchlist.post] audit failed:", e);
    }
    return NextResponse.json({ on_watchlist: onWatchlist });
  } catch (e: any) {
    console.error("[marketplace.watchlist.post]", e);
    const msg = sanitizeError(e);
    const status = /not found/i.test(msg) ? 404 : 500;
    return NextResponse.json({ error: msg || "Failed to toggle watchlist." }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/watchlist");
export const POST = withApm(_post, "POST /api/marketplace/watchlist");
