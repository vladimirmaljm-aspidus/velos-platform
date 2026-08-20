import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, audit } from "@/lib/api/helpers";
import { getWhiteLabelConfig, setWhiteLabelConfig, DEFAULT_WHITE_LABEL, type WhiteLabelConfig } from "@/lib/marketplace/white-label";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// ── White-label admin route ───────────────────────────────────────────────
//
// GET /api/admin/white-label?tenant_id=<id>
//   Returns the white-label config for the tenant. Super-admin only.
//   Returns the defaults (VELOS Marketplace branding) when the tenant
//   hasn't configured anything yet.
//
// PUT /api/admin/white-label?tenant_id=<id>
//   Persists a white-label config for the tenant. Super-admin only.
//   The body is the full WhiteLabelConfig shape (a partial shape is
//   merged with the defaults so omitted fields fall back to the
//   VELOS defaults — callers can send just `{ marketplaceName, primaryColor }`
//   and the rest is filled in).
//
// Auth: super_admin session cookie (requireSuperAdmin). The marketplace
// read endpoint will be a separate public route (TBD in a follow-up)
// so the portal shell can load the brand without forcing a login.

async function _get(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const tenantId = url.searchParams.get("tenant_id");
  if (!tenantId) {
    return NextResponse.json({ error: "tenant_id query param is required." }, { status: 400 });
  }

  try {
    const config = await getWhiteLabelConfig(tenantId);
    return NextResponse.json({ config, defaults: DEFAULT_WHITE_LABEL });
  } catch (e: any) {
    console.error("[admin.white-label.get]", e);
    return NextResponse.json({ error: e?.message || "Failed to load white-label config." }, { status: 500 });
  }
}

async function _put(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const tenantId = url.searchParams.get("tenant_id");
  if (!tenantId) {
    return NextResponse.json({ error: "tenant_id query param is required." }, { status: 400 });
  }

  let body: Partial<WhiteLabelConfig>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }

  try {
    const saved = await setWhiteLabelConfig(tenantId, body);
    try {
      await audit(
        auth.store,
        auth.user,
        req,
        "admin.white_label_updated",
        "tenant",
        tenantId,
        {
          marketplaceName: saved.marketplaceName,
          customDomain: saved.customDomain,
          hideVelosBranding: saved.hideVelosBranding,
        },
      );
    } catch (e) {
      console.error("[admin.white-label.put] audit failed:", e);
    }
    return NextResponse.json({ config: saved });
  } catch (e: any) {
    console.error("[admin.white-label.put]", e);
    return NextResponse.json({ error: e?.message || "Failed to save white-label config." }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/admin/white-label");
export const PUT = withApm(_put, "PUT /api/admin/white-label");
