/**
 * Redact sensitive keys from an audit-log details object.
 *
 * Audit logs are for tracing who did what — not for exposing live credentials
 * (e.g. portal password-reset tokens, API keys, SMTP passwords) to anyone who
 * can read the log. This helper walks `details` recursively and replaces any
 * key whose name (case-insensitively) contains a denylist entry with the
 * literal string "[redacted]". Non-object inputs are returned unchanged so
 * callers can pipe arbitrary `details` values through without type-narrowing
 * first.
 *
 * P2-14: the previous implementation only redacted top-level keys, so nested
 * secrets like `details.body.password` or `details.payload.smtp_password`
 * leaked into the audit trail. The walker now descends into plain objects and
 * arrays; arrays are mapped element-wise (so secrets inside list items are
 * masked too).
 *
 * @param details       The original details value (object, null, primitive, …)
 * @param keysToRedact  Array of substrings whose matching keys should be masked.
 *                      Defaults to {@link DEFAULT_DENY} when omitted.
 */

import { decryptFieldMasked } from "@/lib/crypto/field-encryption";

const DEFAULT_DENY = [
  "password",
  "password_hash",
  "token",
  "secret",
  "key",
  "api_key",
  "apikey",
  "authorization",
  "smtp_password",
  "reset_token",
  "session_token",
  "access_token",
  "refresh_token",
  "private_key",
];

export function redactDetails(
  details: unknown,
  keysToRedact: string[] = DEFAULT_DENY,
): unknown {
  if (details == null) return details;
  if (typeof details !== "object") return details;
  if (Array.isArray(details)) {
    return details.map((item) => redactDetails(item, keysToRedact));
  }
  // Pre-lowercase the denylist once per call so the hot loop does only a
  // single toLowerCase() on the key, not on every denylist entry.
  const denyLower = keysToRedact.map((dk) => dk.toLowerCase());
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
    if (denyLower.some((dk) => k.toLowerCase().includes(dk))) {
      copy[k] = "[redacted]";
    } else if (typeof v === "object" && v !== null) {
      copy[k] = redactDetails(v, keysToRedact);
    } else {
      copy[k] = v;
    }
  }
  return copy;
}

/** Standard redaction keys for tenant-scoped audit logs. */
export const TENANT_REDACT_KEYS = ["reset_token"];

// ── FIX-ALL-2 / Fix 1 — strip sensitive data from API responses ─────────────
//
// Audit Part A (sensitive-data exposure): the GET /api/partners and
// /api/offers routes returned the full row to API-key callers, including
// fields the API contract should never surface:
//
//   • partners.kyc_data / kyc_status / kyc_submitted_at — KYC document
//     metadata (ID numbers, document scans) that the operator reviews in
//     the admin UI but that an API integrator has no business reading.
//   • partners.bank_account / bank_swift / bank_iban — settlement bank
//     account numbers; the API contract surfaces bank details only via the
//     explicit `bank_details` JSON column on offers.
//   • partners.vat_number — already encrypted at rest (P0-3 / Feature 2),
//     but the decrypted value is still surfaced on the read path for the
//     admin UI; API-key callers should not receive it.
//   • offers.bank_details — JSON blob with the seller's bank account,
//     swift, IBAN, beneficiary name; surfaced on the offer PDF but NOT in
//     the API response.
//
// The redaction is conditional on `"apiKeyId" in auth` — a logged-in admin
// user (session auth) keeps seeing the fields so the CRM UI continues to
// work; only API-key integrators are subject to the strip. This matches
// the audit's recommendation that the API surface be narrower than the
// admin UI surface.

/**
 * Field names stripped from partner responses when the caller is an API
 * key. See {@link redactSensitiveFields} for the policy.
 */
export const PARTNER_SENSITIVE_FIELDS = [
  "kyc_data",
  "kyc_status",
  "kyc_submitted_at",
  "kyc_reviewer_id",
  "kyc_reviewed_at",
  "kyc_notes",
  "bank_account",
  "bank_swift",
  "bank_iban",
  "bank_name",
  "bank_beneficiary",
  "vat_number",
  "tax_id",
] as const;

/**
 * Field names stripped from offer responses when the caller is an API
 * key. `bank_details` is a JSON column on the offers table that carries
 * the seller's settlement instructions — surfaced on the PDF but never
 * in the API response.
 */
export const OFFER_SENSITIVE_FIELDS = [
  "bank_details",
] as const;

function isApiKeyCaller(auth: unknown): boolean {
  return (
    typeof auth === "object" &&
    auth !== null &&
    "apiKeyId" in auth
  );
}

