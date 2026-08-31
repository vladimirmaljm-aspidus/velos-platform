import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getBlogPost, incrementViews, updateBlogPost } from "@/lib/data/marketplace-community-store";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";
import type { BlogPostStatus } from "@/lib/supabase/marketplace-community-types";

export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ slug: string }>;
}

const VALID_STATUSES: BlogPostStatus[] = ["draft", "published", "archived"];

// GET /api/marketplace/blog/[slug] — fetch one blog post by slug OR UUID id.
// As a side effect of the read, the post's views_count is bumped by 1 (so
// analytics are accurate for anonymous reads as well as signed-in reads).
async function _get(req: NextRequest, ctx: RouteCtx) {
  // Allow anonymous reads — the blog is a public marketing surface. If a
  // portal session exists, we still bump the views counter the same way.
  const access = await getPortalSessionAccess();
  // If the portal session is missing we don't 401 here — the public blog
  // is browseable without authentication. Author-only operations (PUT)
  // below still require an authenticated portal session.
  const { slug } = await ctx.params;
  try {
    const post = await getBlogPost(slug);
    if (!post) {
      return NextResponse.json({ error: "Blog post not found." }, { status: 404 });
    }
    // Hide drafts / archived posts from anonymous callers. Signed-in
    // callers can read their own drafts (author_partner_id matches).
    if (post.status !== "published") {
      if (!access || access.partner_id !== post.author_partner_id) {
        return NextResponse.json({ error: "Blog post not found." }, { status: 404 });
      }
    }
    // Best-effort view counter bump (non-blocking).
    incrementViews(slug).catch((e) => {
      console.error("[marketplace.community.blog.get] view bump failed:", e);
    });
    return NextResponse.json(post);
  } catch (e: any) {
    console.error("[marketplace.community.blog.get]", e);
    return NextResponse.json({ error: "Failed to load blog post." }, { status: 500 });
  }
}

// PUT /api/marketplace/blog/[slug] — update a blog post (author only).
async function _put(req: NextRequest, ctx: RouteCtx) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { slug } = await ctx.params;

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (body.title !== undefined && (typeof body.title !== "string" || body.title.length < 3 || body.title.length > 200)) {
    return NextResponse.json({ error: "title must be 3–200 chars." }, { status: 400 });
  }
  if (body.body !== undefined && (typeof body.body !== "string" || body.body.length < 1 || body.body.length > 100_000)) {
    return NextResponse.json({ error: "body must be 1–100000 chars." }, { status: 400 });
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
    const updated = await updateBlogPost(slug, access.partner_id, {
      title: body.title,
      body: body.body,
      excerpt: body.excerpt ?? undefined,
      cover_image_url: body.cover_image_url ?? undefined,
      tags: Array.isArray(body.tags) ? body.tags : undefined,
      status: body.status ?? undefined,
    });
    if (!updated) {
      return NextResponse.json({ error: "Blog post not found." }, { status: 404 });
    }
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.blog_post_updated",
        "marketplace_blog_posts",
        updated.id,
        { status: updated.status },
      );
    } catch (e) {
      console.error("[marketplace.community.blog.update] audit failed:", e);
    }
    return NextResponse.json(updated);
  } catch (e: any) {
    console.error("[marketplace.community.blog.update]", e);
    const msg = sanitizeError(e);
    const status = /authorised/i.test(msg) ? 403 : /invalid|must be/i.test(msg) ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/blog/[slug]");
export const PUT = withApm(_put, "PUT /api/marketplace/blog/[slug]");
