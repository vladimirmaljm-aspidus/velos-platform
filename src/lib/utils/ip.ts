/**
 * AUDIT18 — canonical client-IP extraction (edge + node safe).
 *
 * Previously two hand-mirrored copies existed (src/lib/api/helpers.ts:getIp
 * and src/middleware.ts:getIp). They are in sync TODAY only because both
 * were patched in the same audit — the middleware copy's own comment admits
 * "mirror helpers.ts:getIp() resolution order". Any future change to the
 * resolution order (e.g. a new header, a deploy-topology change like the
 * Cloudflare→Render migration) had to be applied twice; missing one silently
 * desynchronized per-IP rate-limit buckets from audit-log IPs — the exact
 * 8a-11 production incident class.
 *
 * This module is dependency-free (pure header parsing) so BOTH the edge
 * middleware and node route handlers can import it.
 */
export function getIp(req?: Request): string {
  if (!req) return "0.0.0.0";
  // Resolution order:
  //   1. `CF-Connecting-IP` — set by Cloudflare to the real client IP.
  //      Cannot be spoofed by the client (Cloudflare overwrites any
  //      client-supplied value before reaching origin).
  //   2. `X-Real-IP` — set by nginx/Caddy in single-proxy deploys.
  //   3. `X-Forwarded-For` FIRST entry — the original client (the rest of
  //      the chain is intermediate proxies). Only reached when
  //      CF-Connecting-IP and X-Real-IP are both absent (i.e. NOT behind
  //      Cloudflare), so the trusted proxy that set XFF is the only writer
  //      of the chain.
  const cfIp = req.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp.trim();
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[0];
  }
  return "0.0.0.0";
}
