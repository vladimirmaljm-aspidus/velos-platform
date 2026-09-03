import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/data/store";
import { getSupabase } from "@/lib/supabase/client";
import { parseUserAgent } from "@/lib/utils/device-parser";
import { lookupIp, GeoData, validateGpsAgainstIp } from "@/lib/utils/geo-ip";
import { getIp } from "@/lib/api/helpers";
import { checkRateLimit } from "@/lib/security/rate-limiter";

export const runtime = "nodejs";

// Public QR verification — no auth required.
// Returns document validity + metadata (no sensitive data).
//
// SIDE EFFECT: persists a row to `document_verification_logs` capturing
// WHO (IP, country, city, lat/lng), WHAT device (UA-parsed browser/OS/type),
// and the verification result. This is for fraud prevention: super-admins
// can review every verification via /api/super-admin/verification-logs.
// The write is best-effort — if the table is missing or the insert fails,
// the public verify endpoint MUST still return the correct result.
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const store = await getStore();
  const v = await store.getDocumentVerificationByCode(code);
  if (!v) {
    // Even for unknown codes, attempt to log the attempt for fraud analysis.
    // The store.getDocumentVerificationByCode already returned null — we don't
    // have a verification_id, but we still want to know WHO probed a bad code.
    void logVerificationAttempt(req, code, null, "invalid", null, null);
    return NextResponse.json({
      valid: false,
      result: "invalid",
      message: "Verification code not found. This document may be fraudulent.",
    });
  }

  // Determine the result BEFORE recording — the log captures the resolved
  // status so the super-admin viewer can filter by valid/invalid/revoked.
  const logResult: "valid" | "invalid" | "revoked" | "modified" =
    v.status === "active" ? "valid" :
    v.status === "revoked" ? "revoked" :
    v.status === "superseded" ? "modified" :
    "invalid";

  // ── Original verification_logs table (kept for back-compat) ───────────
  // Failures here are non-fatal — the public verification endpoint must
  // never turn a valid document into a 500.
  try {
    await store.logVerification({
      verification_id: v.id,
      code: v.verification_code,
      ip: getIp(req) || null,
      user_agent: req.headers.get("user-agent") || null,
      result: logResult,
      details: null,
    });
  } catch (e) {
    console.error("[verify] logVerification failed:", e);
  }

  // ── Detailed document_verification_logs row (WHO/WHERE/HOW) ───────────
  // GET path: no GPS available (server-rendered / direct API call) —
  // falls back to IP-based geo only.
  void logVerificationAttempt(
    req,
    v.verification_code,
    v.tenant_id,
    logResult,
    v,
    null, // gpsCoords — not available on GET
  );

  if (v.status !== "active") {
    return NextResponse.json({
      valid: false,
      result: logResult,
      message: v.status === "revoked"
        ? "This document has been revoked by the issuer."
        : "This document has been superseded by a newer version.",
      document_number: v.document_number,
      document_type: v.document_type,
      issued_at: v.issued_at,
    });
  }

  // ── GPS gate (audit finding P0-4/D-1) ───────────────────────────────────
  // CRITICAL FIX: the old `?gps=1` query param was trivially bypassable.
  // Now the server checks document_verification_logs for a RECENT GPS
  // verification (within 5 minutes) from the same IP address for this code.
  // Only then is the full document payload returned.
  const gpsVerified = await checkGpsVerified(req, code);
  if (!gpsVerified) {
    return NextResponse.json({
      valid: true,
      result: "valid",
      requires_gps: true,
      document_type: v.document_type,
      document_number_masked:
        (v.document_number?.slice(0, 4) ?? "") + "••••",
      issued_at: v.issued_at,
      verification_count: v.verification_count + 1,
    });
  }

  // GPS verified — return full payload.
  return NextResponse.json({
    valid: true,
    result: "valid",
    message: "This document is valid and authentic.",
    document_type: v.document_type,
    document_number: v.document_number,
    issued_at: v.issued_at,
    verification_count: v.verification_count + 1,
    last_verified_at: new Date().toISOString(),
  });
}

