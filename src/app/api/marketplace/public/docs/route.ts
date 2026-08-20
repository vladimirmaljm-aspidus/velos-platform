import { NextResponse } from "next/server";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// ── Public API documentation ──────────────────────────────────────────────
//
// GET /api/marketplace/public/docs
//
// Public (unauthenticated) API documentation for the VELOS Marketplace
// public API surface. Returns a JSON object describing the available
// endpoints, rate limits, authentication scheme, example requests +
// responses, and the webhook event types.
//
// This is the discoverability endpoint third-party integrators hit
// first when adopting the marketplace API. The JSON is intentionally
// self-describing (no schema-reference indirection) so a developer
// can read it in a browser tab without an OpenAPI viewer.

/** Shape of the documentation response. */
interface MarketplaceApiDocs {
  name: string;
  version: string;
  base_url: string;
  description: string;
  authentication: {
    type: "Bearer API key";
    description: string;
    header_format: string;
    key_prefix: string;
    how_to_create: {
      endpoint: string;
      method: "POST";
      auth_required: string;
      body: Record<string, string>;
    };
  };
  rate_limits: {
    public_endpoints: { requests_per_minute_per_ip: number; window_seconds: number };
    authenticated_endpoints: { requests_per_minute_per_ip: number; window_seconds: number };
    headers_returned: string[];
  };
  endpoints: Array<{
    method: "GET" | "POST" | "DELETE";
    path: string;
    description: string;
    auth: "none" | "api_key";
    query_params?: Record<string, string>;
    example_request?: string;
    example_response_snippet?: string;
  }>;
  webhooks: {
    description: string;
    signature_header: string;
    signature_algorithm: string;
    events: Array<{ name: string; description: string; entity_type: string }>;
  };
  errors: Record<string, string>;
}

