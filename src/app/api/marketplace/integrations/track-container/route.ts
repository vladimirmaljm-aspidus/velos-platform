import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { trackContainer, SUPPORTED_CARRIERS } from "@/lib/marketplace/integrations";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// ── Container tracking integration ────────────────────────────────────────
//
// POST /api/marketplace/integrations/track-container
//
// Looks up a shipping container's current location + ETA + tracking
// events via the carrier's tracking API. The integration wrapper lives
// in `src/lib/marketplace/integrations.ts` (placeholder for Maersk /
// MSC / CMA CGM / Hapag-Lloyd / ONE / COSCO / Evergreen / Yang Ming).
//
// Auth: portal session (the partner viewing the shipment tracker).
// The marketplace shipment-detail page calls this with the carrier +
// tracking_number it has on file for the shipment, so the partner sees
// a unified tracking timeline even when the carrier doesn't expose
// public tracking URLs.
//
// Body: { carrier: string, trackingNumber: string }
async function _post(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const carrier = String(body?.carrier || "").toLowerCase().trim();
  const trackingNumber = String(body?.trackingNumber || body?.tracking_number || "").toUpperCase().trim();

  if (!carrier) {
    return NextResponse.json({ error: "carrier is required." }, { status: 400 });
  }
  if (!SUPPORTED_CARRIERS.includes(carrier as any)) {
    return NextResponse.json(
      {
        error: `Unsupported carrier. Supported: ${SUPPORTED_CARRIERS.join(", ")}.`,
        supported_carriers: SUPPORTED_CARRIERS,
      },
      { status: 400 },
    );
  }
  if (!trackingNumber || trackingNumber.length < 4) {
    return NextResponse.json({ error: "trackingNumber is required (min 4 chars)." }, { status: 400 });
  }
  if (trackingNumber.length > 64) {
    return NextResponse.json({ error: "trackingNumber is too long (max 64 chars)." }, { status: 400 });
  }

  try {
    const tracking = await trackContainer(carrier, trackingNumber);
    return NextResponse.json({ tracking });
  } catch (e: any) {
    console.error("[marketplace.integrations.track-container]", e);
    return NextResponse.json({ error: e?.message || "Failed to track container." }, { status: 502 });
  }
}

export const POST = withApm(_post, "POST /api/marketplace/integrations/track-container");
