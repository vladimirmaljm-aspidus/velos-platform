import { NextRequest, NextResponse } from "next/server";
import { writeFileSync, appendFileSync } from "fs";
import { requireSuperAdmin } from "@/lib/api/helpers";

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
 *
 * SEC-M5: the previous implementation accepted an attacker-controlled
 * `?h=<host>` from ANY unauthenticated caller and wrote it to /tmp — a
 * public DoS / disk-fill / log-poisoning vector. Direct callers must now
 * be authenticated as super_admin. The sandbox middleware's internal
 * call will start returning 403 — that's acceptable because the
 * middleware capture-host call is a sandbox-only convenience, not a
 * production-essential path; on Vercel the env var is configured directly
 * so the middleware doesn't need to call this route at all.
 */
export async function GET(req: NextRequest) {
  // SEC-M5: require super_admin for any direct (browser/curl) call.
  // The middleware's internal call will fail this gate — that's
  // intentional and acceptable per the spec.
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const host = req.nextUrl.searchParams.get("h") || "";
  const proto = req.nextUrl.searchParams.get("p") || "https";
  if (host && !host.startsWith("localhost") && !host.startsWith("127.")) {
    const fullUrl = `${proto}://${host}`;
    try {
      writeFileSync("/tmp/discovered-host.txt", fullUrl + "\n");
      appendFileSync("/tmp/discovered-all.txt", `${new Date().toISOString()} | ${fullUrl}\n`);
    } catch (e) {
      // Filesystem may be read-only (e.g. on Vercel) — silently no-op so
      // the middleware that calls this on every request never sees a 500.
      console.warn("[capture-host] filesystem write failed:", e);
    }
  }
  return new NextResponse("ok", { status: 200, headers: { "Cache-Control": "no-store" } });
}
