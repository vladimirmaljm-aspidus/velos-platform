import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/marketplace/categories
//
// Returns the full marketplace_categories list ordered by sort_order then
// name. Parent/child relationships are returned flat — the UI rebuilds the
// tree by parent_id.
//
// Auth: super_admin only.
// ─────────────────────────────────────────────────────────────────────────────
async function _get(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("marketplace_categories")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });
    if (error) throw error;

    return NextResponse.json({ items: (data as any[]) || [] });
  } catch (e: any) {
    console.error("[admin.marketplace.categories] GET failed:", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/marketplace/categories — create a new category.
//
// Body:
//   { name: string, slug?: string, parent_id?: string, icon?: string,
//     is_featured?: boolean, is_active?: boolean, sort_order?: number }
//
// When slug is omitted, it's derived from the name (lowercased, spaces → '-').
// Auth: super_admin only.
// ─────────────────────────────────────────────────────────────────────────────
async function _post(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body?.name || typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "name is required." }, { status: 400 });
  }

  const name = body.name.trim();
  const slug = (body.slug?.trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")) || name.toLowerCase().replace(/\s+/g, "-");

  try {
    const sb = getSupabase();
    const payload = {
      name,
      slug,
      parent_id: body.parent_id || null,
      icon: body.icon || null,
      sort_order: Number(body.sort_order ?? 0) || 0,
      is_featured: body.is_featured === true,
      is_active: body.is_active !== false,
    };
    const { data, error } = await sb
      .from("marketplace_categories")
      .insert(payload)
      .select()
      .single();
    if (error) {
      if (/duplicate key|unique/i.test(error.message)) {
        return NextResponse.json(
          { error: "A category with that slug already exists." },
          { status: 409 },
        );
      }
      throw error;
    }

    try {
      await audit(
        auth.store,
        { id: auth.user.id, username: auth.user.username, tenant_id: null },
        req,
        "marketplace.category_created",
        "marketplace_categories",
        (data as any)?.id,
        { name, slug, admin: auth.user.username },
      );
    } catch (e) {
      console.error("[admin.marketplace.categories] audit failed:", e);
    }

    return NextResponse.json({ category: data });
  } catch (e: any) {
    console.error("[admin.marketplace.categories] POST failed:", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/admin/marketplace/categories?id=<category_id>
//
// Updates a category. Body can include any subset of:
//   { name?, slug?, parent_id?, icon?, sort_order?, is_featured?, is_active? }
//
// Auth: super_admin only.
// ─────────────────────────────────────────────────────────────────────────────
async function _put(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const categoryId = url.searchParams.get("id");
  if (!categoryId) {
    return NextResponse.json({ error: "id query param is required." }, { status: 400 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Strip read-only / dangerous fields — the route always owns these.
  const { id: _id, created_at: _c, updated_at: _u, ...fields } = body || {};
  void _id; void _c; void _u;

  // Coerce booleans + numbers.
  const patch: Record<string, unknown> = {};
  if (typeof fields.name === "string") patch.name = fields.name.trim();
  if (typeof fields.slug === "string") patch.slug = fields.slug.trim();
  if (fields.parent_id !== undefined) patch.parent_id = fields.parent_id || null;
  if (typeof fields.icon === "string") patch.icon = fields.icon || null;
  if (fields.sort_order !== undefined) patch.sort_order = Number(fields.sort_order) || 0;
  if (typeof fields.is_featured === "boolean") patch.is_featured = fields.is_featured;
  if (typeof fields.is_active === "boolean") patch.is_active = fields.is_active;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No updatable fields provided." }, { status: 400 });
  }

  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("marketplace_categories")
      .update(patch)
      .eq("id", categoryId)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return NextResponse.json({ error: "Category not found." }, { status: 404 });
    }

    try {
      await audit(
        auth.store,
        { id: auth.user.id, username: auth.user.username, tenant_id: null },
        req,
        "marketplace.category_updated",
        "marketplace_categories",
        categoryId,
        { patch, admin: auth.user.username },
      );
    } catch (e) {
      console.error("[admin.marketplace.categories] audit failed:", e);
    }

    return NextResponse.json({ category: data });
  } catch (e: any) {
    console.error("[admin.marketplace.categories] PUT failed:", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/admin/marketplace/categories?id=<category_id>
//
// Deletes a category. ON DELETE SET NULL on the parent_id FK means children
// of a deleted parent are re-rooted to the top level. Posts that referenced
// the deleted category by name still carry the free-text product_category
// string — they are unaffected (the new admin can recreate the category if
// the legacy posts need to be bucketed again).
//
// Auth: super_admin only.
// ─────────────────────────────────────────────────────────────────────────────
async function _del(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const categoryId = url.searchParams.get("id");
  if (!categoryId) {
    return NextResponse.json({ error: "id query param is required." }, { status: 400 });
  }

  try {
    const sb = getSupabase();
    const { data: cat, error: fErr } = await sb
      .from("marketplace_categories")
      .select("id, name, slug")
      .eq("id", categoryId)
      .maybeSingle();
    if (fErr) throw fErr;
    if (!cat) {
      return NextResponse.json({ error: "Category not found." }, { status: 404 });
    }

    const { error: delErr } = await sb
      .from("marketplace_categories")
      .delete()
      .eq("id", categoryId);
    if (delErr) throw delErr;

    try {
      await audit(
        auth.store,
        { id: auth.user.id, username: auth.user.username, tenant_id: null },
        req,
        "marketplace.category_deleted",
        "marketplace_categories",
        categoryId,
        { name: (cat as any).name, slug: (cat as any).slug, admin: auth.user.username },
      );
    } catch (e) {
      console.error("[admin.marketplace.categories] audit failed:", e);
    }

    return NextResponse.json({ ok: true, deleted: categoryId });
  } catch (e: any) {
    console.error("[admin.marketplace.categories] DELETE failed:", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/admin/marketplace/categories");
export const POST = withApm(_post, "POST /api/admin/marketplace/categories");
export const PUT = withApm(_put, "PUT /api/admin/marketplace/categories");
export const DELETE = withApm(_del, "DELETE /api/admin/marketplace/categories");
