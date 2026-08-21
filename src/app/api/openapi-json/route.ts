import { NextRequest, NextResponse } from "next/server";
import { openApiSpec } from "@/lib/api/openapi-spec";
import { requireSuperAdmin } from "@/lib/api/helpers";

/**
 * GET /api/openapi-json
 *
 * Serves the curated OpenAPI 3.0 specification as a JSON document. This is
 * the canonical source for external tooling (Postman, Stoplight, Swagger
 * Editor, Redocly, etc.) to import and lint the VELOS Trade API surface.
 *
 * ─── Why is this gated to super_admin? ───────────────────────────────────
 * The spec describes the API shape (paths, parameters, schemas) but, taken
 * together, that enumeration of the route surface is itself sensitive: an
 * attacker can use the full endpoint list to scope a follow-on attack
 * (which routes exist, which accept which body shapes, which return 401
 * vs 403 vs 404). Public publication is the OpenAPI convention for
 * third-party integrators, but for a multi-tenant SaaS the disclosure
 * posture is "trusted integrators only" — the platform owner can hand
 * the spec to a partner, but random visitors must not enumerate it. So
 * the route now requires a super_admin session.
 *
 * The actual endpoint responses are still auth-gated at the route level
 * regardless of who reads the spec — the spec lists shapes, not data.
 *
 * ─── Caching ─────────────────────────────────────────────────────────────
 * `force-dynamic` is set because the response depends on the caller's
 * session cookie — auth-gated content MUST NOT be cached at the edge
 * (otherwise a super-admin's 200 response could be served to an
 * unauthenticated caller on the same edge POP). The previous ISR/revalidate
 * caching is removed for that reason.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) {
    // requireSuperAdmin returns 401 (no session) or 403 (non-super-admin).
    return auth;
  }
  void auth; // auth context unused beyond the gate
  return NextResponse.json(openApiSpec, {
    headers: {
      // Private — never cache the auth-gated response at the edge or in
      // the browser. Re-validation requires the caller to re-present the
      // session cookie.
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
