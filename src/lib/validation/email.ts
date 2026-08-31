/**
 * AUDIT18 — canonical email validation + readable-address resolution.
 *
 * The same regexp (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`) was duplicated ~20× across
 * the codebase (email service ×6, KYC automation, 10+ API routes, 7 client
 * views), and the "decrypt → isEncrypted → regex" guard chain that protects
 * email sending existed as 4 independent implementations (email/service
 * resolveQueueToAddress, kyc/automation resolvePartnerContactEmail, LOI send
 * inline, logistics-requests inline) with DIFFERENT fallback orders. Any rule
 * change (e.g. blocking plus-addressing) or decrypt-guard fix had to be
 * applied per-copy and they had already drifted.
 *
 * Keep this module dependency-light: EMAIL_RE / isValidEmail are safe for
 * both client and server. The resolve* helper imports field-encryption
 * (isomorphic — same code on client and server).
 */
import { decryptField, isEncrypted } from "@/lib/crypto/field-encryption";

/** Canonical email shape check (permissive — matches the historical regex exactly). */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(v: unknown): v is string {
  return typeof v === "string" && EMAIL_RE.test(v);
}

/**
 * Resolve a readable email from candidate sources, decrypting encrypted
 * values and skipping undecryptable/invalid ones. Returns the first USABLE
 * address or "".
 *
 * Order matters and is now explicit per call site via the argument order:
 * pass candidates in the priority you want (e.g. contact first, then
 * legacy `email`, or the reverse — the previous copies hardcoded both
 * orders inconsistently).
 */
export function resolveReadableEmail(...candidates: (string | null | undefined)[]): string {
  for (const c of candidates) {
    if (typeof c !== "string" || c === "") continue;
    const resolved = isEncrypted(c) ? decryptField(c) : c;
    if (resolved && !isEncrypted(resolved) && EMAIL_RE.test(resolved)) return resolved;
  }
  return "";
}
