import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/setup-relay
 *
 * Self-configuring route: when called from the sandbox's external preview
 * URL, it reads the Host header (the external hostname), then calls the
 * Vercel API to set ZAI_RELAY_URL on the velos-platform project so the
 * Vercel serverless functions can reach the AI relay on the sandbox.
 *
 * Requires VERCEL_TOKEN env var (set locally on the sandbox, NOT on
 * Vercel — this route only runs on the sandbox dev server).
 */
export async function POST(req: NextRequest) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "VERCEL_TOKEN not set on the sandbox" },
      { status: 500 },
    );
  }

  // Discover the external host from the request headers.
  const host =
    req.headers.get("x-forwarded-host") ||
    req.headers.get("host") ||
    "";
  const proto = req.headers.get("x-forwarded-proto") || "https";

  if (!host || host.startsWith("localhost")) {
    return NextResponse.json(
      { error: "Could not determine external host. Visit this URL from the preview panel." },
      { status: 400 },
    );
  }

  const relayUrl = `${proto}://${host}`;
  const projectId = "prj_mSyTYNlssiuYTBZOhwvBNY8RvFSm";

  // Check if ZAI_RELAY_URL already exists on Vercel.
  const listRes = await fetch(
    `https://api.vercel.com/v9/projects/${projectId}/env`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const listData = await listRes.json() as { envs?: { key: string; id: string }[] };
  const existing = listData.envs?.find((e) => e.key === "ZAI_RELAY_URL");

  if (existing) {
    // Update existing var.
    await fetch(
      `https://api.vercel.com/v9/projects/${projectId}/env/${existing.id}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          value: relayUrl,
          target: ["production", "preview", "development"],
        }),
      },
    );
  } else {
    // Create new var.
    await fetch(
      `https://api.vercel.com/v9/projects/${projectId}/env`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          key: "ZAI_RELAY_URL",
          value: relayUrl,
          type: "encrypted",
          target: ["production", "preview", "development"],
        }),
      },
    );
  }

  return NextResponse.json({
    ok: true,
    relayUrl,
    message: `ZAI_RELAY_URL set to ${relayUrl} on Vercel. Redeploy to activate.`,
  });
}

export async function GET(req: NextRequest) {
  // Also support GET for easy browser testing.
  return POST(req);
}
