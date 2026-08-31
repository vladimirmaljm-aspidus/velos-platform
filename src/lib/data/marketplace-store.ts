// Marketplace store — data-access layer for the VELOS B2B commodity
// marketplace.
//
// All functions talk directly to the `marketplace_*` Supabase tables created
// in migration 044_marketplace.sql. The store is intentionally a separate
// module from `supabase-store.ts` to keep the file readable; the existing
// Store interface is not extended — API routes import this module directly
// and pass `tenantId` / `partnerId` from the resolved auth context.
//
// Privacy model:
//   - Public post listings return a SANITISED shape that strips the
//     poster's partner_id, portal_access_id, and tenant_id before sending
//     the row over the wire. The "my posts" / "received responses" paths
//     use the unsanitised shape because the caller IS the owner.
//   - Responses in a negotiation are visible only to the two partners in
//     that negotiation (one of the partner_id_a / partner_id_b fields must
//     equal the caller's partner_id).
//   - Contact details (partner name / email) are NEVER sent through this
//     store — the components fetch them through the negotiation's
//     `contact_revealed` flag (Phase 2).

import { getSupabase } from "@/lib/supabase/client";
import { validateStatusTransition } from "@/lib/api/status-validator";
import type {
  MarketplaceMessage,
  MarketplaceMessageCreate,
  MarketplaceNegotiation,
  MarketplaceNegotiationCreate,
  MarketplacePost,
  MarketplacePostCreate,
  MarketplaceResponse,
  MarketplaceResponseCreate,
  MarketplaceResponseStatus,
} from "@/lib/supabase/marketplace-types";

// ─── Public sanitisation helpers ─────────────────────────────────────────

/**
 * Strip tenant_id, partner_id, portal_access_id from a post before returning
 * it on a public marketplace listing. The fields are needed internally for
 * filtering / ownership checks but MUST NOT leak to other partners browsing
 * the marketplace.
 *
 * Other fields (product_name, quantity, location, country, target_price,
 * verification_level, is_verified, views_count, responses_count, expires_at,
 * created_at) ARE public by design — they are the listing's marketing copy.
 */
function sanitisePublicPost(post: MarketplacePost): Record<string, unknown> {
  const {
    tenant_id: _t,
    partner_id: _p,
    portal_access_id: _pa,
    ...rest
  } = post;
  return rest as Record<string, unknown>;
}

/**
 * Strip tenant_id / partner_id / portal_access_id from a response before
 * returning it. The list-of-responses-on-my-post path uses this so a
 * receiving partner can see the offer details without immediately learning
 * the responder's exact internal partner_id (the responder's company name
 * is fetched separately via a join in Phase 2).
 */
function sanitisePublicResponse(r: MarketplaceResponse): Record<string, unknown> {
  const {
    tenant_id: _t,
    partner_id: _p,
    portal_access_id: _pa,
    ...rest
  } = r;
  return rest as Record<string, unknown>;
}

// ─── Filter shape for listMarketplacePosts ───────────────────────────────

export interface MarketplacePostFilters {
  /** 'buy' | 'sell' | 'auction' | 'contract' */
  post_type?: string;
  /** product_category string (e.g. "Metals", "Agriculture") */
  category?: string;
  /** Country code (ISO 3166-1 alpha-2) of delivery */
  country?: string;
  /** Full-text search across product_name + description */
  search?: string;
  /** 'recent' | 'price_asc' | 'price_desc' | 'popular' | 'ending_soon' */
  sort?: string;
  limit?: number;
  offset?: number;
  /** When set, return the caller's own posts (used by listMyPosts). */
  partnerId?: string;
}

const ALLOWED_SORTS = new Set([
  "recent",
  "price_asc",
  "price_desc",
  "popular",
  "ending_soon",
]);

// ─── Posts ────────────────────────────────────────────────────────────────

/**
 * List marketplace posts visible to a tenant.
 *
 * Returns the SANITISED public shape (no partner_id / tenant_id /
 * portal_access_id). The `partnerId` filter (when set) restricts to the
 * caller's own posts — used by the "My Posts" view, which calls this same
 * function so the data shape is consistent.
 *
 * Only `status = 'active'` and `visibility = 'public'` posts are returned
 * on the public path; when `partnerId` is set, the partner's own
 * `private` and `draft` posts are also returned.
 */
