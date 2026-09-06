import { NextRequest, NextResponse } from "next/server";
// 37 — Partner 360 Activity API.
//
// GET /api/partners/[id]/activity
//
// One aggregated, permission-gated answer to "what has this partner been
// doing on the portal": login history with GPS geo-attachment, document
// view/download stats, marketplace activity (posts / bids / negotiations /
// follows / closed deals), an interests summary (top products, categories,
// recent searches) and a merged chronological timeline.
//
// Data sources (each resilient on its own — a missing table / failed lookup
// degrades that section to empty, the response stays 200):
//   • audit_logs      — portal.login / portal.login_failed / portal.location
//                       rows for the partner's portal_access ids. This is the
//                       HISTORICAL source: it works in production TODAY
//                       (months of rows) and needs no migration.
//   • portal_events   — new per-partner event stream (migration 091,
//                       optional until applied): catalog views, searches,
//                       marketplace browsing, downloads, bids.
//   • offers/lois/invoices/proformas — viewed_at / view_count columns
//                       (already maintained by markDocumentViewed).
//   • marketplace_posts / responses / negotiations / follows — direct rows.
//
// Privacy / security:
//   • Same permission gate as GET /api/partners/[id] (partners.read).
//   • Tenant ownership enforced on the partner row first.
//   • IP geo-enrichment uses the shared cached lookupIp() helper; no new
//     external calls per row (unique-IP cache, 1h TTL).
//   • No secrets in the response (password hashes / token versions never
//     leave the portal_access read below — only id/tier/status/dates).
import { requireAuthOrApiKey, hasPermission, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { getSupabase } from "@/lib/supabase/client";
import { lookupIp } from "@/lib/utils/geo-ip";
import { listPartnerEvents } from "@/lib/portal/partner-events";

export const runtime = "nodejs";

// ─── Response contract ──────────────────────────────────────────────────────

interface GpsFix {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  at: string;
  source: string | null;
}

interface LoginEntry {
  at: string;
  status: "success" | "failed" | "rate_limited";
  reason: string | null;
  ip: string | null;
  country: string | null;
  city: string | null;
  gps: GpsFix | null;
  device: string | null;
  user_agent: string | null;
}

interface TimelineEvent {
  at: string;
  type: string;
  label: string | null;
  entity_type: string | null;
  entity_id: string | null;
  ip: string | null;
  details: Record<string, unknown> | null;
}

interface InterestItem {
  name: string;
  count: number;
}

interface MarketplaceCard {
  posts_total: number;
  bids_total: number;
  negotiations_total: number;
  follows_total: number;
  purchases: {
    id: string;
    kind: "closed_buy_post" | "accepted_bid" | "accepted_negotiation";
    product: string | null;
    quantity: number | null;
    unit: string | null;
    price: number | null;
    currency: string | null;
    at: string;
  }[];
  posts: {
    id: string;
    post_type: string;
    product_name: string;
    status: string;
    quantity: number;
    unit: string;
    target_price: number | null;
    currency: string;
    created_at: string;
    views_count: number;
    responses_count: number;
  }[];
  bids: {
    id: string;
    post_id: string;
    post_product: string | null;
    unit_price: number | null;
    currency: string | null;
    quantity: number | null;
    is_counter: boolean | null;
    status: string;
    created_at: string;
  }[];
  negotiations: {
    id: string;
    post_id: string;
    status: string;
    role: "buyer" | "seller" | "party";
    last_message_at: string | null;
    created_at: string;
  }[];
  follows: { id: string; followed_name: string | null; created_at: string }[];
}

// ─── Small helpers ──────────────────────────────────────────────────────────

/** Parse a user-agent into a compact "Browser · OS" label (best-effort). */
function parseDevice(ua: string | null | undefined): string | null {
  if (!ua) return null;
  let browser = "Unknown";
  if (/edg\//i.test(ua)) browser = "Edge";
  else if (/opr\/|opera/i.test(ua)) browser = "Opera";
  else if (/chrome|crios/i.test(ua)) browser = "Chrome";
  else if (/firefox|fxios/i.test(ua)) browser = "Firefox";
  else if (/safari/i.test(ua)) browser = "Safari";
  else if (/bot|crawl|spider|curl|wget|python-requests/i.test(ua)) browser = "Automated";
  let os = "Unknown";
  if (/windows/i.test(ua)) os = "Windows";
  else if (/android/i.test(ua)) os = "Android";
  else if (/iphone|ipad|ipod/i.test(ua)) os = "iOS";
  else if (/mac os x|macintosh/i.test(ua)) os = "macOS";
  else if (/linux/i.test(ua)) os = "Linux";
  return `${browser} · ${os}`;
}

/** audit_logs.details is jsonb — arrives as an object; tolerate a string. */
function parseDetails(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw);
      return typeof p === "object" && p !== null ? (p as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

interface RawAuditRow {
  id: string;
  action: string;
  entity_id: string | null;
  details: unknown;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

/** Bump a counter map (interests aggregation). */
function bump(map: Map<string, number>, key: string | null | undefined, weight = 1) {
  if (!key || typeof key !== "string") return;
  const k = key.trim();
  if (k.length < 2 || k.length > 120) return;
  map.set(k, (map.get(k) || 0) + weight);
}

function topN(map: Map<string, number>, n: number): InterestItem[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}

// ─── Route ──────────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthOrApiKey(_req);
    if (auth instanceof NextResponse) return auth;
    // Same permission gate as GET /api/partners/[id].
    {
      const { requirePermission } = await import("@/lib/permissions/can");
      if (!("apiKeyId" in auth)) {
        const denied = requirePermission(auth, "partners.read");
        if (denied) return denied;
      }
    }
    if ("apiKeyId" in auth && !hasPermission(auth.permissions, "partners:read")) {
      return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
    }

    const { id } = await params;
    const store = await getStore();
    const partner = await store.getPartner(id);
    if (!partner) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
    if (!isSuperAdmin && partner.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const tenantId = isSuperAdmin ? partner.tenant_id : (auth.tenantId as string);
    const partnerId = id;

    // 1) Portal access rows for this partner (id, status, tier — no secrets).
    const sb = getSupabase();
    let accesses: Record<string, unknown>[] = [];
    try {
      const { data: accessRows } = await sb
        .from("portal_access")
        .select("id, status, tier, created_at, last_login_at, last_login_ip, last_login_country")
        .eq("tenant_id", tenantId)
        .eq("partner_id", partnerId)
        .order("created_at", { ascending: false })
        .limit(10);
      accesses = ((accessRows as Record<string, unknown>[] | null) || []).filter(Boolean);
    } catch {
      accesses = [];
    }
    const accessIds = accesses.map((a) => String(a.id));

    // 2) Login / location history from audit_logs (works with existing
    //    production data — no migration needed). Failures degrade to [].
    let auditRows: RawAuditRow[] = [];
    if (accessIds.length > 0) {
      const { data: auditData, error: auditErr } = await sb
        .from("audit_logs")
        .select("id, action, entity_id, details, ip, user_agent, created_at")
        .in("entity_id", accessIds)
        .in("action", ["portal.login", "portal.login_failed", "portal.login_rate_limited", "portal.location"])
        .order("created_at", { ascending: false })
        .limit(600);
      if (!auditErr) auditRows = (auditData as RawAuditRow[]) || [];
    }

    // 3) Portal event stream (optional table — [] before migration 091).
    const events = await listPartnerEvents(tenantId, partnerId, 500);
    const eventsTracked = events.length > 0;

    // 4) Document view stats (viewed_at / view_count on the four tables).
    const docTables = ["offers", "lois", "invoices", "proformas"] as const;
    const docViews: {
      table: string;
      id: string;
      number: string;
      status: string | null;
      viewed_at: string | null;
      view_count: number;
    }[] = [];
    for (const table of docTables) {
      try {
        const { data: rows } = await sb
          .from(table)
          .select("id, number, status, viewed_at, view_count")
          .eq("tenant_id", tenantId)
          .eq("partner_id", partnerId)
          .order("created_at", { ascending: false })
          .limit(200);
        for (const r of (rows as Record<string, unknown>[] | null) || []) {
          docViews.push({
            table,
            id: String(r.id),
            number: String(r.number ?? ""),
            status: (r.status as string) ?? null,
            viewed_at: (r.viewed_at as string) ?? null,
            view_count: typeof r.view_count === "number" ? r.view_count : 0,
          });
        }
      } catch {
        /* table/columns missing → skip */
      }
    }

    // 5) RFQs.
    const rfqs = await store.listPortalRfqsByPartner(partnerId).catch(() => [] as import("@/lib/supabase/types").PortalRfq[]);

    // 6) Marketplace activity.
    let mkPosts: Record<string, unknown>[] = [];
    let mkBids: Record<string, unknown>[] = [];
    let mkNegs: Record<string, unknown>[] = [];
    let mkFollows: Record<string, unknown>[] = [];
    try {
      const { data: posts } = await sb
        .from("marketplace_posts")
        .select("id, post_type, product_name, status, quantity, unit, target_price, currency, created_at, views_count, responses_count")
        .eq("tenant_id", tenantId)
        .eq("partner_id", partnerId)
        .order("created_at", { ascending: false })
        .limit(100);
      mkPosts = (posts as Record<string, unknown>[]) || [];
    } catch { /* degrade */ }
    try {
      const { data: bids } = await sb
        .from("marketplace_responses")
        .select("id, post_id, unit_price, currency, quantity, is_counter, status, created_at, post_title")
        .eq("tenant_id", tenantId)
        .eq("partner_id", partnerId)
        .order("created_at", { ascending: false })
        .limit(100);
      mkBids = (bids as Record<string, unknown>[]) || [];
    } catch { /* degrade */ }

    // ── Geo-enrich the login IPs (unique, cached 1h by lookupIp). Only the
    //    last 30 distinct public IPs to bound external lookups per request.
    const loginRows = auditRows.filter((r) => r.action.startsWith("portal.login"));
    const locationRows = auditRows
      .filter((r) => r.action === "portal.location")
      .map((r) => {
        const d = parseDetails(r.details) || {};
        return {
          at: r.created_at,
          ip: r.ip,
          latitude: typeof d.latitude === "number" ? (d.latitude as number) : null,
          longitude: typeof d.longitude === "number" ? (d.longitude as number) : null,
          accuracy: typeof d.accuracy === "number" ? (d.accuracy as number) : null,
          source: typeof d.source === "string" ? (d.source as string) : null,
        };
      })
      .filter((l) => l.latitude !== null && l.longitude !== null);

    const distinctIps = [...new Set(loginRows.map((r) => r.ip).filter((x): x is string => !!x && x !== "unknown"))];
    // Cap + PARALLEL lookups (lookupIp itself has a 5s abort + 1h cache, so
    // the worst case wall time here is one round, not 30 sequential ones).
    const geoByIp = new Map<string, Awaited<ReturnType<typeof lookupIp>>>();
    await Promise.allSettled(
      distinctIps.slice(0, 15).map(async (ip) => {
        try {
          geoByIp.set(ip, await lookupIp(ip));
        } catch {
          /* geo optional */
        }
      }),
    );

    // ── Build the login entries. GPS from the nearest portal.location row
    //    within ±15 minutes of the login (the portal client posts its
    //    location right after login + periodically).
    const WINDOW_MS = 15 * 60 * 1000;
    const usedLocationIdx = new Set<number>();
    const logins: LoginEntry[] = loginRows.slice(0, 80).map((r) => {
      const d = parseDetails(r.details) || {};
      const at = new Date(r.created_at).getTime();
      // nearest location row (not yet consumed) within the window
      let gps: GpsFix | null = null;
      let bestIdx = -1;
      let bestDelta = Infinity;
      locationRows.forEach((l, i) => {
        if (usedLocationIdx.has(i)) return;
        const delta = Math.abs(new Date(l.at).getTime() - at);
        if (delta <= WINDOW_MS && delta < bestDelta) {
          bestDelta = delta;
          bestIdx = i;
        }
      });
      if (bestIdx >= 0 && locationRows[bestIdx]) {
        const l = locationRows[bestIdx];
        usedLocationIdx.add(bestIdx);
        gps = {
          latitude: l.latitude as number,
          longitude: l.longitude as number,
          accuracy: l.accuracy,
          at: l.at,
          source: l.source,
        };
      }
      const ip = r.ip || (typeof d.ip === "string" ? (d.ip as string) : null);
      const geo = ip ? geoByIp.get(ip) : undefined;
      const status: LoginEntry["status"] =
        r.action === "portal.login"
          ? "success"
          : r.action === "portal.login_rate_limited"
            ? "rate_limited"
            : "failed";
      return {
        at: r.created_at,
        status,
        reason: typeof d.reason === "string" ? (d.reason as string) : null,
        ip,
        country: (typeof d.country === "string" && d.country) || geo?.country || (accesses[0]?.last_login_country as string) || null,
        city: geo?.city ?? null,
        gps,
        device: parseDevice(r.user_agent),
        user_agent: r.user_agent,
      };
    });

    // ── Interests aggregation (products / categories / searches).
    const productMap = new Map<string, number>();
    const categoryMap = new Map<string, number>();
    const searches: { term: string; at: string }[] = [];
    for (const ev of events) {
      const d = ev.details || {};
      if (ev.type === "catalog_product_viewed") {
        bump(productMap, ev.label);
        if (typeof d.category === "string") bump(categoryMap, d.category);
      } else if (ev.type === "marketplace_viewed") {
        bump(productMap, ev.label);
        if (typeof d.category === "string") bump(categoryMap, d.category);
        if (typeof d.post_type === "string" && d.post_type === "buy") bump(categoryMap, `buy:${d.category}`);
      } else if (ev.type === "marketplace_search" || ev.type === "catalog_search") {
        if (ev.label) searches.push({ term: ev.label, at: ev.created_at });
        if (typeof d.category === "string") bump(categoryMap, d.category);
      } else if (ev.type === "rfq_created") {
        if (typeof d.product === "string") bump(productMap, d.product, 3); // RFQ = strongest signal
        if (typeof d.category === "string") bump(categoryMap, d.category, 3);
      } else if (ev.type === "marketplace_bid") {
        if (ev.label) bump(productMap, ev.label.replace(/^Bid on\s+/i, ""), 2);
      }
    }
    // Pre-event-stream era: RFQs + viewed marketplace posts still give a
    // static interest picture from the row sources.
    for (const r of rfqs) {
      bump(productMap, r.product_name, 3);
      if (r.category) bump(categoryMap, r.category, 3);
    }

    // ── Marketplace card.
    const bidPostIds = [...new Set(mkBids.map((b) => String(b.post_id)).filter(Boolean))];
    const bidPostProducts = new Map<string, string>();
    if (bidPostIds.length > 0) {
      try {
        const { data: bidPosts } = await sb
          .from("marketplace_posts")
          .select("id, product_name")
          .in("id", bidPostIds);
        for (const p of (bidPosts as Record<string, unknown>[] | null) || []) {
          bidPostProducts.set(String(p.id), String(p.product_name ?? ""));
        }
      } catch { /* degrade */ }
    }
    const marketplace: MarketplaceCard = {
      posts_total: mkPosts.length,
      bids_total: mkBids.length,
      negotiations_total: mkNegs.length,
      follows_total: mkFollows.length,
      purchases: [],
      posts: mkPosts.slice(0, 30).map((p) => ({
        id: String(p.id),
        post_type: String(p.post_type ?? ""),
        product_name: String(p.product_name ?? ""),
        status: String(p.status ?? ""),
        quantity: typeof p.quantity === "number" ? p.quantity : 0,
        unit: String(p.unit ?? ""),
        target_price: typeof p.target_price === "number" ? p.target_price : null,
        currency: String(p.currency ?? ""),
        created_at: String(p.created_at ?? ""),
        views_count: typeof p.views_count === "number" ? p.views_count : 0,
        responses_count: typeof p.responses_count === "number" ? p.responses_count : 0,
      })),
      bids: mkBids.slice(0, 30).map((b) => ({
        id: String(b.id),
        post_id: String(b.post_id ?? ""),
        post_product: bidPostProducts.get(String(b.post_id)) ?? (typeof b.post_title === "string" ? b.post_title : null),
        unit_price: typeof b.unit_price === "number" ? b.unit_price : null,
        currency: typeof b.currency === "string" ? b.currency : null,
        quantity: typeof b.quantity === "number" ? b.quantity : null,
        is_counter: typeof b.is_counter === "boolean" ? b.is_counter : null,
        status: String(b.status ?? ""),
        created_at: String(b.created_at ?? ""),
      })),
      negotiations: mkNegs.slice(0, 30).map((n) => ({
        id: String(n.id),
        post_id: String(n.post_id ?? ""),
        status: String(n.status ?? ""),
        role: n.partner_id_a === partnerId ? "buyer" : n.partner_id_b === partnerId ? "seller" : "party",
        last_message_at: (n.last_message_at as string) ?? null,
        created_at: String(n.created_at ?? ""),
      })),
      follows: mkFollows.slice(0, 30).map((f) => ({
        id: String(f.id),
        followed_name: null, // resolved below (partner names)
        created_at: String(f.created_at ?? ""),
      })),
    };

    // "Did they BUY anything" — three complementary signals:
    //   closed buy posts (they took the listing down as fulfilled),
    //   accepted bids (their offer on someone's post was accepted),
    //   accepted negotiations (deal closed in the negotiation room).
    for (const p of mkPosts) {
      if (String(p.post_type) === "buy" && String(p.status) === "closed") {
        marketplace.purchases.push({
          id: String(p.id),
          kind: "closed_buy_post",
          product: String(p.product_name ?? "") || null,
          quantity: typeof p.quantity === "number" ? p.quantity : null,
          unit: typeof p.unit === "string" ? p.unit : null,
          price: typeof p.target_price === "number" ? p.target_price : null,
          currency: typeof p.currency === "string" ? p.currency : null,
          at: String(p.created_at ?? ""),
        });
      }
    }
    for (const b of mkBids) {
      if (String(b.status) === "accepted") {
        marketplace.purchases.push({
          id: String(b.id),
          kind: "accepted_bid",
          product: bidPostProducts.get(String(b.post_id)) ?? null,
          quantity: typeof b.quantity === "number" ? b.quantity : null,
          unit: null,
          price: typeof b.unit_price === "number" ? b.unit_price : null,
          currency: typeof b.currency === "string" ? b.currency : null,
          at: String(b.created_at ?? ""),
        });
      }
    }

    // Negotiations: cross-tenant rooms are legitimate (marketplace is a
    // public feed) — partner_id is globally unique so the .or() filter is
    // the correct scope; no tenant_id narrowing.
    try {
      const { data: negs } = await sb
        .from("marketplace_negotiations")
        .select("id, post_id, partner_id_a, partner_id_b, status, last_message_at, created_at")
        .or(`partner_id_a.eq.${partnerId},partner_id_b.eq.${partnerId}`)
        .order("created_at", { ascending: false })
        .limit(60);
      mkNegs = (negs as Record<string, unknown>[]) || [];
    } catch { /* degrade */ }
    marketplace.negotiations_total = mkNegs.length;
    marketplace.negotiations = mkNegs.slice(0, 30).map((n) => ({
      id: String(n.id),
      post_id: String(n.post_id ?? ""),
      status: String(n.status ?? ""),
      role: n.partner_id_a === partnerId ? "buyer" : n.partner_id_b === partnerId ? "seller" : "party",
      last_message_at: (n.last_message_at as string) ?? null,
      created_at: String(n.created_at ?? ""),
    }));
    for (const n of mkNegs) {
      if (String(n.status) === "accepted") {
        marketplace.purchases.push({
          id: String(n.id),
          kind: "accepted_negotiation",
          product: null,
          quantity: null,
          unit: null,
          price: null,
          currency: null,
          at: String(n.created_at ?? ""),
        });
      }
    }

    try {
      const { data: follows } = await sb
        .from("marketplace_follows")
        .select("id, follower_partner_id, followed_partner_id, created_at")
        .eq("follower_partner_id", partnerId)
        .order("created_at", { ascending: false })
        .limit(60);
      mkFollows = (follows as Record<string, unknown>[]) || [];
    } catch { /* degrade */ }
    marketplace.follows_total = mkFollows.length;
    // Resolve followed names (best-effort, tenant-agnostic — cross-tenant
    // marketplace follows are legitimate public-feed follows).
    const followedNames = new Map<string, string>();
    const currentFollowedIds = [...new Set(mkFollows.map((f) => String(f.followed_partner_id)).filter(Boolean))];
    if (currentFollowedIds.length > 0) {
      try {
        const { data: followedPartners } = await sb
          .from("partners")
          .select("id, name")
          .in("id", currentFollowedIds);
        for (const p of (followedPartners as Record<string, unknown>[] | null) || []) {
          followedNames.set(String(p.id), String(p.name ?? ""));
        }
      } catch { /* degrade */ }
    }
    marketplace.follows = mkFollows.slice(0, 30).map((f) => ({
      id: String(f.id),
      followed_name: followedNames.get(String(f.followed_partner_id)) ?? null,
      created_at: String(f.created_at ?? ""),
    }));

    // ── Merged chronological timeline (events + logins + doc first-views
    //    + RFQs + purchases), newest first, capped at 250 entries.
    const timeline: TimelineEvent[] = [];
    for (const ev of events) {
      timeline.push({
        at: ev.created_at,
        type: ev.type,
        label: ev.label,
        entity_type: ev.entity_type,
        entity_id: ev.entity_id,
        ip: ev.ip,
        details: ev.details,
      });
    }
    for (const l of logins) {
      timeline.push({
        at: l.at,
        type: l.status === "success" ? "login" : "login_failed",
        label: l.status === "success" ? (l.city || l.country ? `from ${[l.city, l.country].filter(Boolean).join(", ")}` : null) : `reason: ${l.reason ?? "unknown"}`,
        entity_type: "portal_access",
        entity_id: null,
        ip: l.ip,
        details: l.gps
          ? { latitude: l.gps.latitude, longitude: l.gps.longitude, device: l.device }
          : { device: l.device },
      });
    }
    for (const d of docViews) {
      if (d.viewed_at) {
        timeline.push({
          at: d.viewed_at,
          type: `${d.table === "lois" ? "loi" : d.table.slice(0, -1)}_viewed`,
          label: d.number,
          entity_type: d.table,
          entity_id: d.id,
          ip: null,
          details: { view_count: d.view_count, status: d.status },
        });
      }
    }
    for (const r of rfqs) {
      timeline.push({
        at: r.created_at,
        type: "rfq_created",
        label: r.number,
        entity_type: "portal_rfq",
        entity_id: r.id,
        ip: null,
        details: { product: r.product_name, quantity: r.quantity, unit: r.unit },
      });
    }
    timeline.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    // ── Summary.
    const successLogins = logins.filter((l) => l.status === "success");
    const lastLogin = logins[0] || null; // audit query is DESC
    const lastAccessRow = accesses[0] || null;
    const docViewTotal = docViews.reduce((s, d) => s + d.view_count, 0);
    const downloads = events.filter((e) => e.type.endsWith("_downloaded")).length;
    const rfqCount = rfqs.length;
    const mkActions =
      mkPosts.length + mkBids.length + mkNegs.length + mkFollows.length;
    const lastActivityCandidate = [
      ...(timeline[0] ? [timeline[0].at] : []),
      lastLogin?.at,
      lastAccessRow?.last_login_at as string | undefined,
    ]
      .filter(Boolean)
      .map((x) => new Date(x as string).getTime());
    const firstSeenCandidate = [
      ...(accesses.length > 0 ? [accesses[accesses.length - 1].created_at as string] : []),
      ...successLogins.map((l) => l.at),
    ]
      .filter(Boolean)
      .map((x) => new Date(x as string).getTime());

    return NextResponse.json({
      partner_id: partnerId,
      summary: {
        portal_access: accesses.length > 0
          ? {
              id: String(accesses[0].id),
              status: String(accesses[0].status ?? ""),
              tier: String(accesses[0].tier ?? ""),
              created_at: accesses[0].created_at ?? null,
            }
          : null,
        logins: successLogins.length,
        failed_logins: logins.filter((l) => l.status !== "success").length,
        last_login_at: lastLogin?.at ?? ((lastAccessRow?.last_login_at as string) ?? null),
        last_ip: lastLogin?.ip ?? ((lastAccessRow?.last_login_ip as string) ?? null),
        last_country: lastLogin?.country ?? ((lastAccessRow?.last_login_country as string) ?? null),
        last_city: lastLogin?.city ?? null,
        last_gps: lastLogin?.gps ?? null,
        doc_views: docViewTotal,
        doc_viewed_count: docViews.filter((d) => d.viewed_at).length,
        downloads,
        rfqs: rfqCount,
        marketplace_actions: mkActions,
        purchases: marketplace.purchases.length,
        events_total: events.length,
        events_tracked: eventsTracked,
        first_seen: firstSeenCandidate.length > 0 ? new Date(Math.min(...firstSeenCandidate)).toISOString() : null,
        last_activity_at: lastActivityCandidate.length > 0 ? new Date(Math.max(...lastActivityCandidate)).toISOString() : null,
      },
      logins: logins.slice(0, 50),
      interests: {
        top_products: topN(productMap, 10),
        top_categories: topN(categoryMap, 8),
        recent_searches: searches.slice(0, 12),
      },
      marketplace,
      documents: docViews.slice(0, 100),
      timeline: timeline.slice(0, 250),
    });
  } catch (e: any) {
    console.error("[partners.activity]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
