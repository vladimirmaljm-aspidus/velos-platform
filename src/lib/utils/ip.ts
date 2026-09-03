/**
 * AUDIT18 — canonical client-IP extraction (edge + node safe).
 *
 * Previously two hand-mirrored copies existed (src/lib/api/helpers.ts:getIp
 * and src/middleware.ts:getIp). They are in sync TODAY only because both
 * were patched in the same audit — the middleware copy's own comment admits
 * "mirror helpers.ts:getIp() resolution order". Any future change to the
 * resolution order (e.g. a new header, a deploy-topology change like the
 * Cloudflare→Vercel migration) had to be applied twice; missing one silently
 * desynchronized per-IP rate-limit buckets from audit-log IPs — the exact
 * 8a-11 production incident class.
 *
 * This module is dependency-free (pure header parsing) so BOTH the edge
 * middleware and node route handlers can import it.
 *
 * H2 (audit 4-b) — header trust model, production = Vercel:
 * Production runs on Vercel, which CONTROLS `x-vercel-forwarded-for` and
 * overwrites `x-forwarded-for` with the connecting client — neither can be
 * spoofed by the browser. Vercel does NOT set `cf-connecting-ip` or
 * `x-real-ip`, so a client-supplied value for those headers was
 * attacker-controlled and made every per-IP rate limit bypassable
 * (pick a fresh fake IP → fresh bucket) and let audit-log / login-history
 * IPs be poisoned. Those two headers are now only honoured when the
 * deployment explicitly opts in via `TRUST_PROXY_HEADERS=true`
 * (self-hosted behind Cloudflare / nginx, where the edge proxy strips
 * client-supplied values before they reach the app).
 */
export function getIp(req?: Request): string {
  if (!req) return "0.0.0.0";
  // Resolution order:
  //   1. `x-vercel-forwarded-for` — set ONLY by Vercel to the real client
  //      IP. Unspoofable on Vercel; absent everywhere else.
  //   2. `x-forwarded-for` FIRST entry — the original client (the rest of
  //      the chain is intermediate proxies). On Vercel the platform
  //      overwrites the header, so the leftmost entry is trustworthy; on
  //      other PaaS (Render, Fly, railway…) the trusted proxy is the only
  //      writer of the chain.
  //   3. `cf-connecting-ip` / `x-real-ip` — ONLY when
  //      TRUST_PROXY_HEADERS=true. Set by Cloudflare/nginx in self-hosted
  //      deployments; on Vercel they are client-settable and therefore
  //      untrusted (audit H2).
  const vff = firstForwardedIp(req.headers.get("x-vercel-forwarded-for"));
  if (vff) return vff;
  const xff = firstForwardedIp(req.headers.get("x-forwarded-for"));
  if (xff) return xff;
  if (process.env.TRUST_PROXY_HEADERS === "true") {
    const cfIp = req.headers.get("cf-connecting-ip");
    if (cfIp) return cfIp.trim();
    const realIp = req.headers.get("x-real-ip");
    if (realIp) return realIp.trim();
  }
  // No trusted header present (e.g. local dev, direct connection). All
  // callers then share the "0.0.0.0" bucket — over-blocking, never
  // under-blocking — the safe direction for rate-limit keying.
  return "0.0.0.0";
}

/** Leftmost non-empty entry of a forwarded-for chain (trimmed). */
function firstForwardedIp(header: string | null): string | null {
  if (!header) return null;
  const parts = header.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts[0] : null;
}
