import { NextRequest, NextResponse } from "next/server";
import { writeFileSync, appendFileSync, existsSync } from "fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET/POST /api/setup-relay
 *
 * Captures the external Host header from the request (which the gateway
 * forwards) and writes it to /tmp/discovered-host.txt so the sandbox
 * operator can read it and configure ZAI_RELAY_URL on Vercel.
 *
 * If VERCEL_TOKEN is set, it also auto-configures the Vercel project env.
 */
export async function handler(req: NextRequest) {
  const host =
    req.headers.get("x-forwarded-host") ||
    req.headers.get("host") ||
    "";
  const proto = req.headers.get("x-forwarded-proto") || "https";

  // Capture and persist the discovered host
  if (host && !host.startsWith("localhost") && !host.startsWith("127.")) {
    const fullUrl = `${proto}://${host}`;
    try {
      writeFileSync("/tmp/discovered-host.txt", fullUrl + "\n");
      appendFileSync("/tmp/discovered-all.txt", `${new Date().toISOString()} | ${fullUrl} | host=${host}\n`);
    } catch (e) {
      // Filesystem may be read-only (e.g. on Vercel) — fall through to the
      // Vercel auto-configure path so the relay still works without /tmp.
      console.warn("[setup-relay] filesystem write failed:", e);
    }

    // If VERCEL_TOKEN is available, auto-configure Vercel
    const token = process.env.VERCEL_TOKEN;
    if (token) {
      try {
        const projectId = "prj_mSyTYNlssiuYTBZOhwvBNY8RvFSm";
        const listRes = await fetch(
          `https://api.vercel.com/v9/projects/${projectId}/env`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const listData = await listRes.json() as { envs?: { key: string; id: string }[] };
        const existing = listData.envs?.find((e) => e.key === "ZAI_RELAY_URL");

        if (existing) {
          await fetch(
            `https://api.vercel.com/v9/projects/${projectId}/env/${existing.id}`,
            {
              method: "PATCH",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ value: fullUrl, target: ["production", "preview", "development"] }),
            },
          );
        } else {
          await fetch(
            `https://api.vercel.com/v9/projects/${projectId}/env`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ key: "ZAI_RELAY_URL", value: fullUrl, type: "encrypted", target: ["production", "preview", "development"] }),
            },
          );
        }
        return NextResponse.json({ ok: true, relayUrl: fullUrl, autoConfigured: true });
      } catch (e) {
        return NextResponse.json({ ok: false, host: fullUrl, error: "Vercel API call failed", details: String(e) });
      }
    }

    return NextResponse.json({
      ok: true,
      host: fullUrl,
      captured: true,
      message: "Host captured to /tmp/discovered-host.txt. VERCEL_TOKEN not set — set ZAI_RELAY_URL manually on Vercel.",
    });
  }

  return NextResponse.json({
    ok: false,
    host,
    error: "Could not determine external host. Visit from the preview panel, not localhost.",
  });
}

export const GET = handler;
export const POST = handler;
