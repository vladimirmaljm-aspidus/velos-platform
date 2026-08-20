import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { listMarketplacePosts, createMarketplacePost } from "@/lib/data/marketplace-store";
import { sanitizeFields } from "@/lib/security/sanitize-input";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace — list public marketplace posts (active + public).
// Query params:
//   ?type=buy|sell|auction|contract
//   ?category=<product_category>
//   ?country=<ISO 3166-1 alpha-2>
//   ?search=<free text on product_name + description>
//   ?sort=recent|price_asc|price_desc|popular|ending_soon
//   ?limit=24  (max 100)
//   ?offset=0
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const url = new URL(req.url);
  const filters = {
    post_type: url.searchParams.get("type") || undefined,
    category: url.searchParams.get("category") || undefined,
    country: url.searchParams.get("country") || undefined,
    search: url.searchParams.get("search") || undefined,
    sort: url.searchParams.get("sort") || undefined,
    limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
    offset: url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : undefined,
  };
  try {
    const result = await listMarketplacePosts(access.tenant_id, filters);
    return NextResponse.json(result);
  } catch (e: any) {
    console.error("[marketplace.list]", e);
    return NextResponse.json({ error: "Failed to load marketplace posts." }, { status: 500 });
  }
}

// POST /api/marketplace — create a new post (buy/sell/auction/contract).
// tenant_id / partner_id / portal_access_id are stamped from the auth
// context — body-supplied values are ignored.
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

  // Validate required fields.
  if (!body.product_name || typeof body.product_name !== "string" || body.product_name.trim().length === 0) {
    return NextResponse.json({ error: "Product name is required." }, { status: 400 });
  }
  if (body.product_name.length > 500) {
    return NextResponse.json({ error: "Product name is too long (max 500 chars)." }, { status: 400 });
  }
  const qty = Number(body.quantity);
  if (!Number.isFinite(qty) || qty <= 0 || qty > 1_000_000_000) {
    return NextResponse.json({ error: "Quantity must be a positive number." }, { status: 400 });
  }
  body.quantity = qty;

  // Validate optional numeric fields.
  if (body.target_price !== undefined && body.target_price !== null && body.target_price !== "") {
    const p = Number(body.target_price);
    if (!Number.isFinite(p) || p < 0 || p > 1_000_000_000) {
      return NextResponse.json({ error: "Target price must be a non-negative number." }, { status: 400 });
    }
    body.target_price = p;
  }
  if (body.price_max !== undefined && body.price_max !== null && body.price_max !== "") {
    const p = Number(body.price_max);
    if (!Number.isFinite(p) || p < 0 || p > 1_000_000_000) {
      return NextResponse.json({ error: "Price max must be a non-negative number." }, { status: 400 });
    }
    body.price_max = p;
  }

  // Validate enums.
  const allowedTypes = ["buy", "sell", "auction", "contract"];
  if (body.post_type && !allowedTypes.includes(body.post_type)) {
    return NextResponse.json({ error: "Invalid post_type." }, { status: 400 });
  }
  const allowedPriceTypes = ["fixed", "range", "on_request"];
  if (body.price_type && !allowedPriceTypes.includes(body.price_type)) {
    return NextResponse.json({ error: "Invalid price_type." }, { status: 400 });
  }
  const allowedStatus = ["draft", "active", "closed", "expired", "flagged"];
  if (body.status && !allowedStatus.includes(body.status)) {
    return NextResponse.json({ error: "Invalid status." }, { status: 400 });
  }
  const allowedVisibility = ["public", "private"];
  if (body.visibility && !allowedVisibility.includes(body.visibility)) {
    return NextResponse.json({ error: "Invalid visibility." }, { status: 400 });
  }

  // XSS prevention on free-text fields.
  body = sanitizeFields(body, [
    "product_name",
    "product_category",
    "product_subcategory",
    "delivery_location",
    "delivery_country",
    "incoterm",
    "origin_country",
    "packaging",
    "payment_terms",
    "description",
    "unit",
    "currency",
  ]);

  // Strip caller-supplied identity fields — they're stamped from the
  // auth context to prevent spoofing.
  delete body.id;
  delete body.tenant_id;
  delete body.partner_id;
  delete body.portal_access_id;
  delete body.views_count;
  delete body.responses_count;
  delete body.is_verified;
  delete body.verification_level;
  delete body.created_at;
  delete body.updated_at;

  try {
    const created = await createMarketplacePost(
      access.tenant_id,
      access.partner_id,
      access.id,
      body,
    );
    // Audit the creation.
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.post_created",
        "marketplace_post",
        created.id,
        { post_type: created.post_type, product_name: created.product_name, quantity: created.quantity },
      );
    } catch (e) {
      console.error("[marketplace.create] audit failed:", e);
    }
    return NextResponse.json(created);
  } catch (e: any) {
    console.error("[marketplace.create]", e);
    return NextResponse.json({ error: e.message || "Failed to create post." }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace");
export const POST = withApm(_post, "POST /api/marketplace");