async function _get() {
  const docs: MarketplaceApiDocs = {
    name: "VELOS Marketplace Public API",
    version: "1.0.0",
    base_url: "/api/marketplace",
    description:
      "Programmatic access to the VELOS B2B commodity marketplace. " +
      "Browse public listings, fetch a single post, and (with an API key) " +
      "subscribe to lifecycle webhooks. The public endpoints are rate-limited " +
      "30 requests per minute per IP; authenticated endpoints use a " +
      "partner-issued API key with the 'marketplace:read' permission.",
    authentication: {
      type: "Bearer API key",
      description:
        "All write-premium endpoints require a marketplace API key issued via the partner portal. " +
        "The key is sent as a Bearer token in the Authorization header. Keys are partner-scoped " +
        "and carry the 'marketplace:read' permission; they can be revoked at any time. " +
        "Public listing + single-post GET endpoints require NO authentication.",
      header_format: "Authorization: Bearer asp_xxxxxxxxxxxxxxxxxxxxxxxx",
      key_prefix: "asp_",
      how_to_create: {
        endpoint: "POST /api/marketplace/api-keys",
        method: "POST",
        auth_required: "Portal partner session (cookie).",
        body: {
          name: "Human-readable label for the key (shown in the partner's API Keys list).",
          expires_at: "Optional ISO 8601 timestamp. When set, the key expires at that time.",
        },
      },
    },
    rate_limits: {
      public_endpoints: { requests_per_minute_per_ip: 30, window_seconds: 60 },
      authenticated_endpoints: { requests_per_minute_per_ip: 30, window_seconds: 60 },
      headers_returned: [
        "X-RateLimit-Limit — the per-minute cap (30).",
        "X-RateLimit-Remaining — remaining requests in the current window.",
        "X-RateLimit-Reset — seconds until the window resets (60).",
        "Retry-After (only on 429 responses) — seconds to wait before retrying.",
      ],
    },
    endpoints: [
      {
        method: "GET",
        path: "/api/marketplace/public",
        description:
          "Public listing of marketplace posts (no auth). Returns redacted data — no partner PII, " +
          "only company name + country + verification level + rating.",
        auth: "none",
        query_params: {
          type: "Optional. One of: buy, sell, auction, contract.",
          category: "Optional. Product category (e.g. 'Metals').",
          country: "Optional. ISO 3166-1 alpha-2 delivery country.",
          search: "Optional. Free-text search across product_name + description + category.",
          page: "Optional. 1-indexed page (default 1).",
          limit: "Optional. Page size (default 24, max 100).",
        },
        example_request: "GET /api/marketplace/public?type=sell&category=Metals&page=1&limit=24",
        example_response_snippet:
          '{ "items": [ { "id": "...", "product_name": "Aluminium Ingots", "quantity": 500, "unit": "MT", "currency": "USD", "target_price": 2350, "partner": { "company_name": "...", "country": "AE", "verification_level": "gold", "rating_average": 4.8, "rating_count": 12 } } ], "total": 247, "page": 1, "limit": 24 }',
      },
      {
        method: "GET",
        path: "/api/marketplace/public/[id]",
        description:
          "Public view of a single post. Increments view count. Returns the post details + the public " +
          "partner info (company name, country, verification badge, rating).",
        auth: "none",
        example_request: "GET /api/marketplace/public/0d1f...-...-...",
        example_response_snippet:
          '{ "post": { "id": "...", "product_name": "...", "partner": { ... } } }',
      },
      {
        method: "GET",
        path: "/api/marketplace/public/docs",
        description: "This endpoint. Returns the API documentation as JSON.",
        auth: "none",
      },
      {
        method: "GET",
        path: "/api/marketplace/api-keys",
        description: "List the calling partner's marketplace API keys (without key_hash).",
        auth: "api_key",
      },
      {
        method: "POST",
        path: "/api/marketplace/api-keys",
        description:
          "Create a new marketplace API key. The full key string is returned ONCE in the response — " +
          "store it in a secret manager; the hashed form is what's persisted server-side.",
        auth: "api_key",
      },
      {
        method: "DELETE",
        path: "/api/marketplace/api-keys?id=<keyId>",
        description: "Revoke a marketplace API key. Only the partner that created the key can revoke it.",
        auth: "api_key",
      },
      {
        method: "POST",
        path: "/api/marketplace/integrations/track-container",
        description:
          "Track a shipping container via the carrier's tracking API. Placeholder integration — " +
          "returns deterministic mock data when no carrier API key is configured.",
        auth: "api_key",
      },
    ],
    webhooks: {
      description:
        "Webhooks fire on marketplace lifecycle events. Subscribe via the Webhooks admin view " +
        "(Webhooks → New → select marketplace events). Each delivery is HMAC-SHA256 signed; " +
        "verify the signature on receipt using your webhook secret.",
      signature_header: "X-Webhook-Signature",
      signature_algorithm: "HMAC-SHA256 (hex-encoded digest of the raw JSON body)",
      events: [
        { name: "marketplace.post_created", description: "A partner published a new marketplace post.", entity_type: "marketplace_post" },
        { name: "marketplace.response_sent", description: "A partner sent a response (offer / counter) on a post.", entity_type: "marketplace_response" },
        { name: "marketplace.response_accepted", description: "The post owner accepted a response.", entity_type: "marketplace_response" },
        { name: "marketplace.message_sent", description: "A new message was sent in a negotiation room.", entity_type: "marketplace_message" },
        { name: "marketplace.bid_placed", description: "A bid was placed on an auction post (sealed bids hide the amount).", entity_type: "marketplace_auction_bid" },
        { name: "marketplace.auction_won", description: "An auction ended with a winner (settled by the auction-sweep cron).", entity_type: "marketplace_post" },
        { name: "marketplace.shipment_status", description: "A shipment tracking event was appended (status transition).", entity_type: "marketplace_shipment" },
        { name: "marketplace.document_signed", description: "A trade document was digitally signed.", entity_type: "marketplace_trade_document" },
        { name: "marketplace.api_key_created", description: "A partner created a new marketplace API key.", entity_type: "api_key" },
        { name: "marketplace.api_key_revoked", description: "A marketplace API key was revoked.", entity_type: "api_key" },
      ],
    },
    errors: {
      "400": "Bad request — malformed body, invalid query param, or invalid enum value.",
      "401": "Unauthenticated — no API key for an authenticated endpoint, or an invalid / expired key.",
      "402": "Subscription expired — the tenant's subscription has lapsed; renew to restore access.",
      "403": "Forbidden — the API key lacks the 'marketplace:read' permission, or the partner doesn't own the resource.",
      "404": "Not found — the post doesn't exist, isn't active, or is private.",
      "429": "Rate limit exceeded — retry after the Retry-After header (in seconds).",
      "500": "Internal server error — the operation failed unexpectedly.",
      "502": "Upstream integration error — the carrier / bank / customs API returned an error.",
    },
  };

  return NextResponse.json(docs, {
    headers: {
      "Cache-Control": "public, max-age=300, s-maxage=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export const GET = withApm(_get, "GET /api/marketplace/public/docs");
