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
