/**
 * AUDIT18 — canonical HTML-escaping helper.
 *
 * Previously this exact function was copy-pasted 12× across the codebase
 * (email/service.ts, notif/helper.ts, monitoring/alert-routing.ts,
 * compliance/breach-notification.ts, 7 API routes, the LOI send route with a
 * drifted signature, …). Any future escaping fix (e.g. a new entity context)
 * had to be applied 12 times — and `sanitizeInput` in
 * src/lib/security/sanitize-input.ts had ALREADY drifted (it did not escape
 * `&` first, causing double-escaping/&amp;-reinterpretation). This module is
 * now the single source of truth; keep it dependency-free and edge-safe.
 */
export function escapeHtml(str: unknown): string {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Escape for attribute contexts that also allow newlines (title="…"). */
export function escapeAttr(str: unknown): string {
  return escapeHtml(str).replace(/\n/g, "&#10;").replace(/\r/g, "&#13;");
}