// ─── POST: GPS-enriched verification log ─────────────────────────────────
//
// Called by the public verify page (src/components/verify/verify-client.tsx)
// AFTER the browser resolves precise GPS via `navigator.geolocation.
// getCurrentPosition`. The page passes { latitude, longitude, accuracy,
// source } in the body.
//
// GPS coordinates take PRIORITY over IP-based geo in the stored row —
// this matches the portal's behaviour (src/lib/portal/use-geolocation.ts)
// so document verification now records the SAME level of precision as
// portal client login.
//
// Source field ("browser" | "ip") is persisted into `raw_headers.gps`
// so super-admins can distinguish precise-GPS rows from IP-only rows.
//
// Resilient: any failure (logging, missing table, supabase down) MUST
// NOT turn a valid verification into a 500 — the response is `{ ok }`
// and the page has already rendered the verification result.
// Audit M6/4-c: DB-backed rate limit for the public GPS-verification POST.
// The handler writes TWO rows per call (legacy verification_logs + detailed
// document_verification_logs) with no cap — an unauthenticated loop could
// farm log-spam (storage + super-admin viewer noise) at request speed. The
// middleware's in-memory 10/min cap is per-instance (decorative on Vercel
// serverless); this DB-backed cap is authoritative. Keyed per IP+code so
// one verifier's retries never block a different document's verifiers.
const VERIFY_POST_RATE_LIMIT = {
  maxAttempts: 20,
  windowMs: 5 * 60 * 1000,
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;

  // ── Rate limit BEFORE any DB read / log write (audit M6) ──────────────
  // On excess: 429, and NOTHING is written to either log table.
  const rl = await checkRateLimit(
    `verify-post:ip:${getIp(req)}:code:${code}`,
    VERIFY_POST_RATE_LIMIT.maxAttempts,
    VERIFY_POST_RATE_LIMIT.windowMs,
  );
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many verification attempts" },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil((rl.retryAfter ?? 60_000) / 1000)),
          "Cache-Control": "no-store",
        },
      },
    );
  }

  // Body is optional — empty body is fine (treated as IP-only).
  let body: {
    latitude?: number | null;
    longitude?: number | null;
    accuracy?: number | null;
    source?: string;
  } = {};
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === "object") body = parsed;
  } catch {
    /* empty or invalid body — fall through with {} */
  }

  const store = await getStore();
  const v = await store.getDocumentVerificationByCode(code);

  // Resolve result so the log records the actual outcome seen by the
  // user — not just "valid/invalid" but the revoked/superseded state too.
  const result: "valid" | "invalid" | "revoked" | "modified" = !v
    ? "invalid"
    : v.status === "active"
    ? "valid"
    : v.status === "revoked"
    ? "revoked"
    : v.status === "superseded"
    ? "modified"
    : "invalid";

  // ── Original verification_logs table (back-compat) ───────────────────
  // Only log if we have a verification record — the legacy table requires
  // a non-null verification_id (FK constraint).
  if (v) {
    try {
      await store.logVerification({
        verification_id: v.id,
        code: v.verification_code,
        ip: getIp(req) || null,
        user_agent: req.headers.get("user-agent") || null,
        result,
        // Stash the GPS coords (if any) into the JSON details column so
        // the legacy viewer can show them too.
        details: body.latitude != null && body.longitude != null
          ? JSON.stringify({
              gps: {
                lat: body.latitude,
                lng: body.longitude,
                accuracy: body.accuracy ?? null,
                source: body.source ?? "browser",
              },
            })
          : null,
      });
    } catch (e) {
      console.error("[verify POST] legacy logVerification failed:", e);
    }
  }

  // ── Detailed document_verification_logs row (WHO/WHERE/HOW + GPS) ────
  // 8a-3: GPS coords from the client body were previously accepted
  // unconditionally and written to the row's `latitude` / `longitude`
  // columns. `checkGpsVerified()` then matched on `latitude IS NOT NULL`,
  // which meant `curl ... -d '{"latitude":0,"longitude":0,"source":"browser"}'`
  // unlocked the gate without the verifier actually sharing their location.
  // Now we validate the coords against the IP-derived geo (distance check,
  // reject (0,0), reject out-of-range/non-finite, require source="browser")
  // BEFORE persisting them. Coords that fail validation are NOT written to
  // `latitude` / `longitude` — the row still records the attempt (with the
  // failure reason in `details` for forensic review), but `checkGpsVerified`
  // returns false, so the gate stays locked.
  let gpsCoords: {
    latitude: number;
    longitude: number;
    accuracy?: number | null;
    source?: string;
  } | null = null;
  let gpsRejectReason: string | null = null;
  if (body.latitude != null && body.longitude != null) {
    const ip = getIp(req) || "unknown";
    const gpsCheck = await validateGpsAgainstIp(ip, body.latitude, body.longitude, body.source);
    if (gpsCheck.valid) {
      gpsCoords = {
        latitude: body.latitude as number,
        longitude: body.longitude as number,
        accuracy: typeof body.accuracy === "number" ? body.accuracy : null,
        source: body.source ?? "browser",
      };
    } else {
      gpsRejectReason = gpsCheck.reason ?? "unknown";
      // Log the bypass attempt so the super-admin viewer can spot patterns.
      console.warn(
        `[verify POST] GPS coords rejected (reason=${gpsRejectReason}) — ip=${ip}`,
      );
    }
  }

  void logVerificationAttempt(
    req,
    code,
    v?.tenant_id ?? null,
    result,
    v,
    gpsCoords,
    gpsRejectReason,
  );

  return NextResponse.json({ ok: true, result });
}

