import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getReview, respondToReview } from "@/lib/data/marketplace-profile-store";
import { sanitizeFields } from "@/lib/security/sanitize-input";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/reviews/[id] — fetch a single review. The caller
// must be either the reviewer or the reviewed company — otherwise the
// store returns NULL and we surface a 404 (NOT a 403, to avoid leaking
// that a review with this id exists).
async function _get(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const review = await getReview(id, access.partner_id);
    if (!review) {
      return NextResponse.json({ error: "Review not found." }, { status: 404 });
    }
    return NextResponse.json({ review });
  } catch (e: any) {
    console.error("[marketplace.reviews.get]", e);
    return NextResponse.json({ error: "Failed to load review." }, { status: 500 });
  }
}

// PUT /api/marketplace/reviews/[id] — respond to a review (the reviewed
// company posts a public reply). Only the reviewed company may call this;
// the store verifies caller === reviewed_partner_id.
//
// Body: { response_text: string }
async function _put(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body.response_text || typeof body.response_text !== "string" || body.response_text.trim().length === 0) {
    return NextResponse.json({ error: "response_text is required." }, { status: 400 });
  }
  if (body.response_text.length > 5000) {
    return NextResponse.json(
      { error: "Response text is too long (max 5000 chars)." },
      { status: 400 },
    );
  }

  body = sanitizeFields(body, ["response_text"]);

  try {
    const updated = await respondToReview(id, access.partner_id, body.response_text);
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.review_responded",
        "marketplace_review",
        id,
        { reviewed_partner_id: updated.reviewed_partner_id },
      );
    } catch (e) {
      console.error("[marketplace.reviews.put] audit failed:", e);
    }
    return NextResponse.json({ review: updated });
  } catch (e: any) {
    console.error("[marketplace.reviews.put]", e);
    const msg = sanitizeError(e);
    let status = 500;
    if (/not found/i.test(msg)) status = 404;
    else if (/only the reviewed company/i.test(msg)) status = 403;
    else if (/response text is required/i.test(msg)) status = 400;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/reviews/[id]");
export const PUT = withApm(_put, "PUT /api/marketplace/reviews/[id]");
