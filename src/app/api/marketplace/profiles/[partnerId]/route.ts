import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { canReviewPartner, getCompanyProfile } from "@/lib/data/marketplace-profile-store";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/profiles/[partnerId] — public company profile.
//
// Returns:
//   - The sanitised company profile row (no tenant_id).
//   - `viewer_follows`: boolean — is the caller currently following this
//     company? (Drives the Follow button state.)
//   - `can_review`: boolean — is the caller eligible to write a review
//     for this company? FALSE when the caller IS the company itself or
//     has no accepted marketplace negotiation with them.
//   - `partner`: the public-facing Partner fields (name, country, etc.)
//     fetched via the Store. We surface name + country + city + website so
//     the profile page can render them without a second round-trip.
//
// The partner_id is the caller's choice (they navigated to this company's
// page), so it's safe to return it back in the response. The tenant
// scoping happens inside getCompanyProfile (must match the caller's
// tenant) so a partner from tenant A can't browse tenant B's profiles.
async function _get(_req: NextRequest, ctx: { params: Promise<{ partnerId: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { partnerId } = await ctx.params;
  try {
    const profile = await getCompanyProfile(partnerId, access.tenant_id, access.partner_id);
    if (!profile) {
      return NextResponse.json({ error: "Profile not found." }, { status: 404 });
    }
    // Best-effort: fetch the Partner row for name/country. If the partner
    // doesn't exist (stale id) we still return the profile so the page can
    // render the marketing copy without the name.
    let partner: {
      name?: string;
      country?: string | null;
      city?: string | null;
      website?: string | null;
    } | null = null;
    try {
      const store = await getStore();
      const p = await store.getPartner(partnerId);
      if (p) {
        partner = {
          name: p.name,
          country: p.country,
          city: p.city,
          website: p.website,
        };
      }
    } catch (e) {
      console.error("[marketplace.profile.get] partner lookup failed:", e);
    }

    // Best-effort: check whether the caller is eligible to leave a
    // review. The full deal-history query is small (single-digit rows
    // for typical tenants) so we run it inline rather than fire-and-forget.
    let canReview = false;
    try {
      canReview = await canReviewPartner(access.tenant_id, access.partner_id, partnerId);
    } catch (e) {
      console.error("[marketplace.profile.get] can_review lookup failed:", e);
    }

    return NextResponse.json({ profile, partner, can_review: canReview });
  } catch (e: any) {
    console.error("[marketplace.profile.get]", e);
    return NextResponse.json({ error: "Failed to load company profile." }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/profiles/[partnerId]");
