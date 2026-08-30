import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
// 8c-2: KYC gate — mirror top-level marketplace POST route. Without this,
// a portal client whose KYC is `rejected` / `suspended` could still create
// shipments / sign trade documents / post community content — binding
// commitments that affect counterparty's downstream flows.
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import {
  createGroup,
  listGroups,
  slugify,
} from "@/lib/data/marketplace-community-store";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/groups — list community groups.
// Optional query: ?category=&search=&joined=1&limit=50&offset=0
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  try {
    const url = new URL(req.url);
    const category = url.searchParams.get("category") || undefined;
    const search = url.searchParams.get("search") || undefined;
    const joined = url.searchParams.get("joined") === "1";
    const limit = url.searchParams.get("limit");
    const offset = url.searchParams.get("offset");
    const items = await listGroups({
      category,
      search,
      joinedPartnerId: joined ? access.partner_id : undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return NextResponse.json(items);
  } catch (e: any) {
    console.error("[marketplace.community.groups.list]", e);
    return NextResponse.json({ error: "Failed to load groups." }, { status: 500 });
  }
}

// POST /api/marketplace/groups — create a community group.
// Body: { name, slug?, description?, category?, is_private? }
// `slug` is auto-derived from `name` when not supplied.
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

  if (typeof body.name !== "string" || body.name.length < 2 || body.name.length > 120) {
    return NextResponse.json({ error: "name must be 2–120 chars." }, { status: 400 });
  }

  // Slug: prefer body.slug; fall back to a slugified name.
  let slug: string | undefined = typeof body.slug === "string" ? body.slug : undefined;
  if (!slug) slug = slugify(body.name);
  if (typeof slug !== "string" || slug.length < 2 || slug.length > 80) {
    return NextResponse.json({ error: "slug must be 2–80 chars of lowercase letters/digits/hyphens." }, { status: 400 });
  }

  if (body.description && (typeof body.description !== "string" || body.description.length > 2000)) {
    return NextResponse.json({ error: "description must be ≤ 2000 chars." }, { status: 400 });
  }
  if (body.category && (typeof body.category !== "string" || body.category.length > 60)) {
    return NextResponse.json({ error: "category must be ≤ 60 chars." }, { status: 400 });
  }

  try {
    const created = await createGroup(access.partner_id, {
      name: body.name,
      slug,
      description: body.description ?? null,
      category: body.category ?? null,
      is_private: Boolean(body.is_private),
    });
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.group_created",
        "marketplace_groups",
        created.id,
        { slug: created.slug, name: created.name },
      );
    } catch (e) {
      console.error("[marketplace.community.groups.create] audit failed:", e);
    }
    return NextResponse.json(created, { status: 201 });
  } catch (e: any) {
    console.error("[marketplace.community.groups.create]", e);
    const msg = e?.message || "Failed to create group.";
    const status = /authorised/i.test(msg) ? 403
      : /slug|name|invalid|must be/i.test(msg) ? 400
      : /unique/i.test(msg) ? 409
      : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/groups");
export const POST = withApm(_post, "POST /api/marketplace/groups");
