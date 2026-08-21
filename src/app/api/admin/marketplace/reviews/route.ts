import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/marketplace/reviews
//
// Cross-tenant review moderation list for the super-admin panel.
//
// Query params:
//   - flagged:   "true" → only is_flagged reviews; "false" → only unflagged;
//                omitted → all
//   - hidden:    "true" → only is_public=false; "false" → only is_public=true;
//                omitted → all
//   - limit:     page size (default 50, max 200)
//   - offset:    pagination offset
//
// Hydrates the reviewer + reviewed company names via the partners table.
// Auth: super_admin only.
// ─────────────────────────────────────────────────────────────────────────────
async function _get(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const sb = getSupabase();
    const url = new URL(req.url);
    const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
    const offset = Number(url.searchParams.get("offset") || 0);
    const flagged = url.searchParams.get("flagged");
    const hidden = url.searchParams.get("hidden");

    let q = sb
      .from("marketplace_reviews")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false });

    if (flagged === "true") q = q.eq("is_flagged", true);
    else if (flagged === "false") q = q.eq("is_flagged", false);
    if (hidden === "true") q = q.eq("is_public", false);
    else if (hidden === "false") q = q.eq("is_public", true);

    const { data, error, count } = await q.range(offset, offset + limit - 1);
    if (error) throw error;

    const rows = (data as any[]) || [];
    const partnerIds = Array.from(
      new Set(
        rows.flatMap((r) => [r.reviewer_partner_id, r.reviewed_partner_id].filter(Boolean)),
      ),
    );
    let partnersById: Record<string, { name: string; tenant_id: string | null; country: string | null }> = {};
    if (partnerIds.length > 0) {
      const { data: partnerRows } = await sb
        .from("partners")
        .select("id, name, tenant_id, country")
        .in("id", partnerIds);
      partnersById = Object.fromEntries(((partnerRows as any[]) || []).map((p) => [p.id, p]));
    }

    const items = rows.map((r) => ({
      ...r,
      reviewer_name: partnersById[r.reviewer_partner_id]?.name ?? null,
      reviewed_name: partnersById[r.reviewed_partner_id]?.name ?? null,
      reviewed_country: partnersById[r.reviewed_partner_id]?.country ?? null,
    }));

    return NextResponse.json({ items, total: count ?? 0, limit, offset });
  } catch (e: any) {
    console.error("[admin.marketplace.reviews] GET failed:", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/admin/marketplace/reviews
//
// Hide / show / flag / unflag a review. The "hide" action flips is_public
// (so the review disappears from the public profile but stays in the audit
// trail); "flag" sets is_flagged + stamps the admin's username + reason.
//
// Body:
//   { review_id: string,
//     action:    "hide" | "show" | "flag" | "unflag",
//     reason?:   string }
//
// Auth: super_admin only.
// ─────────────────────────────────────────────────────────────────────────────
async function _put(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body?.review_id || typeof body.review_id !== "string") {
    return NextResponse.json({ error: "review_id is required." }, { status: 400 });
  }
  const action = String(body.action || "");
  if (!["hide", "show", "flag", "unflag"].includes(action)) {
    return NextResponse.json(
      { error: "action must be one of: hide, show, flag, unflag." },
      { status: 400 },
    );
  }

  try {
    const sb = getSupabase();

    // Resolve the review (cross-tenant).
    const { data: review, error: rErr } = await sb
      .from("marketplace_reviews")
      .select("*")
      .eq("id", body.review_id)
      .maybeSingle();
    if (rErr) throw rErr;
    if (!review) {
      return NextResponse.json({ error: "Review not found." }, { status: 404 });
    }

    let patch: Record<string, unknown> = {};
    let auditAction = "marketplace.review_unknown";
    switch (action) {
      case "hide":
        patch = { is_public: false };
        auditAction = "marketplace.review_hidden";
        break;
      case "show":
        patch = { is_public: true };
        auditAction = "marketplace.review_shown";
        break;
      case "flag":
        patch = {
          is_flagged: true,
          flagged_by: auth.user.username,
          flagged_reason: body.reason || null,
          flagged_at: new Date().toISOString(),
        };
        auditAction = "marketplace.review_flagged";
        break;
      case "unflag":
        patch = {
          is_flagged: false,
          flagged_by: null,
          flagged_reason: null,
          flagged_at: null,
        };
        auditAction = "marketplace.review_unflagged";
        break;
    }

    const { data: updated, error: updErr } = await sb
      .from("marketplace_reviews")
      .update(patch)
      .eq("id", body.review_id)
      .select()
      .maybeSingle();
    if (updErr) throw updErr;

    try {
      await audit(
        auth.store,
        { id: auth.user.id, username: auth.user.username, tenant_id: null },
        req,
        auditAction,
        "marketplace_reviews",
        body.review_id,
        {
          review_id: body.review_id,
          reviewed_partner_id: (review as any).reviewed_partner_id,
          action,
          reason: body.reason || null,
          admin: auth.user.username,
        },
      );
    } catch (e) {
      console.error("[admin.marketplace.reviews] audit failed:", e);
    }

    return NextResponse.json({ review: updated });
  } catch (e: any) {
    console.error("[admin.marketplace.reviews] PUT failed:", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/admin/marketplace/reviews?id=<review_id>
//
// Physically deletes a review. Used only as a last resort — the audit trail
// keeps the action + a snapshot of the review (review_id + reviewer + text)
// so the deletion can be reconstructed if a GDPR Art. 17 inquiry ever asks
// "what was deleted?".
//
// Auth: super_admin only.
// ─────────────────────────────────────────────────────────────────────────────
async function _del(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const reviewId = url.searchParams.get("id");
  if (!reviewId) {
    return NextResponse.json({ error: "id query param is required." }, { status: 400 });
  }

  try {
    const sb = getSupabase();

    // Snapshot the review for the audit trail before deletion.
    const { data: review, error: rErr } = await sb
      .from("marketplace_reviews")
      .select("*")
      .eq("id", reviewId)
      .maybeSingle();
    if (rErr) throw rErr;
    if (!review) {
      return NextResponse.json({ error: "Review not found." }, { status: 404 });
    }

    const { error: delErr } = await sb
      .from("marketplace_reviews")
      .delete()
      .eq("id", reviewId);
    if (delErr) throw delErr;

    try {
      await audit(
        auth.store,
        { id: auth.user.id, username: auth.user.username, tenant_id: null },
        req,
        "marketplace.review_deleted",
        "marketplace_reviews",
        reviewId,
        {
          review_id: reviewId,
          reviewer_partner_id: (review as any).reviewer_partner_id,
          reviewed_partner_id: (review as any).reviewed_partner_id,
          rating: (review as any).rating,
          review_text: (review as any).review_text,
          admin: auth.user.username,
        },
      );
    } catch (e) {
      console.error("[admin.marketplace.reviews] audit failed:", e);
    }

    return NextResponse.json({ ok: true, deleted: reviewId });
  } catch (e: any) {
    console.error("[admin.marketplace.reviews] DELETE failed:", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/admin/marketplace/reviews");
export const PUT = withApm(_put, "PUT /api/admin/marketplace/reviews");
export const DELETE = withApm(_del, "DELETE /api/admin/marketplace/reviews");
