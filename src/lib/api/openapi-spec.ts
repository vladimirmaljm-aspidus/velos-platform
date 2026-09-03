/**
 * OpenAPI 3.0 specification for the VELOS Trade API.
 *
 * ─── Why a curated spec instead of auto-generation? ─────────────────────────
 * The VELOS platform exposes 222+ Next.js route handlers under `src/app/api/`.
 * Auto-scanning them would require either:
 *   (a) a build-time script that imports every route module to introspect the
 *       exported GET/POST/PUT/DELETE methods (Next.js route handlers are not
 *       reflectable — there is no decorator or metadata API), or
 *   (b) a runtime filesystem walk that can't run inside the Next.js server
 *       bundle (route files are compiled into opaque chunks).
 * Both approaches are brittle and would couple docs to implementation
 * details that change every sprint. Instead, this file is a hand-curated
 * spec covering the ~50 most-used endpoints — the ones integrators
 * actually call (auth, partners, products, offers, invoices, proformas,
 * trade calculator, deals, demands, portal, settings, users, system).
 *
 * ─── Keeping this in sync with code ────────────────────────────────────────
 * When you add a new public-facing route, add a matching entry here. The
 * `npm run` story is: open `/api-docs` in the browser (admin only) and
 * eyeball the new endpoint. The JSON spec is also served at
 * `/api/openapi-json` so external tools (Postman, Stoplight, etc.) can
 * import it.
 *
 * ─── Auth model ────────────────────────────────────────────────────────────
 * Two schemes are supported:
 *   1. `cookie` — the session cookie set by POST /api/auth/login. Used by
 *      the in-app Swagger UI (the browser sends the cookie automatically).
 *   2. `apiKey` — the `Authorization: Bearer asp_xxx` header used by API
 *      keys (managed under Settings → API Keys in the UI, or via
 *      /api/api-keys). Required for all programmatic integrations.
 * Endpoints that don't require auth (e.g. /api/health, /api/auth/login,
 * /api/portal/login) declare `security: []`.
 *
 * ─── Multi-tenancy ─────────────────────────────────────────────────────────
 * All tenant-scoped endpoints read `tenant_id` from the auth context
 * (cookie session or API key). Super-admins can override the active tenant
 * by passing `?tenant_id=<uuid>` as a query param — this is reflected in
 * the `tenant_id` query parameter on every tenant-scoped GET.
 */

// ─── Reusable type shortcuts ─────────────────────────────────────────────────
// We use `as const` on the literal so the JSON-serialisable shape is
// preserved exactly (no widening to `string`), but type the export as
// `OpenAPISpec` so consumers (route.ts, page.tsx) get a stable contract.

export interface OpenAPISpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
    contact?: { name: string; url: string };
    license?: { name: string; url: string };
  };
  servers: { url: string; description: string }[];
  tags: {
    name: string;
    description: string;
  }[];
  components: {
    securitySchemes: Record<string, unknown>;
    schemas?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
  };
  paths: Record<string, Record<string, unknown>>;
}

// ─── Reusable response fragments ─────────────────────────────────────────────
// Every CRUD endpoint returns the same 4-error shape on failure, so we
// centralise them here and spread them into each operation's `responses`.

const ERROR_400 = {
  description: "Bad request — malformed JSON, missing required field, or invalid value.",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Error" },
    },
  },
};

const ERROR_401 = {
  description: "Unauthorized — no session cookie and no API key, or the API key is revoked.",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Error" },
    },
  },
};

const ERROR_403 = {
  description: "Forbidden — the caller is authenticated but lacks the required permission (e.g. `offers.read`).",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Error" },
    },
  },
};

const ERROR_404 = {
  description: "Not found — the resource doesn't exist OR exists in a different tenant (defense-in-depth: the route never reveals which).",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Error" },
    },
  },
};

const ERROR_409 = {
  description: "Conflict — a duplicate (SKU, tax_id, name) was submitted. The `existing` payload contains the conflicting row so the client can decide whether to retry with `force: true`.",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Error" },
    },
  },
};

const ERROR_429 = {
  description: "Too many requests — per-IP rate limit hit. See `Retry-After` header.",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Error" },
    },
  },
  headers: {
    "Retry-After": {
      schema: { type: "integer" },
      description: "Seconds until the caller may retry.",
    },
  },
};

const ERROR_500 = {
  description: "Server error — see Sentry for the stack trace. The response body is sanitised (no internal details leak to the client).",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Error" },
    },
  },
};

/** The standard set of errors every authenticated CRUD endpoint can return. */
const stdErrors = {
  400: ERROR_400,
  401: ERROR_401,
  403: ERROR_403,
  404: ERROR_404,
  500: ERROR_500,
};

/** CRUD endpoints that may detect duplicates (products, partners). */
const crudWithConflictErrors = {
  400: ERROR_400,
  401: ERROR_401,
  403: ERROR_403,
  404: ERROR_404,
  409: ERROR_409,
  500: ERROR_500,
};

/** Endpoints that don't require auth (health, login). */
const publicErrors = {
  400: ERROR_400,
  500: ERROR_500,
};

/** Endpoints that have a per-IP rate limit (login, password reset). */
const rateLimitedErrors = {
  400: ERROR_400,
  401: ERROR_401,
  423: {
    description: "Locked — account is temporarily locked after 5 failed attempts. Retry after `retry_after` seconds.",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/Error" },
      },
    },
    headers: {
      "Retry-After": {
        schema: { type: "integer" },
        description: "Seconds until the lock expires.",
      },
    },
  },
  429: ERROR_429,
  500: ERROR_500,
};

// ─── Reusable parameter fragments ────────────────────────────────────────────

const PARAM_ID = {
  name: "id",
  in: "path",
  required: true,
  description: "Resource UUID.",
  schema: { type: "string", format: "uuid" },
};

const PARAM_TENANT_ID = {
  name: "tenant_id",
  in: "query",
  required: false,
  description: "Super-admin override: target a different tenant than the caller's own. Ignored for non-super-admin callers (their own tenant_id is always used).",
  schema: { type: "string", format: "uuid" },
};

const PARAM_SEARCH = {
  name: "search",
  in: "query",
  required: false,
  description: "Case-insensitive partial match against the resource's primary text fields (name, sku, email, etc.).",
  schema: { type: "string" },
};

const PARAM_LIMIT = {
  name: "limit",
  in: "query",
  required: false,
  description: "Maximum number of items to return. Capped at 500 server-side.",
  schema: { type: "integer", minimum: 1, maximum: 500, default: 50 },
};

const PARAM_OFFSET = {
  name: "offset",
  in: "query",
  required: false,
  description: "Number of items to skip for pagination.",
  schema: { type: "integer", minimum: 0, default: 0 },
};

const PARAM_STATUS = {
  name: "status",
  in: "query",
  required: false,
  description: "Filter by workflow status (e.g. `draft`, `sent`, `accepted`, `paid`).",
  schema: { type: "string" },
};

// ─── Reusable security declarations ──────────────────────────────────────────

const SEC_AUTHED = [
  { cookie: [] },
  { apiKey: [] },
];

const SEC_PUBLIC: never[] = [];

// ─── Reusable request bodies ─────────────────────────────────────────────────

const JSON_BODY = (schemaRef: string, description: string) => ({
  description,
  required: true,
  content: {
    "application/json": {
      schema: { $ref: schemaRef },
    },
  },
});

// ─── The spec itself ─────────────────────────────────────────────────────────

