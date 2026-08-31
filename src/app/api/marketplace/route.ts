import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { validateStatusTransition } from "@/lib/api/status-validator";
import { listMarketplacePosts, createMarketplacePost } from "@/lib/data/marketplace-store";
import { sanitizeFields } from "@/lib/security/sanitize-input";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { triggerWebhooks } from "@/lib/webhooks/deliver";
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
  // AUDIT4-PATHS / Fix 1 — gate marketplace POST on KYC approval. The
  // audit task spec requires `requireKycApproved` on marketplace
  // POST/PUT (not GET). Every other marketplace creation route
  // (responses, negotiations, contract, finance, reviews) already gates
  // on KYC; the top-level POST that creates the post itself was missing
  // the gate, so a partner with unapproved KYC could publicly list
  // buy/sell/auction/contract posts. requireKycApproved returns null
  // when allowed; a 403/503 NextResponse when blocked (503 = fail-closed
  // on transient DB errors).
  const _kycBlock = await requireKycApproved(access);
  if (_kycBlock) return _kycBlock;

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
  // AUDIT4-PATHS / Fix 3 — marketplace post state machine. A new row
  // conceptually starts in "draft"; the only valid create transition is
  // draft → active. Block attempts to create a post directly in a non-
  // active state (e.g. status="closed" / "expired" / "flagged"), which
  // would bypass the lifecycle entirely. The store defaults body.status
  // to "active" when omitted (createMarketplacePost line 301), so we
  // validate draft → (body.status ?? "active"). A same-status
  // transition (draft → draft) is always allowed by the validator.
  // Portal clients are NEVER super-admins, so the bypass documented in
  // status-validator.ts's header does not apply here.
  {
    const _createStatus = body.status ?? "active";
    const _createTransition = validateStatusTransition("marketplace_post", "draft", _createStatus);
    if (!_createTransition.valid) {
      return NextResponse.json(
        { error: _createTransition.error },
        { status: 409 },
      );
    }
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
      // Phase 12 — fire marketplace.post_created webhook (fire-and-forget
      // — a webhook failure must NOT block the post creation response).
      // The triggerWebhooks() helper sanitises PII from the payload
      // before signing + sending, so no partner PII leaks.
      void triggerWebhooks(store, access.tenant_id, "marketplace.post_created", "marketplace_post", created.id, {
        id: created.id,
        post_type: created.post_type,
        product_name: created.product_name,
        product_category: created.product_category,
        quantity: created.quantity,
        unit: created.unit,
        currency: created.currency,
        target_price: created.target_price,
        delivery_country: created.delivery_country,
        status: created.status,
        visibility: created.visibility,
        created_at: created.created_at,
      }).catch(() => {});
    } catch (e) {
      console.error("[marketplace.create] audit failed:", e);
    }
    return NextResponse.json(created);
  } catch (e: any) {
    console.error("[marketplace.create]", e);
    return NextResponse.json({ error: sanitizeError(e)}, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace");
export const POST = withApm(_post, "POST /api/marketplace");
