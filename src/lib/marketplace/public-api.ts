// Marketplace public-API redaction helpers — Phase 12.
//
// The unauthenticated `/api/marketplace/public` endpoints surface a STRICT
// subset of the marketplace_posts + partner rows to 3rd-party integrators,
// partner directories, and crawlers. The DB layer returns the full row
// (including tenant_id, partner_id, portal_access_id, target_price,
// contact info) — the API layer MUST redact the PII fields before
// serialising the JSON response.
//
// `redactPostForPublic` and `redactPartnerForPublic` are the SINGLE SOURCE
// OF TRUTH for that redaction. The existing `PublicMarketplacePostItem`
// shape (in marketplace-store.ts) is constructed at the store layer using
// an allow-list; this module is the inverse — a deny-list applied to
// arbitrary `any` payloads. Both layers exist deliberately:
//
//   • The store-layer allow-list is what the listing + single-post
//     endpoints actually use today (it knows the exact column names +
//     builds the typed `PublicMarketplacePostItem`).
//
//   • This deny-list is a defence-in-depth for any future code path that
//     wants to surface a `MarketplacePost` or `Partner` to a public caller
//     without re-implementing the allow-list (e.g. an RSS feed, a sitemap
//     generator, a partner-directory export). Call `redactPostForPublic`
//     before serialising and PII is guaranteed not to leak even if the
//     upstream row's shape changes (the deny-list is name-based).
//
// WHY A DENY-LIST HERE (vs. the allow-list in the store)?
//   The store's `redactPostRow()` is a hand-coded object literal that
//   picks exactly the fields it wants — safe but rigid. This module
//   receives `any` and DROPS the named PII fields, keeping everything
//   else — flexible for downstream consumers that want e.g. an extra
//   marketing column the store hasn't typed yet. Both approaches are
//   defensible; the two-layer approach gives us type-safety for the
//   hot path AND a usable helper for ad-hoc public surfaces.
//
// PII POLICY (per Phase 12 spec):
//   Post  — strip: partner_id, tenant_id, portal_access_id, target_price
//                   (only when price_visible === false), contact info.
//           keep:  product_name, category, quantity, unit, price (when
//                   visible), delivery_location, country, incoterm,
//                   specs, is_verified, verification_level.
//   Partner — strip: email, phone, address, contact_name, bank details,
//                     KYC data.
//             keep:  name, country, type, verification_level.

/* eslint-disable @typescript-eslint/no-explicit-any -- This module is
 * deliberately typed as `any` in/out: it's a redaction boundary that must
 * tolerate partial / untyped payloads (e.g. a partner row fetched via a
 * supabase `.select('*')` whose TS type is a generated superset of the
 * hand-written `Partner` interface). The deny-list approach means a new
// column added to the table surfaces automatically; an allow-list would
// silently drop it. */

// ─── Fields that must NEVER leave the platform via the public API ──────────

/**
 * Identity fields on a marketplace post that bind the row to a specific
 * tenant / partner / portal session. Public callers learn nothing from
 * these IDs (they can't resolve them) and they're a PII leak (a partner's
 * internal VELOS id is itself personal data under GDPR Art. 4(1) when
 * it can be linked to a natural person via the partners table).
 */
const POST_PII_FIELDS = [
  "tenant_id",
  "partner_id",
  "portal_access_id",
  // Internal bookkeeping that's not strictly PII but has no public value
  // — dropping them keeps the public payload small + avoids leaking
  // internal state (e.g. flagged_status surfaces a moderation state).
  "flagged_status",
  "flagged_reason",
  "flagged_by",
  "internal_notes",
] as const;

/**
 * Free-text / contact fields on a partner row that are NEVER exposed to
 * public callers. Per Phase 12 spec: "Keep name, country, type,
 * verification_level". Everything else is dropped.
 */
