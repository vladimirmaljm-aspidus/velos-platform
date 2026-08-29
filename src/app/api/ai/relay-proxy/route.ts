import { NextRequest, NextResponse } from "next/server";
// FIX-AUDIT4-SEC / Fix 2 — the previous implementation had NO auth gate.
// Any unauthenticated browser could POST to /api/ai/relay-proxy and use
// this server as an open proxy to the sandbox relay server (free AI
// calls, possibly exfiltrating the sandbox's session state to other
// origins). The route now requires a logged-in session via `requireAuth`.
//
// We switched from `edge` to `nodejs` runtime: `requireAuth` reads the
// session from a crypto-signed JWT cookie and may consult the store
// (token_version lookup, idle-timeout config) — none of which is
// available in the edge runtime. The latency cost of nodejs is
// negligible here because the actual work is a 55s-timeout fetch to
// the sandbox relay.
import { requireAuth } from "@/lib/api/helpers";

/**
 * CORS-free proxy for the AI relay.
 *
 * WHY THIS EXISTS:
 * The browser can't call the sandbox relay directly because the Alibaba
 * Cloud FC gateway returns 400 for CORS preflight (OPTIONS) requests —
 * session affinity requires the x-session-id header, but the browser's
 * preflight doesn't send it (that's how CORS preflight works).
 *
 * This route is called by the browser (same origin → no CORS), and it
 * forwards the request to the sandbox relay server-side (where
 * x-session-id can be added as a normal header without preflight).
 *
 * FLOW:
 *   browser → /api/ai/relay-proxy (same origin, no CORS)
 *           → https://sandbox.../parse-document?XTransformPort=3030
 *             (with x-session-id header, server-side, no preflight)
 *           → relay (sandbox) → unpdf + Z.AI SDK → structured JSON
 *           ← result returned to browser
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSION_ID = "velos-relay-1";

export async function POST(req: NextRequest) {
  // Auth gate — must be a logged-in user. CSRF Origin check runs inside
  // requireAuth because we pass `req`.
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const relayBase = process.env.NEXT_PUBLIC_ZAI_RELAY_URL || process.env.ZAI_RELAY_URL || "";
  if (!relayBase) {
    return NextResponse.json(
      { error: "AI relay not configured (NEXT_PUBLIC_ZAI_RELAY_URL not set)." },
      { status: 500 },
    );
  }

  try {
    const body = await req.text();
    const targetUrl = `${relayBase}/parse-document?XTransformPort=3030`;

    const res = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-id": SESSION_ID,
      },
      body,
      signal: AbortSignal.timeout(55000),
    });

    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: {
        "Content-Type": res.headers.get("Content-Type") || "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isTimeout = msg.includes("timeout") || msg.includes("Timeout");
    return NextResponse.json(
      {
        error: isTimeout
          ? "AI service timed out. The sandbox relay may be unreachable from Vercel's edge network. Try again or use a smaller file."
          : `Relay proxy failed: ${msg}`,
      },
      { status: 502 },
    );
  }
}

export async function GET(req: NextRequest) {
  // Auth gate on GET too — the relay configuration status (whether the
  // relay URL is set) is itself a sensitive operational detail.
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const relayBase = process.env.NEXT_PUBLIC_ZAI_RELAY_URL || process.env.ZAI_RELAY_URL || "";
  return NextResponse.json({
    ok: true,
    runtime: "nodejs",
    relayConfigured: !!relayBase,
  });
}
