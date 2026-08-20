import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { createReview, listReviews } from "@/lib/data/marketplace-profile-store";
import { getSupabase } from "@/lib/supabase/client";
import { sanitizeFields } from "@/lib/security/sanitize-input";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/reviews?partnerId=<partnerId> — list public reviews
// for a company. The caller must be in the same tenant as the reviewed
// company. When the caller IS the reviewed company, the full row is
// returned (so they can see who rated them + respond). For everyone else
// the reviewer_partner_id is sanitised out by the store.
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const url = new URL(req.url);
  const partnerId = url.searchParams.get("partnerId");
  if (!partnerId) {
    return NextResponse.json({ error: "partnerId query param is required." }, { status: 400 });
  }

  // Tenant scoping: verify the reviewed company is a partner in the
  // caller's tenant before listing. This is the only tenant gate —
  // the reviews table itself has no tenant_id column.
  const sb = getSupabase();
  const { data: partnerRow, error: pErr } = await sb
    .from("partners")
    .select("id, tenant_id")
    .eq("id", partnerId)
    .maybeSingle();
  if (pErr) {
    console.error("[marketplace.reviews.list] partner lookup failed:", pErr);
    return NextResponse.json({ error: "Failed to load reviews." }, { status: 500 });
  }
  if (!partnerRow || (partnerRow as any).tenant_id !== access.tenant_id) {
    return NextResponse.json({ error: "Partner not found." }, { status: 404 });
  }

  try {
    const items = await listReviews(partnerId, access.tenant_id, access.partner_id);
    return NextResponse.json({ items });
  } catch (e: any) {
    console.error("[marketplace.reviews.list]", e);
    return NextResponse.json({ error: "Failed to load reviews." }, { status: 500 });
  }
}

// POST /api/marketplace/reviews — create a review.
// Body:
//   { reviewed_partner_id, post_id?, rating (1–5), review_text? }
// The caller is the reviewer. Constraints (enforced by the store):
//   • Cannot review your own company.
//   • Cannot review a partner you have no completed marketplace deal with.
//   • (reviewer, reviewed, post_id) is unique — duplicate reviews on the
//     same post are rejected with 409.
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

  if (!body.reviewed_partner_id || typeof body.reviewed_partner_id !== "string") {
    return NextResponse.json({ error: "reviewed_partner_id is required." }, { status: 400 });
  }
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return NextResponse.json({ error: "Rating must be an integer between 1 and 5." }, { status: 400 });
  }
  body.rating = rating;

  if (body.post_id && typeof body.post_id !== "string") {
    return NextResponse.json({ error: "post_id must be a string." }, { status: 400 });
  }

  // Tenant scoping: verify the reviewed company is in the caller's tenant.
  const sb = getSupabase();
  const { data: partnerRow, error: pErr } = await sb
    .from("partners")
    .select("id, tenant_id")
    .eq("id", body.reviewed_partner_id)
    .maybeSingle();
  if (pErr) {
    console.error("[marketplace.reviews.create] partner lookup failed:", pErr);
    return NextResponse.json({ error: "Failed to create review." }, { status: 500 });
  }
  if (!partnerRow || (partnerRow as any).tenant_id !== access.tenant_id) {
    return NextResponse.json({ error: "Partner not found." }, { status: 404 });
  }

  // XSS prevention on review_text.
  body = sanitizeFields(body, ["review_text"]);
  // Cap review_text length.
  if (body.review_text && typeof body.review_text === "string" && body.review_text.length > 5000) {
    return NextResponse.json(
      { error: "Review text is too long (max 5000 chars)." },
      { status: 400 },
    );
  }

  try {
    const created = await createReview(access.tenant_id, access.partner_id, {
      reviewed_partner_id: body.reviewed_partner_id,
      post_id: body.post_id ?? null,
      rating: body.rating,
      review_text: body.review_text ?? null,
    });
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.review_created",
        "marketplace_review",
        created.id,
        { reviewed_partner_id: body.reviewed_partner_id, rating: body.rating },
      );
    } catch (e) {
      console.error("[marketplace.reviews.create] audit failed:", e);
    }
    return NextResponse.json({ review: created });
  } catch (e: any) {
    console.error("[marketplace.reviews.create]", e);
    const msg = e?.message || "Failed to create review.";
    let status = 500;
    if (/cannot review your own/i.test(msg)) status = 400;
    else if (/already reviewed/i.test(msg)) status = 409;
    else if (/after a completed deal/i.test(msg)) status = 403;
    else if (/integer between 1 and 5/i.test(msg)) status = 400;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/reviews");
export const POST = withApm(_post, "POST /api/marketplace/reviews");
