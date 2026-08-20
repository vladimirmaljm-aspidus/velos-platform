import { NextRequest, NextResponse } from "next/server";
// FIX-ALL-2 / Fix 3 — accept API-key auth so an API-key caller can use the
// global search endpoint (audit Flow 1: `GET /api/search?q=tobacco` → 401
// with API key). Session callers keep using requirePermission; API-key
// callers go through hasPermission (colon format).
import { requireAuthOrApiKey, hasPermission, resolveTenantId } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

/**
 * GET /api/search?q=xxx&limit=20
 *
 * Global search across partners, products, deals, offers, invoices.
 * Returns a flat list of matches with entity type + id + label + subtitle.
 *
 * Implementation note (task D-1): replaced the legacy pattern of
 * `listX(tenantId, { limit: 1000 })` + in-memory `String.toLowerCase().includes()`
 * with PostgreSQL tsvector full-text search (`search_vector @@ websearch_to_tsquery`).
 * Each table has a `search_vector tsvector` column maintained by a trigger
 * (migration 037_fulltext_search.sql) and a GIN index on it, so the query is
 * O(log n) instead of O(n) — typically 10-100x faster than the old ILIKE /
 * in-memory substring scan for tenants with thousands of rows.
 *
 * `type: "websearch"` enables Google-style query syntax (quoted phrases,
 * `OR`, `-exclusion`), is forgiving of bad syntax (unlike `to_tsquery`),
 * and respects stop-words. Queries shorter than 2 chars return an empty
 * result set without hitting the DB (matches the legacy behaviour).
 */
async function _get(req: NextRequest) {
  const auth = await requireAuthOrApiKey(req);
  if (auth instanceof NextResponse) return auth;
  { const { requirePermission } = await import("@/lib/permissions/can");
    if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "dashboard.read"); if (_d) return _d; } } /* requirePermission wired */
  // FIX-ALL-2 / Fix 3 — API-key callers need a colon-format permission
  // check. `dashboard:read` is the canonical dashboard scope; keys with
  // `*` or `dashboard:*` pass, keys scoped to a single resource (e.g.
  // `partners:read`) don't. This mirrors the session-auth gate above
  // and prevents a 401 leak on a missing-record case.
  if ("apiKeyId" in auth && !hasPermission(auth.permissions, "dashboard:read")) {
    return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
  }

  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) return NextResponse.json({ items: [] });

  const url = new URL(req.url);
  // NOTE: do NOT lowercase — tsvector matching is case-insensitive by
  // construction (to_tsvector normalises), and lowercasing would mangle
  // websearch_to_tsquery operators (`OR` vs `or`).
  const q = (url.searchParams.get("q") || "").trim();
  const limit = Math.min(Number(url.searchParams.get("limit") || 20), 50);

  if (q.length < 2) {
    return NextResponse.json({ items: [] });
  }

  const supabase = getSupabase();
  // Per-entity cap so no single entity type crowds the others out of the
  // final `limit`. 20 per type → up to 100 candidates, then trimmed to
  // `limit` after the in-memory relevance sort.
  const PER_ENTITY = 20;

  type Hit = {
    type: string;
    id: string;
    label: string;
    subtitle: string;
    url: string;
    rank: number;
  };
  const results: Hit[] = [];

  // --- partners ---
  try {
    const { data, error } = await supabase
      .from("partners")
      .select("id, name, type, email, country")
      .eq("tenant_id", tenantId)
      .textSearch("search_vector", q, { type: "websearch" })
      .limit(PER_ENTITY);
    if (!error && data) {
      for (const p of data) {
        results.push({
          type: "partner",
          id: p.id,
          label: p.name,
          subtitle: [p.type, p.email, p.country].filter(Boolean).join(" · "),
          url: "partners",
          rank: 0,
        });
      }
    }
  } catch {}

  // --- products ---
  try {
    const { data, error } = await supabase
      .from("products")
      .select("id, name, sku, category, currency, price")
      .eq("tenant_id", tenantId)
      .textSearch("search_vector", q, { type: "websearch" })
      .limit(PER_ENTITY);
    if (!error && data) {
      for (const p of data) {
        results.push({
          type: "product",
          id: p.id,
          label: p.name,
          subtitle: [p.sku, p.category, `${p.currency} ${p.price}`].filter(Boolean).join(" · "),
          url: "products",
          rank: 0,
        });
      }
    }
  } catch {}

  // --- deals ---
  try {
    const { data, error } = await supabase
      .from("deals")
      .select("id, title, stage, currency, value")
      .eq("tenant_id", tenantId)
      .textSearch("search_vector", q, { type: "websearch" })
      .limit(PER_ENTITY);
    if (!error && data) {
      for (const d of data) {
        results.push({
          type: "deal",
          id: d.id,
          label: d.title,
          subtitle: [d.stage, `${d.currency} ${d.value}`].filter(Boolean).join(" · "),
          url: "deals",
          rank: 0,
        });
      }
    }
  } catch {}

  // --- offers ---
  try {
    const { data, error } = await supabase
      .from("offers")
      .select("id, number, subject, status, currency, total")
      .eq("tenant_id", tenantId)
      .textSearch("search_vector", q, { type: "websearch" })
      .limit(PER_ENTITY);
    if (!error && data) {
      for (const o of data) {
        results.push({
          type: "offer",
          id: o.id,
          label: `Offer ${o.number}`,
          subtitle: [o.status, o.subject, `${o.currency} ${o.total}`].filter(Boolean).join(" · "),
          url: "offers",
          rank: 0,
        });
      }
    }
  } catch {}

  // --- invoices ---
  try {
    const { data, error } = await supabase
      .from("invoices")
      .select("id, number, subject, status, currency, total")
      .eq("tenant_id", tenantId)
      .textSearch("search_vector", q, { type: "websearch" })
      .limit(PER_ENTITY);
    if (!error && data) {
      for (const i of data) {
        results.push({
          type: "invoice",
          id: i.id,
          label: `Invoice ${i.number}`,
          subtitle: [i.status, i.subject, `${i.currency} ${i.total}`].filter(Boolean).join(" · "),
          url: "invoices",
          rank: 0,
        });
      }
    }
  } catch {}

  // Sort by relevance: exact label match first, then starts-with, then alphabetical.
  const qLower = q.toLowerCase();
  results.sort((a, b) => {
    const aLabel = a.label.toLowerCase();
    const bLabel = b.label.toLowerCase();
    if (aLabel === qLower && bLabel !== qLower) return -1;
    if (bLabel === qLower && aLabel !== qLower) return 1;
    if (aLabel.startsWith(qLower) && !bLabel.startsWith(qLower)) return -1;
    if (bLabel.startsWith(qLower) && !aLabel.startsWith(qLower)) return 1;
    return aLabel.localeCompare(bLabel);
  });

  return NextResponse.json({ items: results.slice(0, limit).map(({ rank: _r, ...hit }) => hit) });
}

// ── APM wrapper (task D-8) ───────────────────────────────────────────────
// Wraps GET with response-time, slow-request, and error-rate metrics.
// See src/lib/monitoring/apm.ts for the buffer + dashboard wiring.
export const GET = withApm(_get, "GET /api/search");
