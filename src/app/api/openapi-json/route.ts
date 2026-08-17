import { NextResponse } from "next/server";
import { openApiSpec } from "@/lib/api/openapi-spec";

/**
 * GET /api/openapi-json
 *
 * Serves the curated OpenAPI 3.0 specification as a JSON document. This is
 * the canonical source for external tooling (Postman, Stoplight, Swagger
 * Editor, Redocly, etc.) to import and lint the VELOS Trade API surface.
 *
 * ─── Why is this public (no auth)? ──────────────────────────────────────────
 * The spec describes the API shape (paths, parameters, schemas) but contains
 * NO secrets — no example tokens, no internal hostnames, no PII. The actual
 * endpoint responses are still auth-gated at the route level. Publishing the
 * spec openly is the OpenAPI convention: it lets third-party integrators
 * discover and adopt the API without a support ticket, and it lets
 * automated tools (e.g. `@redocly/cli lint`) validate the spec in CI.
 *
 * ─── Caching ────────────────────────────────────────────────────────────────
 * The spec is a static object baked into the bundle, so we cache it
 * aggressively at the edge (1 hour) and in the browser (1 hour). Bumping
 * the version in `openApiSpec.info.version` is the signal to invalidate.
 */

export const runtime = "nodejs";
export const revalidate = 3600; // ISR — re-generate at most once per hour

export async function GET() {
  return NextResponse.json(openApiSpec, {
    headers: {
      "Cache-Control": "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
