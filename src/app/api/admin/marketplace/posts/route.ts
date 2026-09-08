import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import { withApm } from "@/lib/monitoring/apm";
import { requirePermission } from "@/lib/permissions/can";

export const runtime = "nodejs";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/marketplace/posts
//
// Marketplace posts browser for moderation.
//
// • super_admin  — cross-tenant (every tenant's posts).
// • tenant admin — ONLY their own tenant's posts (099: the tenant admin
//                  gets a moderation surface — previously this route was
//                  super-admin-only, so a tenant could not moderate its
//                  own marketplace at all).
//
// Query params:
//   - status:    draft | pending | active | closed | expired | flagged
//   - post_type: buy | sell | auction | contract               (default: all)
//   - search:    case-insensitive substring on product_name + description
//   - limit:     page size (default 50, max 200)
//   - offset:    pagination offset
//   - featured:  'true' → only is_featured posts; 'false' → only non-featured
//                omitted → all (no filter)
//
// Auth: `marketplace.moderate` permission (admin implicit; super bypass).
// ─────────────────────────────────────────────────────────────────────────────
async function _get(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  {
    const _d = requirePermission(auth, "marketplace.moderate");
    if (_d) return _d;
  }

  try {
    const sb = getSupabase();
    const url = new URL(req.url);
    const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
    const offset = Number(url.searchParams.get("offset") || 0);
    const status = url.searchParams.get("status");
    const postType = url.searchParams.get("post_type");
    const featured = url.searchParams.get("featured");
    const search = url.searchParams.get("search")?.trim();

    let q = sb
      .from("marketplace_posts")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false });

    // Tenant admins are scoped to their own tenant.
    if (!auth.isSuperAdmin) q = q.eq("tenant_id", auth.tenantId!);

    if (status) q = q.eq("status", status);
    if (postType) q = q.eq("post_type", postType);
    if (featured === "true") q = q.eq("is_featured", true);
    if (featured === "false") q = q.eq("is_featured", false);
    if (search) {
      const s = search.replace(/[(),\\]/g, " ").trim();
      if (s) {
        q = q.or(`product_name.ilike.%${s}%,description.ilike.%${s}%`);
      }
    }

    const { data, error, count } = await q.range(offset, offset + limit - 1);
    if (error) throw error;

    // Hydrate the company name + country for each post's partner so the
    // admin table can show "Acme Trading Ltd." instead of just a UUID.
    // Batched lookup — never N+1.
    const rows = (data as any[]) || [];
    const partnerIds = Array.from(new Set(rows.map((r) => r.partner_id).filter(Boolean)));
    let partnersById: Record<string, { name: string; country: string | null; tenant_id: string | null }> = {};
    if (partnerIds.length > 0) {
      const { data: partnerRows } = await sb
        .from("partners")
        .select("id, name, country, tenant_id")
        .in("id", partnerIds);
      partnersById = Object.fromEntries(
        ((partnerRows as any[]) || []).map((p) => [p.id, p]),
      );
    }

    // Tenant names so the admin can see which tenant each post belongs to.
    const tenantIds = Array.from(new Set(rows.map((r) => r.tenant_id).filter(Boolean)));
    let tenantsById: Record<string, { name: string }> = {};
    if (tenantIds.length > 0) {
      const { data: tenantRows } = await sb
        .from("tenants")
        .select("id, name")
        .in("id", tenantIds);
      tenantsById = Object.fromEntries(
        ((tenantRows as any[]) || []).map((t) => [t.id, t]),
      );
    }

    const items = rows.map((r) => {
      const partner = partnersById[r.partner_id];
      const tenant = tenantsById[r.tenant_id];
      return {
        ...r,
        company_name: partner?.name ?? null,
        company_country: partner?.country ?? null,
        tenant_name: tenant?.name ?? null,
      };
    });

    return NextResponse.json({ items, total: count ?? 0, limit, offset });
  } catch (e: any) {
    console.error("[admin.marketplace.posts] GET failed:", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/admin/marketplace/posts
//
// Applies a single moderation action to one post. The action enum mirrors
// what the admin table's row-action menu offers.
//
// Body:
//   { post_id: string, action: "flag" | "unflag" | "remove" | "feature"
//                        | "unfeature" | "approve" }
//
//   'approve' (099) — pending → active: the moderated-publishing approval
//   step. Without it, posts created under require_approval would stay
//   invisible forever.
//
// • super_admin  — any post (cross-tenant).
// • tenant admin — only posts in their OWN tenant (404 otherwise — no
//                  cross-tenant existence leak).
//
// Auth: `marketplace.moderate` permission. Every action writes an
// audit_logs row.
// ─────────────────────────────────────────────────────────────────────────────
async function _put(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  {
    const _d = requirePermission(auth, "marketplace.moderate");
    if (_d) return _d;
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body?.post_id || typeof body.post_id !== "string") {
    return NextResponse.json({ error: "post_id is required." }, { status: 400 });
  }
  const action = String(body.action || "");
  const allowed = ["flag", "unflag", "remove", "feature", "unfeature", "approve"];
  if (!allowed.includes(action)) {
    return NextResponse.json(
      { error: `action must be one of: ${allowed.join(", ")}.` },
      { status: 400 },
    );
  }

  try {
    const sb = getSupabase();

    // Verify the post exists. Tenant admins: scope to their own tenant —
    // a post id from another tenant reads as "not found" (no leak).
    let q = sb
      .from("marketplace_posts")
      .select("id, tenant_id, partner_id, product_name, status, is_featured")
      .eq("id", body.post_id);
    if (!auth.isSuperAdmin) q = q.eq("tenant_id", auth.tenantId!);
    const { data: post, error: pErr } = await q.maybeSingle();
    if (pErr) throw pErr;
    if (!post) {
      return NextResponse.json({ error: "Post not found." }, { status: 404 });
    }

    // 'approve' is only valid on a pending post (moderated publishing).
    if (action === "approve" && post.status !== "pending") {
      return NextResponse.json(
        { error: "Only posts awaiting approval (pending) can be approved." },
        { status: 409 },
      );
    }

    let patch: Record<string, unknown> = {};
    let auditAction = "marketplace.post_unknown";
    switch (action) {
      case "flag":
        patch = { status: "flagged" };
        auditAction = "marketplace.post_flagged";
        break;
      case "unflag":
        // Unflagging restores the post to "active" — the admin has reviewed
        // the report and decided the post is fine.
        patch = { status: "active" };
        auditAction = "marketplace.post_unflagged";
        break;
      case "approve":
        // 099 — moderated publishing approval: pending → active.
        patch = { status: "active" };
        auditAction = "marketplace.post_approved";
        break;
      case "remove":
        // "Remove" doesn't physically delete the row — it sets status to
        // "closed" so the audit trail stays intact and the post stops
        // appearing in the public feed.
        patch = { status: "closed" };
        auditAction = "marketplace.post_removed";
        break;
      case "feature":
        patch = { is_featured: true };
        auditAction = "marketplace.post_featured";
        break;
      case "unfeature":
        patch = { is_featured: false };
        auditAction = "marketplace.post_unfeatured";
        break;
    }

    const { data: updated, error: updErr } = await sb
      .from("marketplace_posts")
      .update(patch)
      .eq("id", body.post_id)
      .select()
      .maybeSingle();
    if (updErr) throw updErr;

    try {
      await audit(
        auth.store,
        { id: auth.user.id, username: auth.user.username, tenant_id: (post as any).tenant_id },
        req,
        auditAction,
        "marketplace_posts",
        body.post_id,
        {
          post_id: body.post_id,
          product_name: (post as any).product_name,
          action,
          admin: auth.user.username,
        },
      );
    } catch (e) {
      console.error("[admin.marketplace.posts] audit failed:", e);
    }

    return NextResponse.json({ post: updated });
  } catch (e: any) {
    console.error("[admin.marketplace.posts] PUT failed:", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/admin/marketplace/posts");
export const PUT = withApm(_put, "PUT /api/admin/marketplace/posts");
