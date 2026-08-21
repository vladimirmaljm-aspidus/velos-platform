import { NextRequest, NextResponse } from "next/server";

/**
 * Edge Function: CORS-free proxy for the AI relay.
 *
 * WHY THIS EXISTS:
 * The browser can't call the sandbox relay directly because the Alibaba
 * Cloud FC gateway returns 400 for CORS preflight (OPTIONS) requests —
 * session affinity requires the x-session-id header, but the browser's
 * preflight doesn't send it (that's how CORS preflight works).
 *
 * This edge function is called by the browser (same origin → no CORS),
 * and it forwards the request to the sandbox relay server-side (where
 * x-session-id can be added as a normal header without preflight).
 *
 * FLOW:
 *   browser → /api/ai/relay-proxy (Vercel edge, same origin, no CORS)
 *           → https://sandbox.../parse-document?XTransformPort=3030
 *             (with x-session-id header, server-side, no preflight)
 *           → relay (sandbox) → unpdf + Z.AI SDK → structured JSON
 *           ← result returned to browser
 *
 * Edge runtime runs on Vercel's edge network — if it can reach the
 * FC gateway, this works. If not, the browser falls back to calling
 * the relay directly (which may fail with CORS, but at least we tried).
 */

export const runtime = "edge";
export const dynamic = "force-dynamic";

const SESSION_ID = "velos-relay-1";

export async function POST(req: NextRequest) {
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

export async function GET() {
  const relayBase = process.env.NEXT_PUBLIC_ZAI_RELAY_URL || process.env.ZAI_RELAY_URL || "";
  return NextResponse.json({
    ok: true,
    runtime: "edge",
    relayConfigured: !!relayBase,
  });
}
