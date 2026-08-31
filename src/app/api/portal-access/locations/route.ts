import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import { lookupIp } from "@/lib/utils/geo-ip";
// AUDIT16 — portal_email is encrypted at rest; decrypt before returning to
// the admin UI (the "Portal Locations" page rendered enc: blobs for every
// API-created portal row).
import { decryptField } from "@/lib/crypto/field-encryption";

export const runtime = "nodejs";

/**
 * GET /api/portal-access/locations
 *
 * Admin view: aggregates every signal we have about where a portal client is
 * logging in from. Used by the "Portal Locations" admin page so operators can
 * verify the geography of portal access at a glance.
 *
 * Signals, in order of preference:
 *   1. GPS coordinates reported by the portal client itself (audit_logs
 *      entries with action = "portal.location") — most accurate.
 *   2. The IP recorded on the portal_access row (last_login_ip) resolved via
 *      the geo-ip helper.
 *   3. The IP recorded in the login_history / audit_logs entries for the same
 *      tenant — used to populate the recent-login table.
 *
 * Returns:
 *   {
 *     locations:     Array of last-known location per portal user.
 *     login_history: Recent portal login attempts (success + failure).
 *     portal_logins: Audit entries for action = "portal.login".
 *   }
 */
export async function GET(req: NextRequest) {
  try {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  // Permission gate (portal.read) — admin-only feature.
  {
    const { requirePermission } = await import("@/lib/permissions/can");
    const denied = requirePermission(auth, "portal.read");
    if (denied) return denied;
  }
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_portal", auth.isSuperAdmin); if (_f) return _f; }

  const tid = resolveTenantId(auth, req);
  if (!tid) {
    return NextResponse.json({ error: "No tenant context." }, { status: 400 });
  }

  const sb = getSupabase();

  // ── All portal access rows with their last-known login IP ──────────────
  const { data: portalAccess, error: paError } = await sb
    .from("portal_access")
    .select(
      "id, portal_email, partner_id, last_login_at, last_login_ip, status, tier"
    )
    .eq("tenant_id", tid)
    .order("last_login_at", { ascending: false, nullsFirst: false });

  if (paError) {
    return NextResponse.json({ error: paError.message }, { status: 500 });
  }

  // ── Recent login history (all portal attempts) ────────────────────────
  // Portal users authenticate with their portal email as the username, so we
  // filter on usernames that look like emails. We fetch more than we need and
  // trim on the server.
  const { data: loginHistory } = await sb
    .from("login_history")
    .select("username, ip, country, user_agent, success, created_at")
    .eq("tenant_id", tid)
    .order("created_at", { ascending: false })
    .limit(100);

  // ── GPS coordinates voluntarily reported by portal clients ────────────
  // (POST /api/portal/log-location)
  const { data: locationAudits } = await sb
    .from("audit_logs")
    .select("details, created_at, ip")
    .eq("tenant_id", tid)
    .eq("action", "portal.location")
    .order("created_at", { ascending: false })
    .limit(200);

  // ── Portal login audit entries (success/failure, IP, user agent) ─────
  const { data: portalLogins } = await sb
    .from("audit_logs")
    .select("details, created_at, ip, user_agent")
    .eq("tenant_id", tid)
    .eq("action", "portal.login")
    .order("created_at", { ascending: false })
    .limit(50);

  // ── Assemble the per-portal-user location list ───────────────────────
  const locations: any[] = [];

  for (const pa of portalAccess || []) {
    if (!pa.last_login_ip) continue;

    // IP → country / city / lat / lng via the geo-ip helper. Never throws —
    // lookupIp degrades to all-nulls on loopback / private / lookup failure.
    const geo = await lookupIp(pa.last_login_ip).catch(() => ({
      country: null,
      city: null,
      region: null,
      latitude: null,
      longitude: null,
    }));

    // Pick the most recent GPS sample from the portal client that matches
    // this IP. We prefer GPS because it's accurate to meters, while the
    // geo-ip lookup is only accurate to a city / region.
    const gpsEntry = (locationAudits || []).find((a) => {
      if (!a || a.ip !== pa.last_login_ip) return false;
      const d = a.details as Record<string, unknown> | null;
      return d != null && typeof d.latitude === "number" && typeof d.longitude === "number";
    });

    const gpsDetails =
      (gpsEntry?.details as Record<string, unknown> | null) || null;

    locations.push({
      portal_access_id: pa.id,
      // AUDIT16 — decrypt (no-op on legacy plaintext rows).
      email: decryptField(pa.portal_email || "") || pa.portal_email,
      partner_id: pa.partner_id,
      ip: pa.last_login_ip,
      country: geo.country,
      city: geo.city,
      latitude:
        typeof gpsDetails?.latitude === "number" ? gpsDetails.latitude : geo.latitude,
      longitude:
        typeof gpsDetails?.longitude === "number" ? gpsDetails.longitude : geo.longitude,
      accuracy:
        typeof gpsDetails?.accuracy === "number" ? gpsDetails.accuracy : null,
      last_login_at: pa.last_login_at,
      status: pa.status,
      tier: pa.tier,
      source:
        gpsEntry != null
          ? "gps"
          : geo.latitude != null
            ? "ip"
            : "unknown",
    });
  }

  // Portal users log in with their email as the username — filter to that.
  // AUDIT16 — post-audit15 login/audit rows store the DECRYPTED email in
  // `username`; pre-audit15 rows for encrypted emails stored the enc: blob
  // (which failed the `.includes("@")` test and silently dropped that
  // portal user's login history). Keep the @-filter but let enc: usernames
  // through so the table can render them (they decrypt to nothing useful,
  // but the row still shows IP/time — previously the whole entry vanished).
  const portalLoginHistory = (loginHistory || [])
    .filter(
      (h) =>
        (typeof h.username === "string" && h.username.includes("@")) ||
        (typeof h.username === "string" && h.username.startsWith("enc:"))
    )
    // AUDIT16 — decrypt any ciphertext usernames so the admin table shows
    // real emails (best-effort: undecryptable blobs pass through as-is).
    .map((h) => ({
      ...h,
      username:
        typeof h.username === "string" && h.username.startsWith("enc:")
          ? decryptField(h.username) || h.username
          : h.username,
    }));

  return NextResponse.json({
    locations,
    login_history: portalLoginHistory,
    portal_logins: portalLogins || [],
  });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