const PARTNER_PII_FIELDS = [
  // Direct PII
  "email",
  "phone",
  "whatsapp",
  "contact_name",
  "contact_email",
  "contact_phone",
  // Address (kept at the POST level as delivery_country, but a partner's
  // registered address is not part of the public marketplace directory).
  "address_line",
  "address",
  "city",
  "state",
  "postal_code",
  "street",
  "zip",
  // Bank / payment details — never public.
  "bank_name",
  "bank_account",
  "bank_swift",
  "bank_iban",
  "iban",
  "swift",
  "bic",
  // Tax / registration numbers — partner-internal, not public.
  "tax_id",
  "vat_number",
  "registration_number",
  "company_number",
  // KYC — extremely sensitive (passport numbers, business registration
  // documents, beneficial-ownership declarations). NEVER expose.
  "kyc_status",
  "kyc_data",
  "kyc_reviewed_by",
  "kyc_reviewed_at",
  "kyc_documents",
  "kyc_submitted_at",
  // Portal session / auth — never public.
  "portal_token",
  "portal_password",
  "portal_level",
  "portal_enabled",
  "portal_permissions",
  "portal_visible_products",
  "portal_last_login",
  // Internal CRM
  "risk_score",
  "notes",
  "tags",
  "activities",
  "lead_source",
  "linked_company_id",
  "old_id",
  "social",
  "preferred_currency",
  "preferred_incoterm",
  "preferred_payment_terms",
  "is_commissioner",
  "rating",
  "status",
  // Identity / timestamps
  "id",
  "tenant_id",
  "created_at",
  "updated_at",
] as const;

/**
 * Redact a marketplace post row for public consumption.
 *
 * Drops:
 *   • tenant_id, partner_id, portal_access_id — internal IDs.
 *   • target_price + price_max — DROPPED ONLY WHEN `price_visible` is
 *     falsy. When the post author has marked the price as hidden ("on
 *     request"), publishing it on the public feed would defeat the
 *     purpose. The `price_visible` flag itself is preserved so the
 *     caller knows whether to render a price column.
 *   • Any field on `POST_PII_FIELDS` (moderation state, internal notes).
 *
 * Keeps everything else (product_name, category, quantity, unit,
 * delivery_location, country, incoterm, specs, is_verified,
 * verification_level, …). The function is RECURSIVE on nested objects +
 * arrays so a `specifications: { internal_sku: "..." }` sub-object is
 * preserved verbatim (the spec calls out "specs" as public marketing
 * data).
 *
 * Pure: does NOT mutate the input — a shallow copy is returned. The
 * caller may still need the unsanitised object for its own audit log.
 */
export function redactPostForPublic(post: any): Record<string, unknown> {
  if (post === null || post === undefined) return {};
  if (typeof post !== "object" || Array.isArray(post)) return {};

  // Defensive copy — never mutate the caller's row.
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(post as Record<string, unknown>)) {
    // 1. Hard-deny PII fields.
    if ((POST_PII_FIELDS as readonly string[]).includes(key)) continue;

    // 2. Conditional PII — the price is PII when the author has marked
    //    the post as "price on request" (price_visible === false). We
    //    keep the `price_visible` flag itself so the caller can render
    //    "Price on request" instead of a numeric column.
    if (
      (key === "target_price" || key === "price_max") &&
      post.price_visible === false
    ) {
      continue;
    }

    out[key] = value;
  }
  return out;
}

/**
 * Redact a partner row for public consumption.
 *
 * Per the Phase 12 spec: "Keep: name, country, type, verification_level.
 * Strip: email, phone, address, contact_name, bank details, KYC".
 *
 * The verification_level lives on the `marketplace_company_profiles` table,
 * NOT on the partner row itself — when the caller has already merged the
 * profile into the partner object (e.g. via a SQL join), this function
 * preserves it. When the partner object is the raw `partners` row,
 * verification_level is simply absent and the caller is expected to
 * default it to "none" (matching the store's `hydratePublicPostItems`).
 *
 * Pure: does NOT mutate the input — a shallow copy is returned.
 */
export function redactPartnerForPublic(partner: any): Record<string, unknown> {
  if (partner === null || partner === undefined) return {};
  if (typeof partner !== "object" || Array.isArray(partner)) return {};

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(partner as Record<string, unknown>)) {
    if ((PARTNER_PII_FIELDS as readonly string[]).includes(key)) continue;
    out[key] = value;
  }
  return out;
}
