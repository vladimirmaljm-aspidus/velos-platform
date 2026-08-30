import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
// 8c-2: KYC gate — mirror top-level marketplace POST route. Without this,
// a portal client whose KYC is `rejected` / `suspended` could still create
// shipments / sign trade documents / post community content — binding
// commitments that affect counterparty's downstream flows.
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { createBlogPost, listBlogPosts } from "@/lib/data/marketplace-community-store";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";
import type { BlogPostStatus } from "@/lib/supabase/marketplace-community-types";

export const runtime = "nodejs";

const VALID_STATUSES: BlogPostStatus[] = ["draft", "published", "archived"];

// GET /api/marketplace/blog — list blog posts (published by default).
// Optional query: ?tag=&search=&author=&include_drafts=0&limit=20&offset=0
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  try {
    const url = new URL(req.url);
    const tag = url.searchParams.get("tag") || undefined;
    const search = url.searchParams.get("search") || undefined;
    const author = url.searchParams.get("author") || undefined;
    const include_drafts = url.searchParams.get("include_drafts") === "1";
    const limit = url.searchParams.get("limit");
    const offset = url.searchParams.get("offset");
    const items = await listBlogPosts({
      tag,
      search,
      author_partner_id: author || undefined,
      include_drafts,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return NextResponse.json(items);
  } catch (e: any) {
    console.error("[marketplace.community.blog.list]", e);
    return NextResponse.json({ error: "Failed to load blog posts." }, { status: 500 });
  }
}

// POST /api/marketplace/blog — create a blog post. The caller becomes the
// author; only the author can later PUT the post.
// Body: { title, slug, body, excerpt?, cover_image_url?, tags?, status? }
async function _post(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  // 8c-2: KYC gate — defence-in-depth, mirror top-level marketplace POST.
  const _kycBlock = await requireKycApproved(access);
  if (_kycBlock) return _kycBlock;

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body.title !== "string" || body.title.length < 3 || body.title.length > 200) {
    return NextResponse.json({ error: "title must be 3–200 chars." }, { status: 400 });
  }
  if (typeof body.slug !== "string" || !/^[a-z0-9-]{2,80}$/.test(body.slug)) {
    return NextResponse.json({ error: "slug must be 2–80 chars of lowercase letters/digits/hyphens." }, { status: 400 });
  }
  if (typeof body.body !== "string" || body.body.length < 1 || body.body.length > 100_000) {
    return NextResponse.json({ error: "body must be 1–100000 chars." }, { status: 400 });
  }
  if (body.excerpt && (typeof body.excerpt !== "string" || body.excerpt.length > 500)) {
    return NextResponse.json({ error: "excerpt must be ≤ 500 chars." }, { status: 400 });
  }
  if (body.cover_image_url && (typeof body.cover_image_url !== "string" || body.cover_image_url.length > 500)) {
    return NextResponse.json({ error: "cover_image_url must be ≤ 500 chars." }, { status: 400 });
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.some((t: any) => typeof t !== "string" || t.length < 1 || t.length > 40)) {
      return NextResponse.json({ error: "each tag must be 1–40 chars." }, { status: 400 });
    }
    if (body.tags.length > 20) {
      return NextResponse.json({ error: "at most 20 tags allowed." }, { status: 400 });
    }
  }
  if (body.status !== undefined && !VALID_STATUSES.includes(body.status)) {
    return NextResponse.json({ error: "Invalid status." }, { status: 400 });
  }

  try {
    const created = await createBlogPost(access.partner_id, {
      title: body.title,
      slug: body.slug,
      body: body.body,
      excerpt: body.excerpt ?? undefined,
      cover_image_url: body.cover_image_url ?? undefined,
      tags: Array.isArray(body.tags) ? body.tags : undefined,
      status: body.status ?? undefined,
    });
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.blog_post_created",
        "marketplace_blog_posts",
        created.id,
        { slug: created.slug, status: created.status },
      );
    } catch (e) {
      console.error("[marketplace.community.blog.create] audit failed:", e);
    }
    return NextResponse.json(created, { status: 201 });
  } catch (e: any) {
    console.error("[marketplace.community.blog.create]", e);
    const msg = e?.message || "Failed to create blog post.";
    const status = /slug|name|invalid|must be/i.test(msg) ? 400
      : /unique/i.test(msg) ? 409
      : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/blog");
export const POST = withApm(_post, "POST /api/marketplace/blog");