export const openApiSpec: OpenAPISpec = {
  openapi: "3.0.0",
  info: {
    title: "VELOS Trade API",
    version: "1.0.0",
    description:
      "Multi-tenant trade CRM/ERP API for commodity traders. Covers partners, products, " +
      "offers, invoices, proformas, trade calculator, deals, demands, the client portal, " +
      "settings, users, and system endpoints.\n\n" +
      "## Authentication\n" +
      "Two schemes are accepted on every authenticated endpoint:\n" +
      "- **cookie** — the `session` cookie set by `POST /api/auth/login`. Used by the in-app Swagger UI.\n" +
      "- **apiKey** — `Authorization: Bearer asp_xxx` header. Required for programmatic integrations; create keys under Settings → API Keys.\n\n" +
      "## Multi-tenancy\n" +
      "Tenant scoping is implicit: the caller's `tenant_id` is read from the auth context. " +
      "Super-admins can pass `?tenant_id=<uuid>` to act on a different tenant.\n\n" +
      "## Errors\n" +
      "All error responses use the `Error` schema: `{ error: string, duplicate?: string, existing?: object }`. " +
      "Server-error bodies are sanitised (no stack traces leak).",
    contact: {
      name: "VELOS Trade Platform",
      url: process.env.APP_BASE_URL || "https://velos-platform.vercel.app",
    },
  },
  servers: [
    // Stale Render host replaced with the live Vercel deployment (audit 4-d
    // metadataBase fix) — same APP_BASE_URL fallback pattern as lib/pdf/qr.ts.
    { url: process.env.APP_BASE_URL || "https://velos-platform.vercel.app", description: "Production" },
    { url: "http://localhost:3000", description: "Local development" },
  ],
  tags: [
    { name: "Auth", description: "Session login, logout, current-user lookup." },
    { name: "Products", description: "Product master data (SKU, name, category, unit)." },
    { name: "Partners", description: "Customers, suppliers, and other business partners." },
    { name: "Offers", description: "Sales offers (quotations) issued to partners." },
    { name: "Invoices", description: "Sales invoices and payment recording." },
    { name: "Proformas", description: "Proforma invoices (pre-payment documents)." },
    { name: "Supplier Offers", description: "Inbound quotes from suppliers (cost side)." },
    { name: "Trade", description: "Trade calculator — margin/cost modelling that produces offers." },
    { name: "Deals", description: "Won trade deals (offer accepted + supplier offer matched)." },
    { name: "Demands", description: "Inbound demand notices (RFQs from internal teams or partners)." },
    { name: "Portal", description: "Client-facing portal — login, catalog, offers, invoices, documents, KYC, RFQs." },
    { name: "Settings", description: "Tenant-scoped settings: branding, SMTP, rate limits." },
    { name: "Users", description: "Tenant user management (CRUD + role assignment)." },
    { name: "System", description: "Health, dashboard, search, audit, exchange rates." },
  ],
  components: {
    securitySchemes: {
      apiKey: {
        type: "apiKey",
        in: "header",
        name: "Authorization",
        description: "API key. Format: `Bearer asp_xxx`. Create under Settings → API Keys.",
      },
      cookie: {
        type: "apiKey",
        in: "cookie",
        name: "session",
        description: "Session cookie set by `POST /api/auth/login`. Sent automatically by browsers.",
      },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: { type: "string", description: "Human-readable error message." },
          duplicate: {
            type: "string",
            enum: ["sku", "name", "tax_id", "vat_number"],
            description: "On 409: which field caused the duplicate.",
          },
          existing: {
            type: "object",
            description: "On 409: the conflicting row (id + identifying fields) so the client can decide whether to retry with `force: true`.",
          },
          retry_after: {
            type: "integer",
            description: "On 423/429: seconds until the caller may retry.",
          },
          locked_until: {
            type: "string",
            format: "date-time",
            description: "On 423: ISO-8601 timestamp when the account unlocks.",
          },
        },
      },
      ListResponse: {
        type: "object",
        required: ["items", "total"],
        properties: {
          items: { type: "array", items: { type: "object" } },
          total: { type: "integer", description: "Total count of matching rows (before limit/offset)." },
        },
      },
      LoginRequest: {
        type: "object",
        required: ["username", "password"],
        properties: {
          username: { type: "string" },
          password: { type: "string", format: "password" },
        },
      },
      Product: {
        type: "object",
        required: ["name", "tenant_id"],
        properties: {
          id: { type: "string", format: "uuid" },
          tenant_id: { type: "string", format: "uuid" },
          sku: { type: "string", description: "Stock-keeping unit. Unique within the tenant." },
          name: { type: "string" },
          category: { type: "string" },
          unit: { type: "string", description: "e.g. `MT`, `KG`, `L`." },
          price: { type: "number", format: "double" },
          currency: { type: "string", description: "ISO 4217 code, e.g. `USD`." },
          active: { type: "boolean" },
          show_in_catalog: { type: "boolean", description: "Surface in the portal catalog." },
        },
      },
      Partner: {
        type: "object",
        required: ["name", "tenant_id"],
        properties: {
          id: { type: "string", format: "uuid" },
          tenant_id: { type: "string", format: "uuid" },
          name: { type: "string" },
          type: { type: "string", enum: ["customer", "supplier", "both"] },
          status: { type: "string", enum: ["active", "inactive", "blocked"] },
          country: { type: "string", description: "ISO 3166-1 alpha-2 code." },
          email: { type: "string", format: "email" },
          phone: { type: "string" },
          tax_id: { type: "string" },
          vat_number: { type: "string" },
          address: { type: "string" },
        },
      },
      Offer: {
        type: "object",
        required: ["partner_id", "tenant_id"],
        properties: {
          id: { type: "string", format: "uuid" },
          tenant_id: { type: "string", format: "uuid" },
          number: { type: "string", description: "Human-readable offer number (e.g. `OFR-2025-0001`)." },
          partner_id: { type: "string", format: "uuid" },
          status: { type: "string", enum: ["draft", "sent", "accepted", "rejected", "expired", "cancelled"] },
          issue_date: { type: "string", format: "date" },
          valid_until: { type: "string", format: "date" },
          currency: { type: "string" },
          subtotal: { type: "number" },
          tax: { type: "number" },
          total: { type: "number" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                product_id: { type: "string", format: "uuid" },
                description: { type: "string" },
                quantity: { type: "number" },
                unit: { type: "string" },
                unit_price: { type: "number" },
                line_total: { type: "number" },
              },
            },
          },
        },
      },
      Invoice: {
        type: "object",
        required: ["partner_id", "tenant_id"],
        properties: {
          id: { type: "string", format: "uuid" },
          tenant_id: { type: "string", format: "uuid" },
          number: { type: "string", description: "Invoice number (e.g. `INV-2025-0001`)." },
          partner_id: { type: "string", format: "uuid" },
          offer_id: { type: "string", format: "uuid", nullable: true },
          status: { type: "string", enum: ["draft", "sent", "paid", "partial", "overdue", "cancelled"] },
          issue_date: { type: "string", format: "date" },
          due_date: { type: "string", format: "date" },
          currency: { type: "string" },
          subtotal: { type: "number" },
          tax: { type: "number" },
          total: { type: "number" },
          paid_amount: { type: "number" },
        },
      },
      Proforma: {
        type: "object",
        required: ["partner_id", "tenant_id"],
        properties: {
          id: { type: "string", format: "uuid" },
          tenant_id: { type: "string", format: "uuid" },
          number: { type: "string" },
          partner_id: { type: "string", format: "uuid" },
          offer_id: { type: "string", format: "uuid", nullable: true },
          status: { type: "string", enum: ["draft", "sent", "paid", "cancelled"] },
          issue_date: { type: "string", format: "date" },
          due_date: { type: "string", format: "date" },
          currency: { type: "string" },
          total: { type: "number" },
        },
      },
      SupplierOffer: {
        type: "object",
        required: ["partner_id", "tenant_id"],
        properties: {
          id: { type: "string", format: "uuid" },
          tenant_id: { type: "string", format: "uuid" },
          partner_id: { type: "string", format: "uuid", description: "Supplier partner." },
          product_id: { type: "string", format: "uuid" },
          status: { type: "string", enum: ["draft", "received", "accepted", "rejected", "expired"] },
          unit_price: { type: "number" },
          currency: { type: "string" },
          quantity: { type: "number" },
          unit: { type: "string" },
          valid_until: { type: "string", format: "date" },
        },
      },
      TradeCalculation: {
        type: "object",
        required: ["tenant_id"],
        properties: {
          id: { type: "string", format: "uuid" },
          tenant_id: { type: "string", format: "uuid" },
          product_id: { type: "string", format: "uuid" },
          partner_id: { type: "string", format: "uuid" },
          supplier_offer_id: { type: "string", format: "uuid", nullable: true },
          quantity: { type: "number" },
          unit: { type: "string" },
          sale_price: { type: "number" },
          purchase_price: { type: "number" },
          currency: { type: "string" },
          logistics_cost: { type: "number" },
          duties_cost: { type: "number" },
          commission: { type: "number" },
          margin: { type: "number", description: "Computed gross margin." },
          margin_pct: { type: "number", description: "Computed margin as a fraction of sale price." },
        },
      },
      Deal: {
        type: "object",
        required: ["partner_id", "tenant_id"],
        properties: {
          id: { type: "string", format: "uuid" },
          tenant_id: { type: "string", format: "uuid" },
          number: { type: "string" },
          partner_id: { type: "string", format: "uuid" },
          offer_id: { type: "string", format: "uuid", nullable: true },
          supplier_offer_id: { type: "string", format: "uuid", nullable: true },
          status: { type: "string", enum: ["pending", "won", "lost", "cancelled"] },
          expected_value: { type: "number" },
          currency: { type: "string" },
          close_date: { type: "string", format: "date" },
        },
      },
      Demand: {
        type: "object",
        required: ["tenant_id"],
        properties: {
          id: { type: "string", format: "uuid" },
          tenant_id: { type: "string", format: "uuid" },
          partner_id: { type: "string", format: "uuid", nullable: true },
          product_id: { type: "string", format: "uuid", nullable: true },
          status: { type: "string", enum: ["open", "quoted", "closed", "cancelled"] },
          quantity: { type: "number" },
          unit: { type: "string" },
          target_price: { type: "number" },
          currency: { type: "string" },
          notes: { type: "string" },
        },
      },
      PortalLoginRequest: {
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string", format: "password" },
        },
      },
      User: {
        type: "object",
        required: ["username", "email", "tenant_id"],
        properties: {
          id: { type: "string", format: "uuid" },
          tenant_id: { type: "string", format: "uuid" },
          username: { type: "string" },
          email: { type: "string", format: "email" },
          full_name: { type: "string" },
          role: { type: "string", enum: ["admin", "manager", "sales", "accountant", "viewer"] },
          active: { type: "boolean" },
          permissions: { type: "array", items: { type: "string" } },
        },
      },
      Settings: {
        type: "object",
        description: "Tenant-scoped settings. Shape is intentionally flexible — tenants configure branding, defaults, integrations, etc.",
        additionalProperties: true,
      },
      HealthResponse: {
        type: "object",
        required: ["status"],
        properties: {
          status: { type: "string", enum: ["ok", "degraded"] },
          db: { type: "string", enum: ["connected", "error", "not_configured"] },
          error: { type: "string", description: "Present only when db=error." },
        },
      },
    },
    parameters: {
      Id: PARAM_ID,
      TenantId: PARAM_TENANT_ID,
      Search: PARAM_SEARCH,
      Limit: PARAM_LIMIT,
      Offset: PARAM_OFFSET,
      Status: PARAM_STATUS,
    },
  },
  paths: {
    // ═══════════════════════════════════════════════════════════════════════
    // AUTH
    // ═══════════════════════════════════════════════════════════════════════
    "/api/auth/login": {
      post: {
        summary: "Login",
        description:
          "Exchange username + password for a session cookie. The cookie is HttpOnly, " +
          "Secure (in production), and SameSite=Lax. TTL is 7 days.\n\n" +
          "Per-IP rate limited (default 20 attempts / 15 min, configurable by super-admins). " +
          "After 5 failed attempts the account is locked for 15 minutes. The response is " +
          "identical for 'wrong password' and 'unknown user' to prevent enumeration.",
        tags: ["Auth"],
        security: SEC_PUBLIC,
        requestBody: JSON_BODY("#/components/schemas/LoginRequest", "Credentials."),
        responses: {
          200: {
            description: "Authenticated. The `Set-Cookie` header carries the session.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    user: { $ref: "#/components/schemas/User" },
                  },
                },
              },
            },
          },
          ...rateLimitedErrors,
        },
      },
    },
    "/api/auth/logout": {
      post: {
        summary: "Logout",
        description: "Revoke the current session cookie and invalidate the row in `sessions`.",
        tags: ["Auth"],
        security: SEC_AUTHED,
        responses: {
          200: { description: "Logged out. The `Set-Cookie` header clears the session cookie." },
          ...publicErrors,
        },
      },
    },
    "/api/auth/logout-all": {
      post: {
        summary: "Logout all sessions",
        description: "Revoke every active session for the caller (bump `token_version`). Useful after a suspected credential leak.",
        tags: ["Auth"],
        security: SEC_AUTHED,
        responses: {
          200: { description: "All sessions revoked." },
          401: ERROR_401,
          500: ERROR_500,
        },
      },
    },
    "/api/auth/me": {
      get: {
        summary: "Current user",
        description: "Return the caller's user object (or 401 if not authenticated). Used by the SPA on boot to hydrate the auth state.",
        tags: ["Auth"],
        security: SEC_AUTHED,
        responses: {
          200: {
            description: "Authenticated.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    user: { $ref: "#/components/schemas/User" },
                  },
                },
              },
            },
          },
          401: ERROR_401,
          500: ERROR_500,
        },
      },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // PRODUCTS
    // ═══════════════════════════════════════════════════════════════════════
    "/api/products": {
      get: {
        summary: "List products",
        description: "Paginated list of products in the caller's tenant. Defense-in-depth: results are post-filtered by `tenant_id` even though the SupabaseStore already enforces RLS.",
        tags: ["Products"],
        security: SEC_AUTHED,
        parameters: [PARAM_TENANT_ID, PARAM_SEARCH, { $ref: "#/components/parameters/Status" }, PARAM_LIMIT, PARAM_OFFSET],
        responses: {
          200: {
            description: "Paginated list.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/ListResponse" },
                    {
                      type: "object",
                      properties: {
                        items: {
                          type: "array",
                          items: { $ref: "#/components/schemas/Product" },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          ...stdErrors,
        },
      },
      post: {
        summary: "Create or update a product",
        description:
          "If `id` is omitted, creates a new product (subject to plan-quota enforcement). " +
          "If `id` is present, updates the existing product. " +
          "SKU collisions are a hard 409; name collisions are a soft 409 (retry with `force: true` to override).",
        tags: ["Products"],
        security: SEC_AUTHED,
        parameters: [PARAM_TENANT_ID],
        requestBody: JSON_BODY("#/components/schemas/Product", "Product fields. Omit `id` to create, include to update."),
        responses: {
          200: {
            description: "Created or updated.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Product" },
              },
            },
          },
          ...crudWithConflictErrors,
        },
      },
    },
    "/api/products/{id}": {
      get: {
        summary: "Get a product",
        tags: ["Products"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        responses: {
          200: {
            description: "The product.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Product" },
              },
            },
          },
          ...stdErrors,
        },
      },
      put: {
        summary: "Update a product",
        tags: ["Products"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        requestBody: JSON_BODY("#/components/schemas/Product", "Product fields. `id` in the path takes precedence."),
        responses: {
          200: {
            description: "Updated.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Product" },
              },
            },
          },
          ...crudWithConflictErrors,
        },
      },
      delete: {
        summary: "Delete a product",
        description: "Soft-deletes (sets `active=false`) when the product is referenced by historical documents; hard-deletes when no references exist.",
        tags: ["Products"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        responses: {
          204: { description: "Deleted." },
          ...stdErrors,
        },
      },
    },
    "/api/products/export": {
      get: {
        summary: "Export products (CSV)",
        description: "Stream all products as a CSV download. Same filters as GET /api/products.",
        tags: ["Products"],
        security: SEC_AUTHED,
        parameters: [PARAM_TENANT_ID, PARAM_SEARCH],
        responses: {
          200: {
            description: "CSV file.",
            content: {
              "text/csv": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
          ...stdErrors,
        },
      },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // PARTNERS
    // ═══════════════════════════════════════════════════════════════════════
    "/api/partners": {
      get: {
        summary: "List partners",
        tags: ["Partners"],
        security: SEC_AUTHED,
        parameters: [
          PARAM_TENANT_ID,
          PARAM_SEARCH,
          { name: "type", in: "query", schema: { type: "string", enum: ["customer", "supplier", "both"] } },
          { $ref: "#/components/parameters/Status" },
          PARAM_LIMIT,
          PARAM_OFFSET,
        ],
        responses: {
          200: {
            description: "Paginated list. `portal_token` is stripped from every row (defense-in-depth).",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/ListResponse" },
                    {
                      type: "object",
                      properties: {
                        items: {
                          type: "array",
                          items: { $ref: "#/components/schemas/Partner" },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          ...stdErrors,
        },
      },
      post: {
        summary: "Create or update a partner",
        description:
          "If `id` is omitted, creates. If present, updates. " +
          "`tax_id` / `vat_number` collisions are hard 409s; name collisions are soft (retry with `force: true`).",
        tags: ["Partners"],
        security: SEC_AUTHED,
        parameters: [PARAM_TENANT_ID],
        requestBody: JSON_BODY("#/components/schemas/Partner", "Partner fields."),
        responses: {
          200: {
            description: "Created or updated.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Partner" },
              },
            },
          },
          ...crudWithConflictErrors,
        },
      },
    },
    "/api/partners/{id}": {
      get: {
        summary: "Get a partner",
        tags: ["Partners"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        responses: {
          200: {
            description: "The partner.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Partner" },
              },
            },
          },
          ...stdErrors,
        },
      },
      put: {
        summary: "Update a partner",
        tags: ["Partners"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        requestBody: JSON_BODY("#/components/schemas/Partner", "Partner fields."),
        responses: {
          200: {
            description: "Updated.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Partner" },
              },
            },
          },
          ...crudWithConflictErrors,
        },
      },
      delete: {
        summary: "Delete a partner",
        description: "Refused (409) if the partner is referenced by any offer/invoice/deal — you must reassign or archive those first.",
        tags: ["Partners"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        responses: {
          204: { description: "Deleted." },
          ...crudWithConflictErrors,
        },
      },
    },
    "/api/partners/export": {
      get: {
        summary: "Export partners (CSV)",
        tags: ["Partners"],
        security: SEC_AUTHED,
        parameters: [PARAM_TENANT_ID, PARAM_SEARCH],
        responses: {
          200: {
            description: "CSV file.",
            content: {
              "text/csv": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
          ...stdErrors,
        },
      },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // OFFERS
    // ═══════════════════════════════════════════════════════════════════════
    "/api/offers": {
      get: {
        summary: "List offers",
        tags: ["Offers"],
        security: SEC_AUTHED,
        parameters: [
          PARAM_TENANT_ID,
          PARAM_SEARCH,
          { name: "partner_id", in: "query", schema: { type: "string", format: "uuid" } },
          { $ref: "#/components/parameters/Status" },
          PARAM_LIMIT,
          PARAM_OFFSET,
        ],
        responses: {
          200: {
            description: "Paginated list.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/ListResponse" },
                    {
                      type: "object",
                      properties: {
                        items: {
                          type: "array",
                          items: { $ref: "#/components/schemas/Offer" },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          ...stdErrors,
        },
      },
      post: {
        summary: "Create or update an offer",
        tags: ["Offers"],
        security: SEC_AUTHED,
        parameters: [PARAM_TENANT_ID],
        requestBody: JSON_BODY("#/components/schemas/Offer", "Offer fields including line items."),
        responses: {
          200: {
            description: "Created or updated.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Offer" },
              },
            },
          },
          ...stdErrors,
        },
      },
    },
    "/api/offers/{id}": {
      get: {
        summary: "Get an offer",
        tags: ["Offers"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        responses: {
          200: {
            description: "The offer with line items.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Offer" },
              },
            },
          },
          ...stdErrors,
        },
      },
      put: {
        summary: "Update an offer",
        description: "Only allowed while the offer is in `draft` status. Once `sent`, use a revision endpoint or cancel + recreate.",
        tags: ["Offers"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        requestBody: JSON_BODY("#/components/schemas/Offer", "Offer fields."),
        responses: {
          200: {
            description: "Updated.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Offer" },
              },
            },
          },
          ...stdErrors,
        },
      },
      delete: {
        summary: "Delete an offer",
        description: "Refused if the offer has been sent (use `cancel` instead). Draft offers can be hard-deleted.",
        tags: ["Offers"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        responses: {
          204: { description: "Deleted." },
          ...stdErrors,
        },
      },
    },
    "/api/offers/{id}/pdf": {
      get: {
        summary: "Download offer PDF",
        description: "Generate (or fetch cached) the branded PDF for the offer. Uses the tenant's letterhead and document template.",
        tags: ["Offers"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        responses: {
          200: {
            description: "PDF file.",
            content: {
              "application/pdf": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
          ...stdErrors,
        },
      },
    },
    "/api/offers/{id}/send": {
      post: {
        summary: "Email the offer to the partner",
        description: "Generates the PDF, sets status to `sent`, and emails the partner via the mail queue. The partner receives a portal link (no login required to view, but a portal session is required to accept).",
        tags: ["Offers"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        requestBody: {
          description: "Optional email overrides.",
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  to: { type: "string", format: "email", description: "Override the partner's primary email." },
                  cc: { type: "string" },
                  bcc: { type: "string" },
                  subject: { type: "string" },
                  message: { type: "string", description: "Custom cover note. Defaults to the tenant's offer template." },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Queued. The mail-queue row id is returned for delivery tracking.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    mail_queue_id: { type: "string", format: "uuid" },
                  },
                },
              },
            },
          },
          ...stdErrors,
        },
      },
    },
    "/api/offers/export": {
      get: {
        summary: "Export offers (CSV)",
        tags: ["Offers"],
        security: SEC_AUTHED,
        parameters: [PARAM_TENANT_ID, PARAM_SEARCH],
        responses: {
          200: {
            description: "CSV file.",
            content: {
              "text/csv": { schema: { type: "string", format: "binary" } },
            },
          },
          ...stdErrors,
        },
      },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // INVOICES
    // ═══════════════════════════════════════════════════════════════════════
    "/api/invoices": {
      get: {
        summary: "List invoices",
        description: "Feature-gated: requires `module_finance` to be enabled for the tenant.",
        tags: ["Invoices"],
        security: SEC_AUTHED,
        parameters: [
          PARAM_TENANT_ID,
          PARAM_SEARCH,
          { name: "partner_id", in: "query", schema: { type: "string", format: "uuid" } },
          { $ref: "#/components/parameters/Status" },
          PARAM_LIMIT,
          PARAM_OFFSET,
        ],
        responses: {
          200: {
            description: "Paginated list.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/ListResponse" },
                    {
                      type: "object",
                      properties: {
                        items: {
                          type: "array",
                          items: { $ref: "#/components/schemas/Invoice" },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          ...stdErrors,
        },
      },
      post: {
        summary: "Create or update an invoice",
        tags: ["Invoices"],
        security: SEC_AUTHED,
        parameters: [PARAM_TENANT_ID],
        requestBody: JSON_BODY("#/components/schemas/Invoice", "Invoice fields."),
        responses: {
          200: {
            description: "Created or updated.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Invoice" },
              },
            },
          },
          ...stdErrors,
        },
      },
    },
    "/api/invoices/{id}": {
      get: {
        summary: "Get an invoice",
        tags: ["Invoices"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        responses: {
          200: {
            description: "The invoice.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Invoice" },
              },
            },
          },
          ...stdErrors,
        },
      },
      put: {
        summary: "Update an invoice",
        description: "Only allowed while in `draft`. Once `sent`, payments must be recorded via /record-payment.",
        tags: ["Invoices"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        requestBody: JSON_BODY("#/components/schemas/Invoice", "Invoice fields."),
        responses: {
          200: {
            description: "Updated.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Invoice" },
              },
            },
          },
          ...stdErrors,
        },
      },
    },
    "/api/invoices/{id}/pdf": {
      get: {
        summary: "Download invoice PDF",
        tags: ["Invoices"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        responses: {
          200: {
            description: "PDF file.",
            content: {
              "application/pdf": { schema: { type: "string", format: "binary" } },
            },
          },
          ...stdErrors,
        },
      },
    },
    "/api/invoices/{id}/send": {
      post: {
        summary: "Email the invoice to the partner",
        tags: ["Invoices"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        requestBody: {
          description: "Optional email overrides (same shape as /offers/{id}/send).",
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  to: { type: "string", format: "email" },
                  cc: { type: "string" },
                  bcc: { type: "string" },
                  subject: { type: "string" },
                  message: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Queued.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    mail_queue_id: { type: "string", format: "uuid" },
                  },
                },
              },
            },
          },
          ...stdErrors,
        },
      },
    },
    "/api/invoices/{id}/record-payment": {
      post: {
        summary: "Record a payment against the invoice",
        description:
          "Atomically records a payment and updates the invoice status (`partial` → `paid` when `paid_amount >= total`). " +
          "Triggers the `invoice.paid` webhook when the invoice transitions to `paid`.",
        tags: ["Invoices"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        requestBody: {
          description: "Payment details.",
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["amount"],
                properties: {
                  amount: { type: "number", description: "Amount paid. Must be > 0 and <= invoice total." },
                  currency: { type: "string", description: "ISO 4217. Defaults to the invoice's currency." },
                  method: { type: "string", enum: ["bank_transfer", "cash", "cheque", "card", "other"] },
                  reference: { type: "string", description: "Bank reference / cheque number." },
                  paid_at: { type: "string", format: "date-time", description: "Defaults to now." },
                  notes: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Payment recorded. Returns the updated invoice.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Invoice" },
              },
            },
          },
          ...stdErrors,
        },
      },
    },
    "/api/invoices/export": {
      get: {
        summary: "Export invoices (CSV)",
        tags: ["Invoices"],
        security: SEC_AUTHED,
        parameters: [PARAM_TENANT_ID, PARAM_SEARCH],
        responses: {
          200: {
            description: "CSV file.",
            content: {
              "text/csv": { schema: { type: "string", format: "binary" } },
            },
          },
          ...stdErrors,
        },
      },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // PROFORMAS
    // ═══════════════════════════════════════════════════════════════════════
    "/api/proformas": {
      get: {
        summary: "List proformas",
        tags: ["Proformas"],
        security: SEC_AUTHED,
        parameters: [
          PARAM_TENANT_ID,
          PARAM_SEARCH,
          { name: "partner_id", in: "query", schema: { type: "string", format: "uuid" } },
          { $ref: "#/components/parameters/Status" },
          PARAM_LIMIT,
          PARAM_OFFSET,
        ],
        responses: {
          200: {
            description: "Paginated list.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/ListResponse" },
                    {
                      type: "object",
                      properties: {
                        items: {
                          type: "array",
                          items: { $ref: "#/components/schemas/Proforma" },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          ...stdErrors,
        },
      },
      post: {
        summary: "Create or update a proforma",
        tags: ["Proformas"],
        security: SEC_AUTHED,
        parameters: [PARAM_TENANT_ID],
        requestBody: JSON_BODY("#/components/schemas/Proforma", "Proforma fields."),
        responses: {
          200: {
            description: "Created or updated.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Proforma" },
              },
            },
          },
          ...stdErrors,
        },
      },
    },
    "/api/proformas/{id}": {
      get: {
        summary: "Get a proforma",
        tags: ["Proformas"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        responses: {
          200: {
            description: "The proforma.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Proforma" },
              },
            },
          },
          ...stdErrors,
        },
      },
      put: {
        summary: "Update a proforma",
        tags: ["Proformas"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        requestBody: JSON_BODY("#/components/schemas/Proforma", "Proforma fields."),
        responses: {
          200: {
            description: "Updated.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Proforma" },
              },
            },
          },
          ...stdErrors,
        },
      },
    },
    "/api/proformas/{id}/pdf": {
      get: {
        summary: "Download proforma PDF",
        tags: ["Proformas"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        responses: {
          200: {
            description: "PDF file.",
            content: {
              "application/pdf": { schema: { type: "string", format: "binary" } },
            },
          },
          ...stdErrors,
        },
      },
    },
    "/api/proformas/{id}/send": {
      post: {
        summary: "Email the proforma to the partner",
        tags: ["Proformas"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        requestBody: {
          description: "Optional email overrides.",
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  to: { type: "string", format: "email" },
                  cc: { type: "string" },
                  subject: { type: "string" },
                  message: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Queued.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    mail_queue_id: { type: "string", format: "uuid" },
                  },
                },
              },
            },
          },
          ...stdErrors,
        },
      },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // SUPPLIER OFFERS
    // ═══════════════════════════════════════════════════════════════════════
    "/api/supplier-offers": {
      get: {
        summary: "List supplier offers",
        tags: ["Supplier Offers"],
        security: SEC_AUTHED,
        parameters: [
          PARAM_TENANT_ID,
          PARAM_SEARCH,
          { name: "partner_id", in: "query", schema: { type: "string", format: "uuid" }, description: "Supplier partner id." },
          { name: "product_id", in: "query", schema: { type: "string", format: "uuid" } },
          { $ref: "#/components/parameters/Status" },
          PARAM_LIMIT,
          PARAM_OFFSET,
        ],
        responses: {
          200: {
            description: "Paginated list.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/ListResponse" },
                    {
                      type: "object",
                      properties: {
                        items: {
                          type: "array",
                          items: { $ref: "#/components/schemas/SupplierOffer" },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          ...stdErrors,
        },
      },
      post: {
        summary: "Create or update a supplier offer",
        tags: ["Supplier Offers"],
        security: SEC_AUTHED,
        parameters: [PARAM_TENANT_ID],
        requestBody: JSON_BODY("#/components/schemas/SupplierOffer", "Supplier offer fields."),
        responses: {
          200: {
            description: "Created or updated.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SupplierOffer" },
              },
            },
          },
          ...stdErrors,
        },
      },
    },
    "/api/supplier-offers/{id}": {
      get: {
        summary: "Get a supplier offer",
        tags: ["Supplier Offers"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        responses: {
          200: {
            description: "The supplier offer.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SupplierOffer" },
              },
            },
          },
          ...stdErrors,
        },
      },
      put: {
        summary: "Update a supplier offer",
        tags: ["Supplier Offers"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        requestBody: JSON_BODY("#/components/schemas/SupplierOffer", "Supplier offer fields."),
        responses: {
          200: {
            description: "Updated.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SupplierOffer" },
              },
            },
          },
          ...stdErrors,
        },
      },
      delete: {
        summary: "Delete a supplier offer",
        tags: ["Supplier Offers"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        responses: {
          204: { description: "Deleted." },
          ...stdErrors,
        },
      },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // TRADE CALCULATOR
    // ═══════════════════════════════════════════════════════════════════════
    "/api/trade-calculator": {
      get: {
        summary: "List trade calculations",
        tags: ["Trade"],
        security: SEC_AUTHED,
        parameters: [PARAM_TENANT_ID, PARAM_SEARCH, PARAM_LIMIT, PARAM_OFFSET],
        responses: {
          200: {
            description: "Paginated list.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/ListResponse" },
                    {
                      type: "object",
                      properties: {
                        items: {
                          type: "array",
                          items: { $ref: "#/components/schemas/TradeCalculation" },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          ...stdErrors,
        },
      },
      post: {
        summary: "Create or update a trade calculation",
        description: "Server recomputes `margin` and `margin_pct` from sale/purchase prices + costs before persisting.",
        tags: ["Trade"],
        security: SEC_AUTHED,
        parameters: [PARAM_TENANT_ID],
        requestBody: JSON_BODY("#/components/schemas/TradeCalculation", "Trade calculation fields."),
        responses: {
          200: {
            description: "Created or updated (with recomputed margins).",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TradeCalculation" },
              },
            },
          },
          ...stdErrors,
        },
      },
    },
    "/api/trade-calculator/{id}": {
      get: {
        summary: "Get a trade calculation",
        tags: ["Trade"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        responses: {
          200: {
            description: "The trade calculation.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TradeCalculation" },
              },
            },
          },
          ...stdErrors,
        },
      },
      put: {
        summary: "Update a trade calculation",
        tags: ["Trade"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        requestBody: JSON_BODY("#/components/schemas/TradeCalculation", "Trade calculation fields."),
        responses: {
          200: {
            description: "Updated.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TradeCalculation" },
              },
            },
          },
          ...stdErrors,
        },
      },
      delete: {
        summary: "Delete a trade calculation",
        tags: ["Trade"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        responses: {
          204: { description: "Deleted." },
          ...stdErrors,
        },
      },
    },
    "/api/trade-calculator/{id}/offer-preview": {
      get: {
        summary: "Preview the offer that would be generated",
        description: "Returns a hydrated offer object (line items, totals) WITHOUT persisting. Useful for showing the user a preview before they click 'Create offer'.",
        tags: ["Trade"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        responses: {
          200: {
            description: "Preview offer (not persisted).",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Offer" },
              },
            },
          },
          ...stdErrors,
        },
      },
    },
    "/api/trade-calculator/{id}/create-offer": {
      post: {
        summary: "Convert the trade calculation into a draft offer",
        description: "Creates a draft offer (status=`draft`) with line items derived from the calculation. The caller can then PUT /api/offers/{id} to finalise and POST /api/offers/{id}/send to email.",
        tags: ["Trade"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        responses: {
          200: {
            description: "Created draft offer.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Offer" },
              },
            },
          },
          ...stdErrors,
        },
      },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // DEALS
    // ═══════════════════════════════════════════════════════════════════════
    "/api/deals": {
      get: {
        summary: "List deals",
        tags: ["Deals"],
        security: SEC_AUTHED,
        parameters: [
          PARAM_TENANT_ID,
          PARAM_SEARCH,
          { name: "partner_id", in: "query", schema: { type: "string", format: "uuid" } },
          { $ref: "#/components/parameters/Status" },
          PARAM_LIMIT,
          PARAM_OFFSET,
        ],
        responses: {
          200: {
            description: "Paginated list.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/ListResponse" },
                    {
                      type: "object",
                      properties: {
                        items: {
                          type: "array",
                          items: { $ref: "#/components/schemas/Deal" },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          ...stdErrors,
        },
      },
      post: {
        summary: "Create or update a deal",
        tags: ["Deals"],
        security: SEC_AUTHED,
        parameters: [PARAM_TENANT_ID],
        requestBody: JSON_BODY("#/components/schemas/Deal", "Deal fields."),
        responses: {
          200: {
            description: "Created or updated.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Deal" },
              },
            },
          },
          ...stdErrors,
        },
      },
    },
    "/api/deals/{id}": {
      get: {
        summary: "Get a deal",
        tags: ["Deals"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        responses: {
          200: {
            description: "The deal.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Deal" },
              },
            },
          },
          ...stdErrors,
        },
      },
      put: {
        summary: "Update a deal",
        tags: ["Deals"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        requestBody: JSON_BODY("#/components/schemas/Deal", "Deal fields."),
        responses: {
          200: {
            description: "Updated.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Deal" },
              },
            },
          },
          ...stdErrors,
        },
      },
      delete: {
        summary: "Delete a deal",
        tags: ["Deals"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        responses: {
          204: { description: "Deleted." },
          ...stdErrors,
        },
      },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // DEMANDS
    // ═══════════════════════════════════════════════════════════════════════
    "/api/demands": {
      get: {
        summary: "List demands",
        tags: ["Demands"],
        security: SEC_AUTHED,
        parameters: [
          PARAM_TENANT_ID,
          PARAM_SEARCH,
          { name: "partner_id", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "product_id", in: "query", schema: { type: "string", format: "uuid" } },
          { $ref: "#/components/parameters/Status" },
          PARAM_LIMIT,
          PARAM_OFFSET,
        ],
        responses: {
          200: {
            description: "Paginated list.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/ListResponse" },
                    {
                      type: "object",
                      properties: {
                        items: {
                          type: "array",
                          items: { $ref: "#/components/schemas/Demand" },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          ...stdErrors,
        },
      },
      post: {
        summary: "Create or update a demand",
        tags: ["Demands"],
        security: SEC_AUTHED,
        parameters: [PARAM_TENANT_ID],
        requestBody: JSON_BODY("#/components/schemas/Demand", "Demand fields."),
        responses: {
          200: {
            description: "Created or updated.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Demand" },
              },
            },
          },
          ...stdErrors,
        },
      },
    },
    "/api/demands/{id}": {
      get: {
        summary: "Get a demand",
        tags: ["Demands"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        responses: {
          200: {
            description: "The demand.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Demand" },
              },
            },
          },
          ...stdErrors,
        },
      },
      put: {
        summary: "Update a demand",
        tags: ["Demands"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        requestBody: JSON_BODY("#/components/schemas/Demand", "Demand fields."),
        responses: {
          200: {
            description: "Updated.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Demand" },
              },
            },
          },
          ...stdErrors,
        },
      },
      delete: {
        summary: "Delete a demand",
        tags: ["Demands"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        responses: {
          204: { description: "Deleted." },
          ...stdErrors,
        },
      },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // PORTAL (client-facing)
    // ═══════════════════════════════════════════════════════════════════════
    "/api/portal/login": {
      post: {
        summary: "Portal login",
        description:
          "Authenticate a portal access (client) user. Returns a portal session cookie (separate from the admin session). " +
          "Per-IP rate limited. KYC gate: if the portal user's KYC is not approved, the response includes `kyc_required: true` and most portal endpoints will 403 until KYC is submitted.",
        tags: ["Portal"],
        security: SEC_PUBLIC,
        requestBody: JSON_BODY("#/components/schemas/PortalLoginRequest", "Portal credentials."),
        responses: {
          200: {
            description: "Authenticated. The `Set-Cookie` header carries the portal session.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    access: {
                      type: "object",
                      properties: {
                        id: { type: "string", format: "uuid" },
                        email: { type: "string", format: "email" },
                        full_name: { type: "string" },
                        partner_id: { type: "string", format: "uuid" },
                        kyc_status: { type: "string", enum: ["not_submitted", "pending", "approved", "rejected"] },
                      },
                    },
                  },
                },
              },
            },
          },
          ...rateLimitedErrors,
        },
      },
    },
    "/api/portal/me": {
      get: {
        summary: "Current portal user",
        tags: ["Portal"],
        security: [{ cookie: [] }],
        responses: {
          200: {
            description: "Authenticated.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    access: {
                      type: "object",
                      properties: {
                        id: { type: "string", format: "uuid" },
                        email: { type: "string" },
                        partner_id: { type: "string", format: "uuid" },
                        kyc_status: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
          401: ERROR_401,
          500: ERROR_500,
        },
      },
    },
    "/api/portal/catalog": {
      get: {
        summary: "Browse the product catalog",
        description: "Returns products where `show_in_catalog=true` for the portal user's partner tenant. Prices are partner-specific (tier-aware).",
        tags: ["Portal"],
        security: [{ cookie: [] }],
        parameters: [PARAM_SEARCH, PARAM_LIMIT, PARAM_OFFSET],
        responses: {
          200: {
            description: "Paginated catalog.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ListResponse" },
              },
            },
          },
          401: ERROR_401,
          403: ERROR_403,
          500: ERROR_500,
        },
      },
    },
    "/api/portal/offers": {
      get: {
        summary: "List offers visible to this portal user",
        tags: ["Portal"],
        security: [{ cookie: [] }],
        parameters: [PARAM_LIMIT, PARAM_OFFSET],
        responses: {
          200: {
            description: "Paginated list of offers addressed to this portal user's partner.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ListResponse" },
              },
            },
          },
          401: ERROR_401,
          500: ERROR_500,
        },
      },
    },
    "/api/portal/offers/{id}/pdf": {
      get: {
        summary: "Download an offer PDF (portal)",
        description: "Records a `viewed` event on the offer. Refused (403) if the offer is not addressed to this portal user's partner.",
        tags: ["Portal"],
        security: [{ cookie: [] }],
        parameters: [PARAM_ID],
        responses: {
          200: {
            description: "PDF file.",
            content: {
              "application/pdf": { schema: { type: "string", format: "binary" } },
            },
          },
          401: ERROR_401,
          403: ERROR_403,
          404: ERROR_404,
          500: ERROR_500,
        },
      },
    },
    "/api/portal/offers/{id}/respond": {
      post: {
        summary: "Accept or reject an offer (portal)",
        tags: ["Portal"],
        security: [{ cookie: [] }],
        parameters: [PARAM_ID],
        requestBody: {
          description: "Response action.",
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["action"],
                properties: {
                  action: { type: "string", enum: ["accept", "reject"] },
                  reason: { type: "string", description: "Required when action=reject." },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Response recorded. Triggers the `offer.accepted` / `offer.rejected` webhook.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Offer" },
              },
            },
          },
          401: ERROR_401,
          403: ERROR_403,
          404: ERROR_404,
          409: ERROR_409,
          500: ERROR_500,
        },
      },
    },
    "/api/portal/invoices": {
      get: {
        summary: "List invoices visible to this portal user",
        tags: ["Portal"],
        security: [{ cookie: [] }],
        parameters: [PARAM_LIMIT, PARAM_OFFSET],
        responses: {
          200: {
            description: "Paginated list.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ListResponse" },
              },
            },
          },
          401: ERROR_401,
          500: ERROR_500,
        },
      },
    },
    "/api/portal/invoices/{id}/pdf": {
      get: {
        summary: "Download an invoice PDF (portal)",
        tags: ["Portal"],
        security: [{ cookie: [] }],
        parameters: [PARAM_ID],
        responses: {
          200: {
            description: "PDF file.",
            content: {
              "application/pdf": { schema: { type: "string", format: "binary" } },
            },
          },
          401: ERROR_401,
          403: ERROR_403,
          404: ERROR_404,
          500: ERROR_500,
        },
      },
    },
    "/api/portal/rfqs": {
      post: {
        summary: "Submit a Request for Quotation (portal)",
        description: "Portal users can submit RFQs for products they want quoted. Creates a `portal_rfq` row that the tenant's sales team sees under Portal RFQs.",
        tags: ["Portal"],
        security: [{ cookie: [] }],
        requestBody: {
          description: "RFQ details.",
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["items"],
                properties: {
                  product_id: { type: "string", format: "uuid", description: "Optional — leave blank for an open RFQ." },
                  quantity: { type: "number" },
                  unit: { type: "string" },
                  target_price: { type: "number" },
                  currency: { type: "string" },
                  delivery_date: { type: "string", format: "date" },
                  delivery_location: { type: "string" },
                  notes: { type: "string" },
                  items: {
                    type: "array",
                    description: "Line items (alternative to the flat product_id/quantity fields).",
                    items: {
                      type: "object",
                      properties: {
                        product_id: { type: "string", format: "uuid" },
                        quantity: { type: "number" },
                        unit: { type: "string" },
                        notes: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "RFQ submitted.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string", format: "uuid" },
                    status: { type: "string" },
                  },
                },
              },
            },
          },
          401: ERROR_401,
          403: ERROR_403,
          500: ERROR_500,
        },
      },
    },
    "/api/portal/notifications": {
      get: {
        summary: "List portal notifications",
        tags: ["Portal"],
        security: [{ cookie: [] }],
        parameters: [PARAM_LIMIT, PARAM_OFFSET],
        responses: {
          200: {
            description: "Paginated list.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ListResponse" },
              },
            },
          },
          401: ERROR_401,
          500: ERROR_500,
        },
      },
    },
    "/api/portal/notifications/{id}/read": {
      post: {
        summary: "Mark a portal notification as read",
        tags: ["Portal"],
        security: [{ cookie: [] }],
        parameters: [PARAM_ID],
        responses: {
          200: { description: "Marked as read." },
          401: ERROR_401,
          404: ERROR_404,
          500: ERROR_500,
        },
      },
    },
    "/api/portal/documents": {
      get: {
        summary: "List documents shared with this portal user",
        tags: ["Portal"],
        security: [{ cookie: [] }],
        parameters: [PARAM_LIMIT, PARAM_OFFSET],
        responses: {
          200: {
            description: "Paginated list.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ListResponse" },
              },
            },
          },
          401: ERROR_401,
          500: ERROR_500,
        },
      },
    },
    "/api/portal/documents/{id}/download": {
      get: {
        summary: "Download a shared document (portal)",
        tags: ["Portal"],
        security: [{ cookie: [] }],
        parameters: [PARAM_ID],
        responses: {
          200: {
            description: "File (content-type reflects the uploaded file).",
            content: {
              "application/octet-stream": { schema: { type: "string", format: "binary" } },
            },
          },
          401: ERROR_401,
          403: ERROR_403,
          404: ERROR_404,
          500: ERROR_500,
        },
      },
    },
    "/api/portal/messages": {
      get: {
        summary: "List portal messages (thread with the tenant)",
        tags: ["Portal"],
        security: [{ cookie: [] }],
        responses: {
          200: {
            description: "Message list.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ListResponse" },
              },
            },
          },
          401: ERROR_401,
          500: ERROR_500,
        },
      },
    },
    "/api/portal/messages/unread": {
      get: {
        summary: "Unread message count (badge)",
        tags: ["Portal"],
        security: [{ cookie: [] }],
        responses: {
          200: {
            description: "Count.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { count: { type: "integer" } },
                },
              },
            },
          },
          401: ERROR_401,
          500: ERROR_500,
        },
      },
    },
    "/api/portal/log-location": {
      post: {
        summary: "Log a portal user's geolocation",
        description:
          "Called by the portal shell on login + periodically. Used for fraud detection (GPS-gate) and to populate the portal-access `last_login_country` / `gps_verified_at` fields. " +
          "Refused (403) if the reported location is in a sanctioned country.",
        tags: ["Portal"],
        security: [{ cookie: [] }],
        requestBody: {
          description: "Geolocation coordinates.",
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["latitude", "longitude"],
                properties: {
                  latitude: { type: "number" },
                  longitude: { type: "number" },
                  accuracy: { type: "number" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Logged." },
          401: ERROR_401,
          403: ERROR_403,
          500: ERROR_500,
        },
      },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // SETTINGS
    // ═══════════════════════════════════════════════════════════════════════
    "/api/settings": {
      get: {
        summary: "Get tenant settings",
        tags: ["Settings"],
        security: SEC_AUTHED,
        parameters: [PARAM_TENANT_ID],
        responses: {
          200: {
            description: "The tenant's settings object.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Settings" },
              },
            },
          },
          ...stdErrors,
        },
      },
      put: {
        summary: "Update tenant settings",
        description: "Partial update — only the supplied keys are written. Admin-only.",
        tags: ["Settings"],
        security: SEC_AUTHED,
        parameters: [PARAM_TENANT_ID],
        requestBody: JSON_BODY("#/components/schemas/Settings", "Settings patch."),
        responses: {
          200: {
            description: "Updated settings (full object returned).",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Settings" },
              },
            },
          },
          ...stdErrors,
        },
      },
    },
    "/api/settings/rate-limits": {
      get: {
        summary: "Get rate-limit configuration",
        description: "Returns the per-tenant (or platform-default) rate-limit settings (login attempts, window, etc.).",
        tags: ["Settings"],
        security: SEC_AUTHED,
        responses: {
          200: {
            description: "Configuration.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    loginMaxAttempts: { type: "integer" },
                    loginWindowMs: { type: "integer" },
                  },
                },
              },
            },
          },
          ...stdErrors,
        },
      },
      put: {
        summary: "Update rate-limit configuration",
        description: "Super-admin only. Persists overrides to the platform config table.",
        tags: ["Settings"],
        security: [{ apiKey: [] }, { cookie: [] }],
        requestBody: {
          description: "Rate-limit overrides.",
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  loginMaxAttempts: { type: "integer", minimum: 3, maximum: 100 },
                  loginWindowMs: { type: "integer", minimum: 60_000, maximum: 3_600_000 },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Updated.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    loginMaxAttempts: { type: "integer" },
                    loginWindowMs: { type: "integer" },
                  },
                },
              },
            },
          },
          ...stdErrors,
        },
      },
    },
    "/api/settings/test-smtp": {
      post: {
        summary: "Send a test SMTP connection probe",
        description: "Admin-only. Verifies the SMTP host/port/credentials without sending an actual email.",
        tags: ["Settings"],
        security: SEC_AUTHED,
        responses: {
          200: {
            description: "Probe result.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    error: { type: "string", description: "Present when ok=false." },
                  },
                },
              },
            },
          },
          ...stdErrors,
        },
      },
    },
    "/api/settings/test-email": {
      post: {
        summary: "Send a test email",
        description: "Admin-only. Sends a small email to the specified address using the configured SMTP server.",
        tags: ["Settings"],
        security: SEC_AUTHED,
        requestBody: {
          description: "Recipient.",
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["to"],
                properties: { to: { type: "string", format: "email" } },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Send result.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    mail_queue_id: { type: "string", format: "uuid" },
                  },
                },
              },
            },
          },
          ...stdErrors,
        },
      },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // USERS
    // ═══════════════════════════════════════════════════════════════════════
    "/api/users": {
      get: {
        summary: "List tenant users",
        tags: ["Users"],
        security: SEC_AUTHED,
        parameters: [PARAM_TENANT_ID, PARAM_SEARCH, PARAM_LIMIT, PARAM_OFFSET],
        responses: {
          200: {
            description: "Paginated list. `password_hash` is always stripped.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/ListResponse" },
                    {
                      type: "object",
                      properties: {
                        items: {
                          type: "array",
                          items: { $ref: "#/components/schemas/User" },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          ...stdErrors,
        },
      },
      post: {
        summary: "Create or update a user",
        description:
          "Create (omit `id`) requires admin permission and is subject to the user-count plan quota. " +
          "Update (include `id`) — admins can update any user in their tenant; non-admins can only update themselves (limited fields).",
        tags: ["Users"],
        security: SEC_AUTHED,
        parameters: [PARAM_TENANT_ID],
        requestBody: JSON_BODY("#/components/schemas/User", "User fields. On create: `username`, `email`, `password`, `role` are required."),
        responses: {
          200: {
            description: "Created or updated.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/User" },
              },
            },
          },
          ...stdErrors,
        },
      },
    },
    "/api/users/{id}": {
      get: {
        summary: "Get a user",
        tags: ["Users"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        responses: {
          200: {
            description: "The user.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/User" },
              },
            },
          },
          ...stdErrors,
        },
      },
      put: {
        summary: "Update a user",
        tags: ["Users"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        requestBody: JSON_BODY("#/components/schemas/User", "User fields."),
        responses: {
          200: {
            description: "Updated.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/User" },
              },
            },
          },
          ...stdErrors,
        },
      },
      delete: {
        summary: "Delete a user",
        description: "Soft-deletes (sets `active=false`). Hard-delete is reserved for GDPR anonymisation (super-admin only, via /api/super-admin/*).",
        tags: ["Users"],
        security: SEC_AUTHED,
        parameters: [PARAM_ID, PARAM_TENANT_ID],
        responses: {
          204: { description: "Deactivated." },
          ...stdErrors,
        },
      },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // SYSTEM
    // ═══════════════════════════════════════════════════════════════════════
    "/api/health": {
      get: {
        summary: "Health check",
        description:
          "Lightweight liveness probe for uptime monitors (Render, UptimeRobot). Not authenticated. " +
          "Returns 200 when the DB is reachable, 503 otherwise. Never cached.",
        tags: ["System"],
        security: SEC_PUBLIC,
        responses: {
          200: {
            description: "Healthy.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/HealthResponse" },
              },
            },
          },
          503: {
            description: "Degraded — DB unreachable or not configured.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/HealthResponse" },
              },
            },
          },
        },
      },
    },
    "/api/dashboard": {
      get: {
        summary: "Aggregate KPIs for the dashboard",
        description: "Returns counts (offers, invoices, deals), revenue totals, top partners, and recent activity. Tenant-scoped.",
        tags: ["System"],
        security: SEC_AUTHED,
        parameters: [PARAM_TENANT_ID],
        responses: {
          200: {
            description: "Dashboard payload (shape is view-specific).",
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
          ...stdErrors,
        },
      },
    },
    "/api/badge-counts": {
      get: {
        summary: "Sidebar badge counts",
        description: "Returns the unread counts for tasks, KYC review queue, portal RFQs, logistics requests, etc. Used by the sidebar to render the numeric pills.",
        tags: ["System"],
        security: SEC_AUTHED,
        parameters: [PARAM_TENANT_ID],
        responses: {
          200: {
            description: "Counts.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    tasks: { type: "integer" },
                    kyc_review: { type: "integer" },
                    portal_rfqs: { type: "integer" },
                    logistics_requests: { type: "integer" },
                  },
                },
              },
            },
          },
          ...stdErrors,
        },
      },
    },
    "/api/search": {
      get: {
        summary: "Global search",
        description: "Cross-entity search (partners, products, offers, invoices, deals). Powers the ⌘K command palette.",
        tags: ["System"],
        security: SEC_AUTHED,
        parameters: [
          PARAM_TENANT_ID,
          { name: "q", in: "query", required: true, schema: { type: "string" }, description: "Search query (min 2 chars)." },
          { name: "limit", in: "query", schema: { type: "integer", default: 10, maximum: 50 } },
        ],
        responses: {
          200: {
            description: "Search results grouped by entity type.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    partners: { type: "array", items: { $ref: "#/components/schemas/Partner" } },
                    products: { type: "array", items: { $ref: "#/components/schemas/Product" } },
                    offers: { type: "array", items: { $ref: "#/components/schemas/Offer" } },
                    invoices: { type: "array", items: { $ref: "#/components/schemas/Invoice" } },
                  },
                },
              },
            },
          },
          ...stdErrors,
        },
      },
    },
    "/api/audit": {
      get: {
        summary: "Audit log",
        description: "Paginated list of audit entries (login, create, update, delete, send, etc.). Filterable by user, action, entity, date range.",
        tags: ["System"],
        security: SEC_AUTHED,
        parameters: [
          PARAM_TENANT_ID,
          { name: "user_id", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "action", in: "query", schema: { type: "string" }, description: "e.g. `login`, `offer.create`, `invoice.send`." },
          { name: "entity_type", in: "query", schema: { type: "string" } },
          { name: "from", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "to", in: "query", schema: { type: "string", format: "date-time" } },
          PARAM_LIMIT,
          PARAM_OFFSET,
        ],
        responses: {
          200: {
            description: "Paginated audit entries.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ListResponse" },
              },
            },
          },
          ...stdErrors,
        },
      },
    },
    "/api/exchange-rates": {
      get: {
        summary: "Currency exchange rates",
        description: "Returns the latest FX rates (base USD) cached from the integration provider. Refreshed by a daily cron.",
        tags: ["System"],
        security: SEC_AUTHED,
        responses: {
          200: {
            description: "Rate map.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    base: { type: "string", example: "USD" },
                    date: { type: "string", format: "date" },
                    rates: {
                      type: "object",
                      additionalProperties: { type: "number" },
                      description: "Currency → rate. e.g. `{ \"EUR\": 0.92, \"GBP\": 0.79 }`.",
                    },
                  },
                },
              },
            },
          },
          ...stdErrors,
        },
      },
    },
    "/api/openapi-json": {
      get: {
        summary: "This OpenAPI spec (JSON)",
        description: "Returns the raw OpenAPI 3.0 JSON document. Import into Postman / Stoplight / Swagger Editor for offline use.",
        tags: ["System"],
        security: SEC_PUBLIC,
        responses: {
          200: {
            description: "OpenAPI 3.0 JSON document.",
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
        },
      },
    },
  },
};