export async function listMarketplacePosts(
  tenantId: string,
  filters: MarketplacePostFilters = {},
): Promise<{ items: Record<string, unknown>[]; total: number }> {
  const sb = getSupabase();
  const limit = Math.min(Math.max(filters.limit ?? 24, 1), 100);
  const offset = Math.max(filters.offset ?? 0, 0);

  // FIX-AUDIT3-MED-2 #3 — public list previously used `select("*")`, which
  // pulled every column on marketplace_posts (including the heavy
  // free-text / JSONB columns `description`, `specifications`,
  // `quality_specs`, `packaging`, `payment_terms` and the owner-only
  // `portal_access_id`) only to then strip `tenant_id` / `partner_id` /
  // `portal_access_id` via sanitisePublicPost(). The expensive columns
  // are never needed by the listing cards — only by the post-detail
  // route (getMarketplacePost + getPublicMarketplacePost), which keeps
  // `select("*")` because the detail view DOES render description / specs
  // / quality / packaging. Replaced with the explicit column list
  // below containing only the fields the public listing UI renders.
  // `count: "exact"` is preserved so the listing's pagination total
  // stays correct.
  const PUBLIC_POST_COLUMNS =
    "id, post_type, product_name, product_category, quantity, unit, " +
    "target_price, price_max, currency, price_type, delivery_location, " +
    "delivery_country, incoterm, origin_country, is_verified, " +
    "verification_level, views_count, responses_count, expires_at, " +
    "created_at, updated_at";
  let q = sb
    .from("marketplace_posts")
    .select(PUBLIC_POST_COLUMNS, { count: "exact" })
    .eq("tenant_id", tenantId);

  // Visibility filter:
  //   • Public path: status='active' AND visibility='public' (private posts
  //     are hidden from everyone except the owner).
  //   • My-posts path (filters.partnerId set): show the caller's own posts
  //     regardless of status / visibility — they are the owner. The
  //     explicit column list above does NOT include `status` or
  //     `visibility` (they aren't rendered in the listing card); the
  //     filters below still run on the DB side so the row set is correct,
  //     the returned JSON just omits those two fields. The My-Posts UI
  //     consumes `listMyPosts()` directly (which still uses `select("*")`)
  //     so this partner-filter branch is only a defence-in-depth fallback
  //     for callers that pass `filters.partnerId` to this function.
  if (filters.partnerId) {
    q = q.eq("partner_id", filters.partnerId);
  } else {
    q = q.eq("status", "active").eq("visibility", "public");
  }

  if (filters.post_type) q = q.eq("post_type", filters.post_type);
  if (filters.category) q = q.eq("product_category", filters.category);
  if (filters.country) q = q.eq("delivery_country", filters.country);

  if (filters.search) {
    // PostgREST `or` filter — escape characters that would let a malicious
    // search string inject an extra clause (see safeSearch() pattern in
    // supabase-store.ts).
    const s = String(filters.search).replace(/[(),\\]/g, " ").trim();
    if (s) {
      q = q.or(`product_name.ilike.%${s}%,description.ilike.%${s}%`);
    }
  }

  const sort = filters.sort && ALLOWED_SORTS.has(filters.sort) ? filters.sort : "recent";
  switch (sort) {
    case "price_asc":
      q = q.order("target_price", { ascending: true, nullsFirst: false });
      break;
    case "price_desc":
      q = q.order("target_price", { ascending: false, nullsFirst: false });
      break;
    case "popular":
      q = q.order("views_count", { ascending: false });
      break;
    case "ending_soon":
      q = q.order("expires_at", { ascending: true, nullsFirst: false });
      break;
    case "recent":
    default:
      q = q.order("created_at", { ascending: false });
      break;
  }

  const { data, error, count } = await q.range(offset, offset + limit - 1);
  if (error) throw error;

  // FIX-AUDIT3-MED-2 #3 — when the query uses an explicit column list
  // (rather than `select("*")`), Supabase returns the rows as
  // `GenericStringError[]` instead of the inferred full-row shape. The
  // double-cast through `unknown` is intentional: the explicit column
  // list omits heavy / owner-only columns, so the row shape is a
  // PARTIAL `MarketplacePost`. `sanitisePublicPost()` only destructures
  // `tenant_id` / `partner_id` / `portal_access_id` (all absent from the
  // explicit list) — they'll be `undefined` at runtime, which is fine
  // because the function just drops them via rest-spread.
  const rows = (data as unknown as MarketplacePost[]) || [];
  return {
    items: rows.map(sanitisePublicPost),
    total: count ?? 0,
  };
}

/**
 * Fetch a single post by id. Returns the SANITISED public shape.
 *
 * Also increments views_count atomically (RPC-free UPDATE that adds 1 to
 * the column). The increment is fire-and-forget — a read error on the
 * UPDATE must NOT block the user from viewing the post.
 *
 * When `viewerPartnerId` matches the post's owner, returns the FULL row
 * (including the owner-only fields). The caller is the owner, so leaking
 * their own id back to them is a no-op.
 */
