// Marketplace privacy helpers — Phase 2.
//
// The marketplace exposes posts + negotiation rooms to partners on the
// same tenant. To preserve commercial privacy we NEVER leak the full
// Partner record to the other side of a negotiation until both parties
// have accepted the deal (i.e. the negotiation's `contact_revealed` flag
// has been flipped to TRUE on the row).
//
// `redactPartnerForMarketplace(partner)` is the boundary function — every
// API response that returns a partner alongside a marketplace row runs
// the partner through it before serialisation. The result is a small,
// stable "public profile" shape containing ONLY:
//
//   • id              — needed so the negotiation can reference the partner
//   • name            — company / legal name
//   • country         — ISO 3166-1 alpha-2 (e.g. "RS", "AE")
//   • type            — PartnerType (supplier / buyer / both / agent / …)
//   • verification_level  — derived from kyc_status (see kycToVerificationLevel)
//   • portal_level    — "none" | "viewer" | "buyer"
//
// Everything else — email, phone, contact_name, contact_email,
// contact_phone, address_line / city / state / postal_code, tax_id,
// vat_number, registration_number, bank_*, notes, tags, etc. — is
// intentionally stripped. Those fields surface ONLY in the negotiation
// room's "Contact info" card after `contact_revealed = true`.
//
// The function is total — it accepts any partial Partner-like object and
// returns whatever safe fields are present. Missing fields become `null`
// so the caller never crashes on `undefined.field`.

import type {
  Partner,
  PartnerType,
  KycStatus,
} from "@/lib/supabase/types";

/**
 * Public-facing partner shape shown in the marketplace. This is the ONLY
 * partner-derived information a stranger partner may see before both
 * sides accept a negotiation. Defined as a `type` so the API boundary and
 * the React component agree on the exact shape.
 */
export interface MarketplacePublicPartner {
  id: string;
  /** Legal / company name — never null for a real partner. */
  name: string;
  /** ISO 3166-1 alpha-2 country code (null when the partner hasn't set one). */
  country: string | null;
  /** Trade role — supplier / buyer / both / agent / logistics / customs / bank / inspector. */
  type: PartnerType | null;
  /**
   * Verification level — derived from the partner's KYC status so the UI
   * can show a verified / pending / unverified badge without leaking the
   * raw KYC submission state. The 4 values mirror the marketplace post's
   * `verification_level` enum (none / bronze / silver / gold / platinum)
   * but we collapse the 4 tiers into a single "verified" band — the
   * marketplace post's own tier-specific level is shown separately on
   * the post card itself.
   */
  verification_level:
    | "none"
    | "pending"
    | "verified"
    | "rejected";
  /** Portal access level — drives the "buyer" / "viewer" badge. */
  portal_level: "none" | "viewer" | "buyer" | null;
}

/**
 * Map a partner's raw KYC status onto the 4-band verification level used
 * in the marketplace UI. Kept as a standalone export so API routes can
 * use it without going through `redactPartnerForMarketplace` (e.g. when
 * building a denormalised column for a marketplace post).
 */
export function kycToVerificationLevel(
  kyc: KycStatus | null | undefined,
): MarketplacePublicPartner["verification_level"] {
  switch (kyc) {
    case "approved":
      return "verified";
    case "pending":
      return "pending";
    case "rejected":
      return "rejected";
    case "not_submitted":
    default:
      return "none";
  }
}

/**
 * Redact a Partner record down to its marketplace-safe public shape.
 *
 * Accepts either a full Partner (returned by the store's getPartnerById)
 * or a partial / row-as-any object — useful when the partner was fetched
 * via a PostgREST select() that only projected a few columns. Missing
 * fields become `null` so the caller never crashes on `undefined.field`.
 *
 * Idempotent: calling this on an already-redacted object is safe — the
 * redacted shape contains only public fields, none of which are stripped
 * by a second pass.
 */
export function redactPartnerForMarketplace(
  partner: Partner | (Record<string, unknown> & { id?: string }) | null | undefined,
): MarketplacePublicPartner | null {
  if (!partner) return null;

  // Pull only the safe fields. We deliberately do NOT spread `...partner`
  // because that would re-leak every internal column (email, phone,
  // address, bank_*, tax_id, …) the store happened to attach.
  const id = (partner as { id?: string }).id;
  if (!id) return null;

  const name =
    (partner as { name?: string | null }).name ?? "Unknown partner";
  const country =
    (partner as { country?: string | null }).country ?? null;
  const type =
    (partner as { type?: PartnerType | null }).type ?? null;
  const kycStatus =
    (partner as { kyc_status?: KycStatus | null }).kyc_status ?? null;
  const portalLevel =
    (partner as {
      portal_level?: "none" | "viewer" | "buyer" | null;
    }).portal_level ?? null;

  return {
    id,
    name,
    country,
    type,
    verification_level: kycToVerificationLevel(kycStatus),
    portal_level: portalLevel,
  };
}

/**
 * Redact a list of partners. Convenience wrapper so the API boundary can
 * call `redactPartnerList(rows)` instead of `.map(redactPartnerForMarketplace)`.
 * Nulls (partners without an id) are filtered out.
 */
export function redactPartnerList(
  partners: (Partner | Record<string, unknown>)[] | null | undefined,
): MarketplacePublicPartner[] {
  if (!Array.isArray(partners)) return [];
  return partners
    .map((p) => redactPartnerForMarketplace(p))
    .filter((p): p is MarketplacePublicPartner => p !== null);
}