/**
 * Strip sensitive fields from a single record (or list of records) when
 * the caller authenticated with an API key. Session-auth callers (admin
 * UI) receive the full row unchanged.
 *
 * The helper is a no-op when `auth` is null/undefined or when the caller
 * is a session-auth user (so it is safe to call on every response path
 * unconditionally). The input object is NOT mutated — a shallow clone is
 * returned so the caller's own copy (used for webhook payloads, audit
 * details, etc.) retains the original values.
 *
 * The fields stripped are listed in {@link PARTNER_SENSITIVE_FIELDS}.
 */
export function redactPartnerFields<T extends Record<string, unknown>>(
  record: T | T[] | null | undefined,
  auth: unknown,
): T | T[] | null | undefined {
  if (!record || !isApiKeyCaller(auth)) return record;
  const strip = (r: T): T => {
    const copy: Record<string, unknown> = { ...r };
    for (const f of PARTNER_SENSITIVE_FIELDS) {
      if (f in copy) delete copy[f];
    }
    return copy as T;
  };
  return Array.isArray(record) ? record.map(strip) : strip(record);
}

/**
 * Strip sensitive fields from offer records when the caller is an API
 * key. See {@link redactPartnerFields} for the policy.
 */
export function redactOfferFields<T extends Record<string, unknown>>(
  record: T | T[] | null | undefined,
  auth: unknown,
): T | T[] | null | undefined {
  if (!record || !isApiKeyCaller(auth)) return record;
  const strip = (r: T): T => {
    const copy: Record<string, unknown> = { ...r };
    for (const f of OFFER_SENSITIVE_FIELDS) {
      if (f in copy) delete copy[f];
    }
    return copy as T;
  };
  return Array.isArray(record) ? record.map(strip) : strip(record);
}

/**
 * Convenience alias kept for callers that prefer a single entry-point
 * name. Mirrors the task description ("Create a `redactSensitiveFields`
 * helper").
 */
export function redactSensitiveFields<T extends Record<string, unknown>>(
  record: T | T[] | null | undefined,
  auth: unknown,
  kind: "partner" | "offer",
): T | T[] | null | undefined {
  return kind === "partner"
    ? redactPartnerFields(record, auth)
    : redactOfferFields(record, auth);
}

// ── AUDIT18 — canonical partner response shaping ────────────────────────────
//
// The partner entity was independently shaped in 5 places (list, [id] GET,
// [id] PUT response, /api/partners/export, /api/export?type=partners), each
// hand-rolling "strip portal_token + hmac twins → decrypt the encrypted-at-
// rest PII fields". The copies DRIFTED: the PUT response forgot
// `contact_phone` decryption (an `enc:` blob flashed in the admin UI after
// every edit), and the export branch added email when others didn't. This
// single source of truth replaces all five; it deliberately decrypts BEFORE
// redactPartnerFields so API-key callers still get the redacted view.


/** PII fields stored encrypted-at-rest (audit15/16) + their hmac twins to strip. */
const PARTNER_OMIT_KEYS = ["portal_token", "tax_id_hmac", "vat_number_hmac"];
const PARTNER_ENCRYPTED_FIELDS = [
  "contact_email",
  "phone",
  "contact_phone",
  "tax_id",
  "vat_number",
] as const;

/**
 * Strip hmac/portal-token twins, decrypt the encrypted-at-rest PII fields,
 * and (for API-key callers) strip the sensitive block. Mutates nothing —
 * returns a shallow, typed copy.
 */
export function shapePartnerRow<T extends Record<string, unknown>>(
  partner: T,
  auth?: unknown,
): T {
  const copy: Record<string, unknown> = { ...partner };
  for (const k of PARTNER_OMIT_KEYS) delete copy[k];
  for (const f of PARTNER_ENCRYPTED_FIELDS) {
    const v = copy[f];
    if (typeof v === "string" && v !== "") {
      // audit26 P0: masked decrypt — a failed decryption (rotated key /
      // tampered ciphertext) must never leak the raw `enc:...` blob into
      // a UI table cell. Users see "••••••••" instead.
      copy[f] = decryptFieldMasked(v);
    }
  }
  return redactPartnerFields(copy as T, auth) as T;
}

/**
 * Extended redaction keys for super-admin (cross-tenant) audit logs.
 *
 * CRITICAL FIX (audit M-2): the previous list (`["reset_token", "password",
 * "token"]`) was far too narrow — it let `api_key`, `secret`, `private_key`,
 * `smtp_password`, `authorization`, and the various `*_token` fields leak
 * into the super-admin audit feed. This now mirrors {@link DEFAULT_DENY} so
 * every credential-shaped key is masked regardless of which tenant the
 * caller is inspecting.
 */
export const SUPER_ADMIN_REDACT_KEYS = [
  "password", "password_hash", "token", "secret", "key",
  "api_key", "apikey", "authorization", "smtp_password",
  "reset_token", "session_token", "access_token",
  "refresh_token", "private_key",
];