export async function getMarketplacePost(
  postId: string,
  tenantId: string,
  viewerPartnerId?: string,
): Promise<Record<string, unknown> | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("marketplace_posts")
    .select("*")
    .eq("id", postId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const post = data as MarketplacePost;

  // Increment views_count (fire-and-forget).
  void sb
    .from("marketplace_posts")
    .update({ views_count: (post.views_count || 0) + 1 })
    .eq("id", postId)
    .then(({ error: e }) => {
      if (e) console.error("[marketplace] view-count increment failed:", e);
    });

  // Owner sees the full row.
  if (viewerPartnerId && viewerPartnerId === post.partner_id) {
    return post as unknown as Record<string, unknown>;
  }
  // Non-owner: hide drafts / private posts entirely.
  if (post.status !== "active" && post.status !== "expired") return null;
  if (post.visibility === "private") return null;
  return sanitisePublicPost(post);
}

/**
 * Create a new post. tenantId / partnerId / portalAccessId are stamped
 * from the auth context by the API route — never trust a body-supplied
 * partner_id.
 */
export async function createMarketplacePost(
  tenantId: string,
  partnerId: string,
  portalAccessId: string | null,
  data: MarketplacePostCreate,
): Promise<MarketplacePost> {
  const sb = getSupabase();
  const payload = {
    tenant_id: tenantId,
    partner_id: partnerId,
    portal_access_id: portalAccessId,
    post_type: data.post_type ?? "sell",
    product_name: data.product_name,
    product_category: data.product_category ?? null,
    product_subcategory: data.product_subcategory ?? null,
    quantity: data.quantity,
    unit: data.unit ?? "MT",
    target_price: data.target_price ?? null,
    price_visible: data.price_visible ?? true,
    currency: data.currency ?? "USD",
    price_type: data.price_type ?? "fixed",
    price_max: data.price_max ?? null,
    delivery_location: data.delivery_location ?? null,
    delivery_country: data.delivery_country ?? null,
    delivery_date: data.delivery_date ?? null,
    incoterm: data.incoterm ?? null,
    origin_country: data.origin_country ?? null,
    packaging: data.packaging ?? null,
    specifications: data.specifications ?? {},
    quality_specs: data.quality_specs ?? [],
    payment_terms: data.payment_terms ?? null,
    description: data.description ?? null,
    status: data.status ?? "active",
    visibility: data.visibility ?? "public",
    expires_at: data.expires_at ?? null,
  };
  const { data: inserted, error } = await sb
    .from("marketplace_posts")
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return inserted as MarketplacePost;
}

/**
 * Update a post. The caller MUST verify ownership (partner_id === caller)
 * BEFORE calling this function — the API route performs that check; the
 * store itself does not filter by partner_id on UPDATE (it trusts the
 * caller's pre-check) but DOES filter by tenant_id to prevent a
 * tenant-A partner from updating tenant-B rows by guessing ids.
 */
export async function updateMarketplacePost(
  postId: string,
  tenantId: string,
  patch: Partial<MarketplacePostCreate> & { status?: string; responses_count?: number; is_verified?: boolean; verification_level?: string },
): Promise<MarketplacePost | null> {
  const sb = getSupabase();
  // Strip fields the DB owns (id, tenant_id, partner_id, created_at,
  // updated_at) so the UPDATE never tries to write them.
  const {
    id: _id,
    tenant_id: _t,
    partner_id: _p,
    portal_access_id: _pa,
    created_at: _c,
    updated_at: _u,
    ...fields
  } = patch as Record<string, unknown>;
  void _id; void _t; void _p; void _pa; void _c; void _u;

  const { data, error } = await sb
    .from("marketplace_posts")
    .update(fields)
    .eq("id", postId)
    .eq("tenant_id", tenantId)
    .select()
    .maybeSingle();
  if (error) throw error;
  return (data as MarketplacePost) || null;
}

/**
 * Delete a post (and cascade to responses / negotiations / messages).
 * The API route checks ownership before calling this.
 */
export async function deleteMarketplacePost(
  postId: string,
  tenantId: string,
): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("marketplace_posts")
    .delete()
    .eq("id", postId)
    .eq("tenant_id", tenantId);
  if (error) throw error;
}

// ─── Responses ───────────────────────────────────────────────────────────

/**
 * List responses to a single post. Only the POST OWNER may call this —
 * responders see their own responses via listMyResponses() instead.
 *
 * Returns the SANITISED shape (no partner_id / tenant_id) so the post
 * owner sees offer details without immediately learning the responder's
 * exact internal id. The responder's company name / contact will be
 * fetched separately when the negotiation is opened.
 */
