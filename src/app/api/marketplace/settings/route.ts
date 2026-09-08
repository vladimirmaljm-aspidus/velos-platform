import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requirePortalModule } from "@/lib/portal/module-permissions";
import { getMarketplaceTenantSettings } from "@/lib/data/marketplace-store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/settings — the caller's TENANT marketplace policy
// (read-only, sanitised) so the portal UI can adapt:
//   • enabled            → hide the marketplace nav / show a lock card
//   • require_approval   → "your post will be reviewed before publishing"
//   • allow_private_posts / default_visibility → create-form options
//
// NOTE: this intentionally does NOT expose public_feed_enabled — that knob
// only affects the anonymous public API, nothing the portal renders.
//
// Auth: any active portal session.
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  // 100 — module permission gate (marketplace).
  const _moduleBlock = await requirePortalModule(access, "marketplace");
  if (_moduleBlock) return _moduleBlock;
  try {
    const settings = await getMarketplaceTenantSettings(access.tenant_id);
    return NextResponse.json({
      settings: {
        enabled: settings.enabled,
        posting_policy: settings.posting_policy,
        require_approval: settings.require_approval,
        default_visibility: settings.default_visibility,
        allow_private_posts: settings.allow_private_posts,
      },
    });
  } catch (e: any) {
    console.error("[marketplace.settings]", e);
    return NextResponse.json({ error: "Failed to load marketplace settings." }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/settings");