// ─── Helper: capture detailed verification metadata ────────────────────────
//
// Persisted via service_role (bypasses RLS). The table is created by
// supabase/migrations/006_document_verification_logs.sql. If the table is
// missing (migration not yet applied), the insert fails silently — the
// public verify endpoint continues to function.
//
// GPS coordinates (when provided by the POST handler) take PRIORITY over
// the IP-based lat/lng — they're written into the `latitude` / `longitude`
// columns so the super-admin viewer's Google Maps link points at the
// verifier's EXACT location rather than their ISP's city.

// ─── GPS verification check ──────────────────────────────────────────────
// Returns true if there's a recent (within 5 min) GPS verification log
// for this code from the same IP. This is the server-side gate that
// prevents document data from leaking without actual GPS sharing.
//
// 8a-3: previously matched on `latitude IS NOT NULL` alone, which was
// satisfied by IP-only rows (the lat/lng columns were filled from
// `geo.latitude` when the client sent no body at all) AND by attacker-supplied
// (0, 0) coords. Now we additionally require `raw_headers.gps.source ===
// "browser"` — only validated browser GPS rows unlock the gate.
async function checkGpsVerified(req: NextRequest, code: string): Promise<boolean> {
  try {
    const ip = getIp(req) || "unknown";
    const sb = getSupabase();
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data, error } = await sb
      .from("document_verification_logs")
      .select("id, latitude, longitude, raw_headers")
      .eq("verification_code", code)
      .eq("ip", ip)
      .gte("verified_at", fiveMinAgo)
      .not("latitude", "is", null)
      .order("verified_at", { ascending: false })
      .limit(1);
    if (error) return false;
    if (!data || data.length === 0) return false;
    // 8a-3: only count real "browser" GPS rows as unlocking the gate. IP-only
    // rows have `raw_headers.gps.source = "ip"` and MUST NOT satisfy the gate.
    const row = data[0] as { raw_headers?: { gps?: { source?: string } } } | null;
    const src = row?.raw_headers?.gps?.source;
    return src === "browser";
  } catch {
    return false;
  }
}

