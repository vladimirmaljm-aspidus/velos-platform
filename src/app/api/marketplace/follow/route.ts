import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { followPartner, unfollowPartner } from "@/lib/data/marketplace-profile-store";
import { getSupabase } from "@/lib/supabase/client";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// POST /api/marketplace/follow — follow a company.
// Body: { followed_partner_id: string }
// Idempotent: if the caller already follows the company, the store
// returns the existing follow row instead of erroring.
//
// Tenant scoping: verify the followed company is a partner in the
// caller's tenant before inserting.
async function _post(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body.followed_partner_id || typeof body.followed_partner_id !== "string") {
    return NextResponse.json({ error: "followed_partner_id is required." }, { status: 400 });
  }
  if (body.followed_partner_id === access.partner_id) {
    return NextResponse.json({ error: "Cannot follow your own company." }, { status: 400 });
  }

  // Tenant scoping: verify the followed company is in the caller's tenant.
  const sb = getSupabase();
  const { data: partnerRow, error: pErr } = await sb
    .from("partners")
    .select("id, tenant_id")
    .eq("id", body.followed_partner_id)
    .maybeSingle();
  if (pErr) {
    console.error("[marketplace.follow.create] partner lookup failed:", pErr);
    return NextResponse.json({ error: "Failed to follow." }, { status: 500 });
  }
  if (!partnerRow || (partnerRow as any).tenant_id !== access.tenant_id) {
    return NextResponse.json({ error: "Partner not found." }, { status: 404 });
  }

  try {
    const follow = await followPartner(access.partner_id, body.followed_partner_id);
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.follow_created",
        "marketplace_follow",
        follow?.id,
        { followed_partner_id: body.followed_partner_id },
      );
    } catch (e) {
      console.error("[marketplace.follow.create] audit failed:", e);
    }
    return NextResponse.json({ ok: true, follow });
  } catch (e: any) {
    console.error("[marketplace.follow.create]", e);
    return NextResponse.json({ error: sanitizeError(e)}, { status: 500 });
  }
}

// DELETE /api/marketplace/follow?partnerId=<partnerId> — unfollow a company.
// Idempotent: if the caller doesn't follow the company, the store deletes
// zero rows and returns OK.
async function _delete(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const url = new URL(req.url);
  const partnerId = url.searchParams.get("partnerId");
  if (!partnerId) {
    return NextResponse.json({ error: "partnerId query param is required." }, { status: 400 });
  }

  try {
    await unfollowPartner(access.partner_id, partnerId);
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.follow_deleted",
        "marketplace_follow",
        undefined,
        { followed_partner_id: partnerId },
      );
    } catch (e) {
      console.error("[marketplace.follow.delete] audit failed:", e);
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[marketplace.follow.delete]", e);
    return NextResponse.json({ error: sanitizeError(e)}, { status: 500 });
  }
}

export const POST = withApm(_post, "POST /api/marketplace/follow");
export const DELETE = withApm(_delete, "DELETE /api/marketplace/follow");