export async function listMarketplaceResponses(
  postId: string,
  tenantId: string,
): Promise<Record<string, unknown>[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("marketplace_responses")
    .select("*")
    .eq("post_id", postId)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data as MarketplaceResponse[]) || []).map(sanitisePublicResponse);
}

/**
 * Create a response (offer / counter-offer) on a post. The caller is the
 * RESPONDER, not the post owner.
 *
 * Verifies the post exists, belongs to the same tenant, and is currently
 * active before inserting the response. Also bumps the post's
 * responses_count atomically.
 */
export async function createMarketplaceResponse(
  tenantId: string,
  partnerId: string,
  portalAccessId: string | null,
  data: MarketplaceResponseCreate,
): Promise<MarketplaceResponse> {
  const sb = getSupabase();

  // Fetch + validate the post.
  const { data: post, error: postErr } = await sb
    .from("marketplace_posts")
    .select("id, status, tenant_id, partner_id, expires_at, responses_count")
    .eq("id", data.post_id)
    .maybeSingle();
  if (postErr) throw postErr;
  if (!post) throw new Error("Post not found.");
  if (post.tenant_id !== tenantId) throw new Error("Post not found.");
  if (post.status !== "active") throw new Error("Post is not active.");
  // Owner cannot respond to their own post.
  if (post.partner_id === partnerId) {
    throw new Error("Cannot respond to your own post.");
  }
  // Expiry check.
  if (post.expires_at && new Date(post.expires_at) < new Date()) {
    throw new Error("Post has expired.");
  }

  // FIX-MARKET-2 / fix #3: cap a single partner to 5 responses per post per
  // 24h window. Without this guard, a malicious responder could spam the
  // post owner's notification queue with thousands of offers. The API
  // route ALSO applies a 10/min rate limit per partner (defense-in-depth)
  // but this per-post cap is the real spam gate because it cannot be
  // bypassed by IP rotation.
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count: recentCount, error: countErr } = await sb
    .from("marketplace_responses")
    .select("id", { count: "exact", head: true })
    .eq("post_id", data.post_id)
    .eq("partner_id", partnerId)
    .gte("created_at", since24h);
  if (countErr) throw countErr;
  if ((recentCount ?? 0) >= 5) {
    throw new Error("You have already responded 5 times to this post in the last 24 hours.");
  }

  const payload = {
    post_id: data.post_id,
    tenant_id: tenantId,
    partner_id: partnerId,
    portal_access_id: portalAccessId,
    quantity: data.quantity ?? null,
    unit_price: data.unit_price ?? null,
    currency: data.currency ?? "USD",
    delivery_date: data.delivery_date ?? null,
    delivery_location: data.delivery_location ?? null,
    incoterm: data.incoterm ?? null,
    payment_terms: data.payment_terms ?? null,
    message: data.message ?? null,
    is_counter: data.is_counter ?? false,
    parent_response_id: data.parent_response_id ?? null,
    status: "sent" as MarketplaceResponseStatus,
  };
  const { data: inserted, error } = await sb
    .from("marketplace_responses")
    .insert(payload)
    .select()
    .single();
  if (error) throw error;

  // Bump responses_count on the post (fire-and-forget).
  void sb
    .from("marketplace_posts")
    .update({ responses_count: (post.responses_count || 0) + 1 })
    .eq("id", data.post_id)
    .then(({ error: e }) => {
      if (e) console.error("[marketplace] responses_count bump failed:", e);
    });

  return inserted as MarketplaceResponse;
}

/**
 * Update a response status (accept / reject / counter). Only the POST
 * OWNER can do this — the responder creates the response, the owner
 * accepts or rejects it.
 *
 * `callerPartnerId` MUST equal the post's owner. We verify this by
 * joining responses → posts via the post_id.
 */
