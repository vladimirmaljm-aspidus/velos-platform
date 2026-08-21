import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/api/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/ai/test-relay
 *
 * Tests the connection from Vercel to the AI relay on the sandbox.
 * Returns the relay URL, whether it's reachable, and any error.
 *
 * Auth: super_admin only. The route exposes the relay URL (a sandbox
 * internal address) and raw upstream response snippets — neither is a
 * secret on its own, but the endpoint fires a real LLM request on every
 * call and returns the upstream's status/error envelope, so public
 * access would let anyone spam the relay and enumerate error shapes.
 * Gated with `requireSuperAdmin` (matches the comment that was already
 * here but had no enforcement).
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

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
