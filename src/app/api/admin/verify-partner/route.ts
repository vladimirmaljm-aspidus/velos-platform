import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/api/helpers";
import { updateVerificationLevel } from "@/lib/data/marketplace-profile-store";
import { getSupabase } from "@/lib/supabase/client";
import { audit } from "@/lib/api/helpers";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// POST /api/admin/verify-partner — super-admin only.
//
// Body:
//   { partner_id: string, level: "none"|"bronze"|"silver"|"gold"|"platinum" }
//
// Sets a company's verification tier. Stamps verified_at + verified_by
// (username of the super-admin) alongside the new level. Idempotent —
// re-running with the same level just refreshes the verified_at timestamp.
//
// The route resolves the partner's tenant via a direct lookup on the
// partners table (no Store dependency — the Store is tenant-scoped, but
// a super-admin verifying a partner needs to reach across tenants).
async function _post(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body.partner_id || typeof body.partner_id !== "string") {
    return NextResponse.json({ error: "partner_id is required." }, { status: 400 });
  }
  const allowed = ["none", "bronze", "silver", "gold", "platinum"];
  if (!allowed.includes(body.level)) {
    return NextResponse.json(
      { error: "level must be one of: none, bronze, silver, gold, platinum." },
      { status: 400 },
    );
  }

  // Verify the partner exists (any tenant — super-admin scope).
  const sb = getSupabase();
  const { data: partner, error: pErr } = await sb
    .from("partners")
    .select("id, tenant_id, name")
    .eq("id", body.partner_id)
    .maybeSingle();
  if (pErr) {
    console.error("[admin.verify-partner] partner lookup failed:", pErr);
    return NextResponse.json({ error: "Failed to verify partner." }, { status: 500 });
  }
  if (!partner) {
    return NextResponse.json({ error: "Partner not found." }, { status: 404 });
  }

  try {
    const updated = await updateVerificationLevel(
      body.partner_id,
      body.level,
      auth.user.username,
    );
    try {
      await audit(
        auth.store,
        {
          id: auth.user.id,
          username: auth.user.username,
          tenant_id: (partner as any).tenant_id,
        },
        req,
        "marketplace.verification_updated",
        "marketplace_company_profile",
        updated?.id,
        {
          partner_id: body.partner_id,
          partner_name: (partner as any).name,
          level: body.level,
          verified_by: auth.user.username,
        },
      );
    } catch (e) {
      console.error("[admin.verify-partner] audit failed:", e);
    }
    return NextResponse.json({ profile: updated });
  } catch (e: any) {
    console.error("[admin.verify-partner]", e);
    return NextResponse.json({ error: e.message || "Failed to update verification." }, { status: 500 });
  }
}

export const POST = withApm(_post, "POST /api/admin/verify-partner");