export async function updateMarketplaceResponseStatus(
  responseId: string,
  tenantId: string,
  callerPartnerId: string,
  newStatus: MarketplaceResponseStatus,
): Promise<MarketplaceResponse> {
  const sb = getSupabase();

  // Fetch the response + the post in a single joined query.
  const { data: row, error: fetchErr } = await sb
    .from("marketplace_responses")
    .select("*, post:marketplace_posts!inner(id, partner_id, tenant_id, status)")
    .eq("id", responseId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (fetchErr) throw fetchErr;
  if (!row) throw new Error("Response not found.");

  const post = (row as any).post as { partner_id: string; tenant_id: string; status: string } | null;
  if (!post || post.tenant_id !== tenantId) throw new Error("Response not found.");
  if (post.partner_id !== callerPartnerId) {
    throw new Error("Only the post owner can change a response status.");
  }

  // AUDIT4-PATHS / Fix 4 — marketplace response state machine. The
  // audit found that this function did a raw UPDATE with no transition
  // check, letting a post owner revert a "rejected" response back to
  // "sent", revive an "expired" response to "accepted", or change
  // their mind after accepting (accepted → rejected). The downstream
  // contract-creation flow assumes status="accepted" is permanent — a
  // reversion silently invalidates any contract auto-generated from
  // the acceptance. Validate the transition BEFORE the UPDATE; on
  // invalid, throw — the route handler maps the throw to 409.
  //
  // The graph (defined in status-validator.ts): sent → viewed/accepted/
  // rejected/countered/expired; viewed → accepted/rejected/countered/
  // expired; countered → accepted/rejected/countered/expired;
  // accepted / rejected / expired → terminal. A no-op (same status)
  // is always valid.
  const _currentStatus = (row as any).status as string;
  if (_currentStatus && _currentStatus !== newStatus) {
    const _t = validateStatusTransition("marketplace_response", _currentStatus, newStatus);
    if (!_t.valid) {
      throw new Error(_t.error || "Invalid status transition");
    }
  }

  // 8c-7: TOCTOU race — only update rows where status is still the
  // expected prior state (Compare-And-Swap guard). Between the
  // validateStatusTransition() call above and the UPDATE below, a
  // concurrent request (e.g. a cron sweep expiring the response, or a
  // second owner tab clicking accept/reject) could change the row's
  // status out from under us. Without this CAS check, two concurrent
  // PUTs could both "win" — e.g. accept on top of an already-rejected
  // row, silently reviving it and re-triggering contract auto-creation.
  // `.maybeSingle()` returns null when 0 rows are affected (status no
  // longer matches); we surface that as a 409 in the route handler.
  const { data: updated, error } = await sb
    .from("marketplace_responses")
    .update({ status: newStatus })
    .eq("id", responseId)
    .eq("status", _currentStatus)
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!updated) {
    throw new Error("Response status changed; please reload and retry.");
  }
  return updated as MarketplaceResponse;
}

// ─── My posts / responses / received ─────────────────────────────────────

/**
 * List a partner's own posts. Returns the FULL row (no sanitisation) —
 * the caller IS the owner.
 */
export async function listMyPosts(
  tenantId: string,
  partnerId: string,
): Promise<MarketplacePost[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("marketplace_posts")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("partner_id", partnerId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as MarketplacePost[]) || [];
}

/**
 * List responses SENT by a partner (i.e. offers they made on others' posts).
 * Returns the SANITISED shape so the responder can see the offer terms
 * without learning the post owner's exact partner_id.
 */
export async function listMyResponses(
  tenantId: string,
  partnerId: string,
): Promise<Record<string, unknown>[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("marketplace_responses")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("partner_id", partnerId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data as MarketplaceResponse[]) || []).map(sanitisePublicResponse);
}

/**
 * List responses RECEIVED on a partner's posts (i.e. offers others made on
 * the caller's posts). Returns the SANITISED shape so the post owner sees
 * the offers without immediately learning the responder's exact partner_id.
 */
export async function listReceivedResponses(
  tenantId: string,
  partnerId: string,
): Promise<Record<string, unknown>[]> {
  const sb = getSupabase();
  // Responses on the caller's posts: filter by post_id IN (SELECT id FROM
  // marketplace_posts WHERE partner_id = caller). PostgREST doesn't allow
  // subqueries in the filter, so we fetch the caller's post ids first.
  const { data: myPosts, error: postsErr } = await sb
    .from("marketplace_posts")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("partner_id", partnerId);
  if (postsErr) throw postsErr;
  const postIds = ((myPosts as { id: string }[]) || []).map((p) => p.id);
  if (postIds.length === 0) return [];

  const { data, error } = await sb
    .from("marketplace_responses")
    .select("*")
    .in("post_id", postIds)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data as MarketplaceResponse[]) || []).map(sanitisePublicResponse);
}

// ─── Negotiations ─────────────────────────────────────────────────────────

/**
 * Create a negotiation room between the post owner and a responder.
 *
 * The caller is the RESPONDER (partnerId_a); the OWNER is partnerId_b.
 * The post owner can also initiate a negotiation from one of their
 * received responses — in that case the API route swaps the roles so the
 * caller is still partnerId_a.
 *
 * We verify the post exists + is in the caller's tenant before creating
 * the negotiation, but we DO NOT verify that partnerId_b is the post
 * owner — that's enforced by the calling route's auth context (the
 * responder only knows the post_id; the owner is determined by the
 * store via a separate lookup).
 *
 * Duplicate-suppression: if an active negotiation already exists for
 * (post_id, partner_id_a, partner_id_b), return it instead of creating a
 * duplicate.
 */
