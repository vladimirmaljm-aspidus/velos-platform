import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/data/store";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getTierMeta } from "@/lib/portal/tiers";
import { getIp } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * POST /api/portal/log-location
 *
 * Called by the portal client right after a successful login (and periodically
 * afterwards) to record the client's geolocation. Required for all non-PREMIUM
 * tiers — the portal shell refuses to render content until the location has
 * been shared.
 *
 * Body: { latitude, longitude, accuracy?, source? }
 *
 * The IP is read from request headers so we always have at least one
 * geolocation signal even if the browser denies navigator.geolocation.
 */
export async function POST(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const tier = getTierMeta(access.tier);

  let body: {
    latitude?: number;
    longitude?: number;
    accuracy?: number;
    source?: string;
  } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  // IP attribution — use the shared `getIp()` helper which reads the LAST
  // entry of X-Forwarded-For (appended by Render's proxy) rather than the
  // first (attacker-controlled) entry. Audit F-6/S-1.
  const ip = getIp(req) || "unknown";

  const userAgent = req.headers.get("user-agent") || null;

  const store = await getStore();
  try {
    // P1 / task C-4 Fix 4: the previous implementation trusted the
    // client-supplied `body.source` field to decide whether to bump
    // `gps_verified_at`. A malicious client could POST
    // `{"source":"browser"}` (with NO lat/lng) and the server would
    // treat it as a valid precise-GPS verification, unlocking all
    // portal data endpoints without the browser ever sharing its real
    // location. The `requireGpsVerified()` gate on portal routes only
    // checks the server-side `portal_access.gps_verified_at` column —
    // it has no way to know the column was bumped by a spoofed source.
    //
    // Fix: derive `effectiveSource` ONLY from the presence of valid
    // latitude AND longitude (both finite numbers within the geometric
    // range). The client-supplied `source` field is now informational
    // only (recorded in the audit trail) and never gates the
    // `gps_verified_at` bump. A "browser" source without real lat/lng
    // is downgraded to "ip" so the gate stays closed.
    const lat = typeof body.latitude === "number" ? body.latitude : NaN;
    const lng = typeof body.longitude === "number" ? body.longitude : NaN;
    const latValid = Number.isFinite(lat) && lat >= -90 && lat <= 90;
    const lngValid = Number.isFinite(lng) && lng >= -180 && lng <= 180;
    const hasRealFix = latValid && lngValid;
    // `effectiveSource` is the SOURCE OF TRUTH for whether to bump
    // `gps_verified_at`. Derived from real coordinates only — the
    // client-supplied `body.source` is NOT trusted for this decision.
    const effectiveSource = hasRealFix ? "browser" : "ip";

    // If the client lied about the source (claimed "browser" but sent
    // no/invalid coordinates), log it so ops can spot the bypass
    // attempt pattern in the audit trail.
    if (body.source === "browser" && !hasRealFix) {
      console.warn(
        `[portal.log-location] client claimed source="browser" but provided no valid lat/lng (lat=${body.latitude}, lng=${body.longitude}) — downgraded to "ip", gps_verified_at NOT bumped`,
      );
    }

    // Append to the audit log with a structured details blob so admins can
    // review the full location history of any portal client.
    await store.appendAudit({
      tenant_id: access.tenant_id,
      user_id: null,
      username: `portal:${access.portal_email || access.id}`,
      action: "portal.location",
      entity_type: "portal_access",
      entity_id: access.id,
      details: {
        latitude: hasRealFix ? lat : null,
        longitude: hasRealFix ? lng : null,
        accuracy: typeof body.accuracy === "number" ? body.accuracy : null,
        // Record BOTH the client-claimed source AND the server-derived
        // effectiveSource so a spoofing attempt is visible in the audit
        // trail (client_claimed_source="browser" + effectiveSource="ip"
        // = bypass attempt).
        client_claimed_source: body.source || null,
        source: effectiveSource,
        ip,
        user_agent: userAgent,
        tier: access.tier,
        required: tier.requiresLocation,
      },
      ip,
      user_agent: userAgent,
    });

    // Only precise GPS ("browser" derived from real lat/lng) counts as a
    // real location verification. IP-derived location is too coarse
    // (city/region level) to satisfy the requireGpsVerified() gate on
    // portal data endpoints. Bumping gps_verified_at here is what
    // unlocks /api/portal/{offers,invoices,proformas,documents,catalog}
    // for non-premium, non-exempt clients.
    //
    // Wrapped in its own try/catch and best-effort: the audit row above is
    // the source of truth for the full location history; the gps_verified_at
    // column is just a denormalised "latest browser GPS" marker used by the
    // server-side gate. A DB error here (e.g. migration 015 not yet applied)
    // must NOT fail the whole request — the client already has its location
    // captured in the audit log and the gate will keep returning 403 until
    // the migration is applied, which is the intended fail-closed behaviour.
    if (effectiveSource === "browser") {
      try {
        await store.upsertPortalAccess({
          id: access.id,
          gps_verified_at: new Date().toISOString(),
        });
      } catch (gpsErr) {
        console.warn("[portal.log-location] failed to set gps_verified_at:", gpsErr);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[portal.log-location]", e);
    return NextResponse.json({ error: "Failed to log location." }, { status: 500 });
  }
}
