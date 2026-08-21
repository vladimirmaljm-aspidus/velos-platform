import { NextRequest, NextResponse } from "next/server";
import { writeFileSync, appendFileSync } from "fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/capture-host?h=<host>&p=<proto>
 *
 * Called by the middleware on every request to capture the external Host
 * header. Writes it to /tmp/discovered-host.txt so the sandbox operator
 * can read it and configure ZAI_RELAY_URL on Vercel.
 *
 * Only runs on the sandbox (needs filesystem access — not on Vercel).
 */
export async function GET(req: NextRequest) {
  const host = req.nextUrl.searchParams.get("h") || "";
  const proto = req.nextUrl.searchParams.get("p") || "https";
  if (host && !host.startsWith("localhost") && !host.startsWith("127.")) {
    const fullUrl = `${proto}://${host}`;
    writeFileSync("/tmp/discovered-host.txt", fullUrl + "\n");
    appendFileSync("/tmp/discovered-all.txt", `${new Date().toISOString()} | ${fullUrl}\n`);
  }
  return new NextResponse("ok", { status: 200, headers: { "Cache-Control": "no-store" } });
}
