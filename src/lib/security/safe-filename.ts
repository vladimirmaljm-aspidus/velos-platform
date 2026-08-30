/**
 * Sanitise a string for safe interpolation into a `Content-Disposition`
 * filename header value. Closes audit 8b-8: document numbers
 * (`OFFER-2024-0001`, `INV-2024-0001`, etc.) were being interpolated
 * directly into `Content-Disposition: inline; filename="Offer-${number}.pdf"`
 * without any sanitisation. While these numbers are admin-generated in
 * the normal flow, admin import from 3rd-party systems, misconfigured
 * migrations, or a malicious tenant admin could introduce numbers with
 * `\r\n` (HTTP response splitting), `"` (header-value boundary), or
 * control chars.
 *
 * RFC 6266 also forbids the literal `"` character inside a quoted-string
 * unless escaped; the safe path is to strip these characters entirely
 * rather than try to escape them (since the surrounding `filename="..."`
 * template adds its own quotes).
 *
 * Returns the fallback (typically the resource `id`) when the input is
 * empty after sanitisation, so the header is always syntactically valid.
 */
export function safeFilename(name: unknown, fallback: string): string {
  const safe = String(name ?? "")
    .replace(/[\r\n"]/g, "") // CRLF + quote — header injection
    .replace(/[\x00-\x1F]/g, "") // ASCII control chars
    .trim()
    .slice(0, 100);
  return safe || fallback;
}
