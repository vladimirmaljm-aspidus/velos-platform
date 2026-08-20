/**
 * HTML/XSS input sanitizer for user-supplied free-text fields.
 *
 * FIX-ALL-2 / Fix 6 (XSS prevention): audit Part D found that POST
 * /api/products, /api/partners, /api/offers accepted raw `<`, `>`, `"`,
 * `'` characters in name / description fields and stored them verbatim.
 * When the admin SPA later renders these strings via
 * `dangerouslySetInnerHTML` (e.g. PDF templates, rich text in offer
 * descriptions), an attacker can inject `<script>` or event-handler
 * attributes that execute in another tenant admin's browser.
 *
 * This helper performs defence-in-depth OUTPUT-side escaping: it does NOT
 * replace a proper sanitiser on the render side (React already escapes
 * text by default; only `dangerouslySetInnerHTML` is at risk). It exists
 * so that even if a future template uses `dangerouslySetInnerHTML`, the
 * stored payload can't contain the four characters that make HTML/script
 * injection possible.
 *
 * Non-string inputs are returned unchanged so callers can pipe an
 * arbitrary request body through `sanitizeInput` without per-field type
 * guards. Empty strings are returned as-is (do not mutate a deliberate
 * clear).
 *
 * The escaping uses the HTML entity equivalents:
 *   `<`  →  &lt;
 *   `>`  →  &gt;
 *   `"`  →  &quot;
 *   `'`  →  &#x27;   (the `&#39;` numeric form is also valid; the hex
 *                      form is the OWASP-recommended default)
 *
 * Implementation note: do NOT use a single regex with a character class
 * and a replacer function — the explicit, ordered replacements below
 * are easier to audit and produce identical output. The string-module
 * regex is anchored on the literal characters, not the metacharacters,
 * so no escaping of the pattern itself is needed.
 */
export function sanitizeInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  if (input.length === 0) return input;
  return input
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * Apply {@link sanitizeInput} to a picked set of fields on a request body.
 *
 * Returns a shallow-cloned body with the named fields escaped; fields not
 * present are left untouched. The original object is NOT mutated so the
 * caller can keep using the unsanitised copy for any logic that needs the
 * raw value (e.g. duplicate-name checks — those compare case-insensitively
 * and would behave differently on `&lt;` vs `<`).
 *
 * Usage:
 *   body = sanitizeFields(body, ["name", "description", "subject"]);
 */
export function sanitizeFields<T extends Record<string, unknown>>(
  body: T,
  fields: string[],
): T {
  const out: Record<string, unknown> = { ...body };
  for (const f of fields) {
    if (f in out && typeof out[f] === "string") {
      out[f] = sanitizeInput(out[f]);
    }
  }
  return out as T;
}
