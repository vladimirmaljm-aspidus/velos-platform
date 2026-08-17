import { NextResponse } from "next/server";
import type { PortalAccess } from "@/lib/supabase/types";

/**
 * Server-side GPS gate for portal endpoints.
 *
 * The portal shell already blocks rendering UI until the browser shares GPS
 * (client-side), but every portal data endpoint historically only checked
 * `getPortalSessionAccess()` + KYC — none verified GPS was actually shared.
 * A portal user with a valid session cookie could therefore `curl
 * /api/portal/offers` and receive data without ever granting location.
 *
 * This helper closes that gap. It reads `gps_verified_at` (an ISO timestamp
 * populated by `/api/portal/log-location` whenever the browser shares precise
 * GPS, i.e. `source === "browser"`) and requires it to be within the last
 * 24 hours.
 *
 * Returns a 403 NextResponse when the caller should be blocked, or null when
 * the caller may proceed.
 *
 * Bypass rules:
 *   - Premium tier (they pay for the privilege)
 *   - `exempt_location_share = true` (admin-granted exemption)
 *
 * The `gps_verified_at` column is added by migration
 * `015_portal_access_gps_verified_at.sql`. On deployments where the migration
 * hasn't been applied yet, the column is absent and `gps_verified_at` is
 * `undefined` — non-premium, non-exempt users will be blocked until they share
 * location, which is the intended fail-closed behaviour.
 */
export async function requireGpsVerified(access: PortalAccess): Promise<NextResponse | null> {
  // Premium tier or admin-granted exemption bypasses the GPS requirement.
  if (access.tier === "premium" || access.exempt_location_share) return null;

  const gpsVerifiedAt = access.gps_verified_at;
  if (!gpsVerifiedAt) {
    return NextResponse.json(
      {
        error: "Location sharing is required to access portal data.",
        gps_required: true,
      },
      { status: 403 },
    );
  }

  const verifiedTime = new Date(gpsVerifiedAt).getTime();
  if (Number.isNaN(verifiedTime)) {
    return NextResponse.json(
      {
        error: "Location sharing is required to access portal data.",
        gps_required: true,
      },
      { status: 403 },
    );
  }

  const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
  if (verifiedTime < twentyFourHoursAgo) {
    return NextResponse.json(
      {
        error: "Your location verification has expired. Please re-share your location.",
        gps_required: true,
        expired: true,
      },
      { status: 403 },
    );
  }

  return null;
}