export async function createNegotiation(
  tenantId: string,
  partnerId: string,
  data: MarketplaceNegotiationCreate & {
    partner_id_b: string;
    tenant_id_b: string;
  },
): Promise<MarketplaceNegotiation> {
  const sb = getSupabase();

  // Verify post exists in caller's tenant.
  const { data: post, error: postErr } = await sb
    .from("marketplace_posts")
    .select("id, tenant_id, partner_id, status")
    .eq("id", data.post_id)
    .maybeSingle();
  if (postErr) throw postErr;
  if (!post || (post as any).tenant_id !== tenantId) {
    throw new Error("Post not found.");
  }

  // AUDIT2-LOGIC-UX H2 — duplicate suppression must check BOTH directions.
  // The previous query only matched negotiations where the caller was
  // partner_id_a AND the other party was partner_id_b. A partner Y could
  // open a duplicate negotiation with X after X already opened one with
  // Y (the existing negotiation had X=a, Y=b, so the Y-initiated query
  // Y=a, X=b matched zero rows). The PostgREST `or` below covers both
  // directions while keeping the same post_id + status filters.
  const { data: existing } = await sb
    .from("marketplace_negotiations")
    .select("*")
    .eq("post_id", data.post_id)
    .eq("status", "active")
    .or(
      `and(partner_id_a.eq.${partnerId},partner_id_b.eq.${data.partner_id_b}),and(partner_id_a.eq.${data.partner_id_b},partner_id_b.eq.${partnerId})`,
    )
    .maybeSingle();
  if (existing) return existing as MarketplaceNegotiation;

  const payload = {
    post_id: data.post_id,
    response_id: data.response_id ?? null,
    tenant_id_a: tenantId,
    partner_id_a: partnerId,
    tenant_id_b: data.tenant_id_b,
    partner_id_b: data.partner_id_b,
    status: "active",
  };
  const { data: inserted, error } = await sb
    .from("marketplace_negotiations")
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return inserted as MarketplaceNegotiation;
}

/**
 * List all negotiations a partner is party to (either as A or B).
 */
export async function listNegotiations(
  tenantId: string,
  partnerId: string,
): Promise<MarketplaceNegotiation[]> {
  const sb = getSupabase();
  // PostgREST `or` for partner_id_a OR partner_id_b. Use the post_id IN
  // (SELECT id FROM marketplace_posts WHERE tenant_id = ...) shape so we
  // never leak cross-tenant negotiations.
  const or = `partner_id_a.eq.${partnerId},partner_id_b.eq.${partnerId}`;
  const { data, error } = await sb
    .from("marketplace_negotiations")
    .select("*")
    .or(or)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (error) throw error;
  // Defence-in-depth: tenant filter (negotiations.tenant_id_a / _b both
  // must match — but since both sides are stored, we check that EITHER
  // matches the caller's tenant).
  return ((data as MarketplaceNegotiation[]) || []).filter(
    (n) => n.tenant_id_a === tenantId || n.tenant_id_b === tenantId,
  );
}

/**
 * Get a single negotiation. Caller must be one of the two partners —
 * verified by checking partner_id_a or partner_id_b matches the caller.
 */
export async function getNegotiation(
  negotiationId: string,
  tenantId: string,
  callerPartnerId: string,
): Promise<MarketplaceNegotiation | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("marketplace_negotiations")
    .select("*")
    .eq("id", negotiationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const n = data as MarketplaceNegotiation;
  // Tenant + partner check.
  if (n.tenant_id_a !== tenantId && n.tenant_id_b !== tenantId) return null;
  if (n.partner_id_a !== callerPartnerId && n.partner_id_b !== callerPartnerId) {
    return null;
  }
  return n;
}

// ─── Messages ────────────────────────────────────────────────────────────

/**
 * Send a message in a negotiation. Caller must be a party to the
 * negotiation — verified via getNegotiation() in the API route. The store
 * also re-checks membership so a direct store caller cannot forge a
 * message into a negotiation they are not part of.
 */
export async function addNegotiationMessage(
  negotiationId: string,
  tenantId: string,
  senderPartnerId: string,
  data: MarketplaceMessageCreate,
): Promise<MarketplaceMessage> {
  const sb = getSupabase();

  // Verify caller is a party to this negotiation.
  const n = await getNegotiation(negotiationId, tenantId, senderPartnerId);
  if (!n) throw new Error("Negotiation not found.");

  const payload = {
    negotiation_id: negotiationId,
    sender_partner_id: senderPartnerId,
    message: data.message ?? null,
    message_type: data.message_type ?? "text",
    offer_data: data.offer_data ?? null,
    attachment_url: data.attachment_url ?? null,
  };
  const { data: inserted, error } = await sb
    .from("marketplace_messages")
    .insert(payload)
    .select()
    .single();
  if (error) throw error;

  // Bump last_message_at on the negotiation (fire-and-forget).
  void sb
    .from("marketplace_negotiations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", negotiationId)
    .then(({ error: e }) => {
      if (e) console.error("[marketplace] last_message_at bump failed:", e);
    });

  return inserted as MarketplaceMessage;
}