async function logVerificationAttempt(
  req: NextRequest,
  code: string,
  tenantId: string | null,
  result: "valid" | "invalid" | "revoked" | "modified",
  v: {
    id: string;
    verification_code?: string;
    document_type?: string | null;
    document_id?: string | null;
    document_number?: string | null;
  } | null,
  gpsCoords: {
    latitude: number;
    longitude: number;
    accuracy?: number | null;
    source?: string;
  } | null,
  gpsRejectReason: string | null = null,
): Promise<void> {
  try {
    // Resolve the caller's IP via the shared `getIp()` helper.
    // Audit F-6/S-1 + H2: `getIp()` only trusts platform-set forwarded-for
    // headers (Vercel) — CF-Connecting-IP / X-Real-IP are ignored unless
    // TRUST_PROXY_HEADERS=true — so IP-based GPS-gate keying and audit
    // attribution are not spoofable by the client.
    const ip = getIp(req) || "unknown";

    const userAgent = req.headers.get("user-agent") || null;
    const device = parseUserAgent(userAgent);

    // Geo lookup is non-blocking — failures fall through to nulls via the
    // EMPTY_GEO sentinel returned by lookupIp on error / loopback IPs.
    let geo: GeoData = {
      country: null,
      city: null,
      region: null,
      latitude: null,
      longitude: null,
    };
    try {
      geo = await lookupIp(ip);
    } catch {
      // Keep the empty-geo default; the row is still useful for IP/UA analysis.
    }

    // GPS coordinates take PRIORITY over IP-based lat/lng when available.
    // Country/city/region still come from the IP lookup (GPS doesn't carry
    // those) — so a row can have precise lat/lng + IP-derived country.
    //
    // 8a-3: when the client SUPPLIED coords but they failed validation
    // (`gpsRejectReason != null`), we MUST NOT fall back to the IP-derived
    // lat/lng — `checkGpsVerified()` matches on `latitude IS NOT NULL` and
    // would otherwise unlock the gate based on the IP fallback alone.
    // Rejecting coords → write null lat/lng + reject reason marker in
    // raw_headers.gps; the row still records the attempt for forensic review.
    let finalLatitude: number | null;
    let finalLongitude: number | null;
    if (gpsCoords) {
      finalLatitude = gpsCoords.latitude;
      finalLongitude = gpsCoords.longitude;
    } else if (gpsRejectReason) {
      // Coords supplied but failed validation — DO NOT use IP fallback
      // (would re-open the gate the validation is supposed to close).
      finalLatitude = null;
      finalLongitude = null;
    } else {
      // No coords supplied at all (IP-only verification) — preserve the
      // pre-8a-3 behaviour so legacy rows continue to render on the map.
      finalLatitude = geo.latitude;
      finalLongitude = geo.longitude;
    }

    const sb = getSupabase();
    const { error } = await sb.from("document_verification_logs").insert({
      tenant_id: tenantId,
      verification_code: code,
      document_type: v?.document_type ?? null,
      document_id: v?.document_id ?? null,
      document_number: v?.document_number ?? null,
      ip,
      country: geo.country,
      city: geo.city,
      region: geo.region,
      latitude: finalLatitude,
      longitude: finalLongitude,
      user_agent: userAgent,
      device_type: device.deviceType,
      browser: device.browser,
      os: device.os,
      device_name: device.deviceName,
      result,
      verification_id: v?.id ?? null,
      referrer: req.headers.get("referer") || null,
      accept_language: req.headers.get("accept-language") || null,
      // raw_headers preserves BOTH sources for forensic analysis:
      //  - gps.source = "browser" → user granted precise GPS (validated)
      //  - gps.source = "ip"      → GPS denied/unavailable, fell back to IP
      //  - gps.rejected = "<reason>" → client supplied coords but validation
      //    rejected them (e.g. too_far_from_ip, zero_zero) — the row is the
      //    evidence trail for the bypass attempt; lat/lng above are NULL so
      //    checkGpsVerified() correctly returns false.
      raw_headers: {
        gps: gpsCoords
          ? {
              lat: gpsCoords.latitude,
              lng: gpsCoords.longitude,
              accuracy: gpsCoords.accuracy ?? null,
              source: gpsCoords.source ?? "browser",
              rejected: null,
            }
          : gpsRejectReason
          ? { lat: null, lng: null, accuracy: null, source: "rejected", rejected: gpsRejectReason }
          : { lat: null, lng: null, accuracy: null, source: "ip" },
      },
    });
    if (error) {
      // Most common cause: migration 006 not yet applied (table missing).
      // Log once per error type and move on — do not crash the verify path.
      console.error("[verify] document_verification_logs insert failed:", error.message);
    }
  } catch (e) {
    // Defense-in-depth: any unexpected error must not propagate to the
    // public verify caller. The verification result is the source of truth.
    console.error("[verify] logVerificationAttempt unexpected error:", e);
  }
}
