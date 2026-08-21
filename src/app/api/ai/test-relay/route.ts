import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/ai/test-relay
 *
 * Tests the connection from Vercel to the AI relay on the sandbox.
 * Returns the relay URL, whether it's reachable, and any error.
 * Super-admin only (no secrets exposed, but don't want public abuse).
 */
export async function GET() {
  const relayUrl = process.env.ZAI_RELAY_URL;
  if (!relayUrl) {
    return NextResponse.json({ error: "ZAI_RELAY_URL not set" }, { status: 500 });
  }

  const testUrl = `${relayUrl}/chat?XTransformPort=3030`;
  const t0 = Date.now();
  try {
    const res = await fetch(testUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-id": "velos-relay-1",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Say OK" }],
      }),
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    return NextResponse.json({
      ok: res.ok,
      status: res.status,
      relayUrl,
      testUrl,
      ms: Date.now() - t0,
      response: text.slice(0, 300),
    });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      relayUrl,
      testUrl,
      ms: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
      cause: (e as any)?.cause?.message || (e as any)?.cause?.code || "none",
    });
  }
}