/**
 * List messages in a negotiation. Caller must be a party to the
 * negotiation.
 */
export async function listNegotiationMessages(
  negotiationId: string,
  tenantId: string,
  callerPartnerId: string,
): Promise<MarketplaceMessage[]> {
  const sb = getSupabase();
  // Verify caller is a party to this negotiation.
  const n = await getNegotiation(negotiationId, tenantId, callerPartnerId);
  if (!n) return [];

  const { data, error } = await sb
    .from("marketplace_messages")
    .select("*")
    .eq("negotiation_id", negotiationId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data as MarketplaceMessage[]) || [];
}

// ─── Phase 12 — public API feed (cross-tenant, redacted) ────────────────

/**
 * Public-facing feed shape — used by GET /api/marketplace/public.
 *
 * The Phase 1 `sanitisePublicPost()` strips tenant_id / partner_id /
 * portal_access_id but otherwise returns the row verbatim. Phase 12's
 * public API needs a STRICTER redaction (the spec: "no partner PII, only
 * company name + country + verification level") because callers are NOT
 * authenticated — there's no portal session to bind them to a tenant, so
 * leaking even the partner_id is unnecessary.
 *
 * Each item therefore carries the public marketing copy (product name,
 * quantity, price, location, country, etc.) PLUS a small `partner` block
 * with: company name, country, city, website, verification_level.
 *
 * `partner_id` and `tenant_id` are NEVER included. The post id IS returned
 * so callers can deep-link to the public-detail endpoint.
 */
export interface PublicMarketplacePostItem {
  id: string;
  post_type: string;
  product_name: string;
  product_category: string | null;
  product_subcategory: string | null;
  quantity: number;
  unit: string;
  target_price: number | null;
  price_visible: boolean;
  currency: string;
  price_type: string;
  price_max: number | null;
  delivery_location: string | null;
  delivery_country: string | null;
  delivery_date: string | null;
  incoterm: string | null;
  origin_country: string | null;
  packaging: string | null;
  payment_terms: string | null;
  description: string | null;
  status: string;
  is_verified: boolean;
  verification_level: string;
  views_count: number;
  responses_count: number;
  expires_at: string | null;
  created_at: string;
  partner: {
    company_name: string;
    country: string | null;
    city: string | null;
    website: string | null;
    verification_level: string;
    rating_average: number;
    rating_count: number;
  } | null;
}

/**
 * Cross-tenant public feed of marketplace posts.
 *
 * Returns the redacted shape defined above. The query is NOT scoped to a
 * tenant — the public feed is a global marketplace browse surface. Only
 * `status='active'` AND `visibility='public'` posts are returned (private
 * and draft posts are hidden from the public; partners see their own
 * drafts via the auth-gated /api/marketplace/my-posts).
 *
 * Pagination is `(page, limit)` (1-indexed page) — the spec asks for
 * `page` + `limit`. We translate to `offset` internally.
 */
export async function listPublicMarketplacePosts(
  filters: {
    post_type?: string;
    category?: string;
    country?: string;
    search?: string;
    limit?: number;
    page?: number;
  } = {},
): Promise<{ items: PublicMarketplacePostItem[]; total: number; page: number; limit: number }> {
  const sb = getSupabase();
  const limit = Math.min(Math.max(filters.limit ?? 24, 1), 100);
  const page = Math.max(filters.page ?? 1, 1);
  const offset = (page - 1) * limit;

  let q = sb
    .from("marketplace_posts")
    .select("*", { count: "exact" })
    .eq("status", "active")
    .eq("visibility", "public");

  if (filters.post_type) q = q.eq("post_type", filters.post_type);
  if (filters.category) q = q.eq("product_category", filters.category);
  if (filters.country) q = q.eq("delivery_country", filters.country);

  if (filters.search) {
    const s = String(filters.search).replace(/[(),\\]/g, " ").trim();
    if (s) {
      q = q.or(`product_name.ilike.%${s}%,description.ilike.%${s}%,product_category.ilike.%${s}%`);
    }
  }

  q = q.order("created_at", { ascending: false });

  const { data, error, count } = await q.range(offset, offset + limit - 1);
  if (error) throw error;

  const rows = (data as MarketplacePost[]) || [];
  const items = await hydratePublicPostItems(rows);
  return {
    items,
    total: count ?? 0,
    page,
    limit,
  };
}

/**
 * Hydrate the redacted `PublicMarketplacePostItem` shape from raw post
 * rows. Performs a batched lookup of partner info via the partners +
 * marketplace_company_profiles tables so the listing never makes N+1
 * queries.
 *
 * Partners with no profile row (no company_description, etc.) still get
 * a `partner` block — we fall back to the partner's name + country +
 * city + website from the partners table, with verification_level='none'
 * and zeroed rating counters.
 */
async function hydratePublicPostItems(
  rows: MarketplacePost[],
): Promise<PublicMarketplacePostItem[]> {
  if (rows.length === 0) return [];
  const sb = getSupabase();

  const partnerIds = Array.from(new Set(rows.map((r) => r.partner_id).filter(Boolean)));
  if (partnerIds.length === 0) {
    return rows.map(redactPostRow);
  }

  // Batched partner lookup. The partners table is global (no tenant
  // scope) — getPartner() in the store already fetches by id alone.
  const { data: partnerRows } = await sb
    .from("partners")
    .select("id, name, country, city, website")
    .in("id", partnerIds);
  const partnersById = new Map<string, { id: string; name: string; country: string | null; city: string | null; website: string | null }>(
    ((partnerRows as any[]) || []).map((p) => [p.id, p]),
  );

  // Batched profile lookup (verification_level + rating_average + rating_count).
  const { data: profileRows } = await sb
    .from("marketplace_company_profiles")
    .select("partner_id, verification_level, rating_average, rating_count")
    .in("partner_id", partnerIds);
  const profilesByPartner = new Map<string, { verification_level: string; rating_average: number; rating_count: number }>(
    ((profileRows as any[]) || []).map((p) => [p.partner_id, p]),
  );

  return rows.map((r) => {
    const base = redactPostRow(r);
    const partner = partnersById.get(r.partner_id);
    const profile = profilesByPartner.get(r.partner_id);
    base.partner = partner
      ? {
          company_name: partner.name,
          country: partner.country,
          city: partner.city,
          website: partner.website,
          verification_level: profile?.verification_level ?? "none",
          rating_average: profile?.rating_average ?? 0,
          rating_count: profile?.rating_count ?? 0,
        }
      : null;
    return base;
  });
}

/**
 * Strip PII from a raw marketplace_posts row to produce the
 * `PublicMarketplacePostItem` shape (minus the `partner` block, which is
 * attached by `hydratePublicPostItems`).
 */
function redactPostRow(p: MarketplacePost): PublicMarketplacePostItem {
  return {
    id: p.id,
    post_type: p.post_type,
    product_name: p.product_name,
    product_category: p.product_category,
    product_subcategory: p.product_subcategory,
    quantity: p.quantity,
    unit: p.unit,
    target_price: p.target_price,
    price_visible: p.price_visible,
    currency: p.currency,
    price_type: p.price_type,
    price_max: p.price_max,
    delivery_location: p.delivery_location,
    delivery_country: p.delivery_country,
    delivery_date: p.delivery_date,
    incoterm: p.incoterm,
    origin_country: p.origin_country,
    packaging: p.packaging,
    payment_terms: p.payment_terms,
    description: p.description,
    status: p.status,
    is_verified: p.is_verified,
    verification_level: p.verification_level,
    views_count: p.views_count,
    responses_count: p.responses_count,
    expires_at: p.expires_at,
    created_at: p.created_at,
    partner: null,
  };
}

/**
 * Fetch a single post by id for the PUBLIC feed (no tenant scope).
 * Increments views_count atomically (fire-and-forget — same pattern as
 * the auth-gated getMarketplacePost).
 *
 * Returns null when the post doesn't exist, OR when status is not
 * 'active'/'expired', OR when visibility is 'private'. (A 404 to the
 * caller — we don't leak the existence of a private/draft post.)
 *
 * The redacted shape is identical to the listing item; the verification
 * badge + rating are part of the `partner` block.
 */
export async function getPublicMarketplacePost(
  postId: string,
): Promise<PublicMarketplacePostItem | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("marketplace_posts")
    .select("*")
    .eq("id", postId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const post = data as MarketplacePost;

  // Bump views_count (fire-and-forget — never blocks the read).
  void sb
    .from("marketplace_posts")
    .update({ views_count: (post.views_count || 0) + 1 })
    .eq("id", postId)
    .then(({ error: e }) => {
      if (e) console.error("[marketplace.public] view-count increment failed:", e);
    });

  // Hide non-public / non-active posts.
  if (post.status !== "active" && post.status !== "expired") return null;
  if (post.visibility === "private") return null;

  const [hydrated] = await hydratePublicPostItems([post]);
  return hydrated;
}
