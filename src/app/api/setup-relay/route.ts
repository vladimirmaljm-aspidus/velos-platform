import { NextRequest, NextResponse } from "next/server";
import { writeFileSync, appendFileSync, existsSync } from "fs";
// FIX-AUDIT4-SEC / Fix 1 — the previous implementation had NO auth gate and
// blindly auto-PATCHed the production Vercel project's env vars based on the
// inbound Host header. An unauthenticated caller with the ability to set
// their own Host (or X-Forwarded-Host) header could force ZAI_RELAY_URL on
// the production Vercel project to any attacker-controlled URL — every
// browser request to /api/ai/relay-proxy would then proxy to the attacker.
//
// The fix is two-layered:
//   1. `requireSuperAdmin(req)` — only a logged-in super_admin can call this
//      route. The CSRF Origin check inside requireAuth (which super_admin
//      delegates through) also runs because we pass `req`.
//   2. A Host allowlist — even an authenticated super_admin can't redirect
//      the relay to an arbitrary host. The inbound Host (or
//      X-Forwarded-Host) must match `process.env.ALLOWED_HOST` (a comma-
//      separated list), falling back to the hostnames of
//      `NEXT_PUBLIC_APP_URL` or `APP_BASE_URL`. This defends against a
//      compromised super-admin session being used to retarget the relay
//      from a one-off DNS-rebinding / cache-poisoning attempt.
import { requireSuperAdmin } from "@/lib/api/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resolve the set of hosts the setup-relay endpoint will accept. Reads
 * `ALLOWED_HOST` (comma-separated list) first, then falls back to the
 * hostname component of `NEXT_PUBLIC_APP_URL` / `APP_BASE_URL`. Each
 * entry is lowercased and trimmed.
 */
function getAllowedHosts(): string[] {
  const raw = process.env.ALLOWED_HOST;
  if (raw && raw.trim() !== "") {
    return raw
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
  }
  const fallbacks: string[] = [];
  for (const envVar of ["NEXT_PUBLIC_APP_URL", "APP_BASE_URL"]) {
    const v = process.env[envVar];
    if (!v) continue;
    try {
      const u = new URL(v);
      if (u.hostname) fallbacks.push(u.hostname.toLowerCase());
    } catch {
      // Not a URL — maybe a bare hostname. Use as-is.
      fallbacks.push(v.trim().toLowerCase());
    }
  }
  return fallbacks;
}

/**
 * GET/POST /api/setup-relay
 *
 * Captures the external Host header from the request (which the gateway
 * forwards) and writes it to /tmp/discovered-host.txt so the sandbox
 * operator can read it and configure ZAI_RELAY_URL on Vercel.
 *
 * If VERCEL_TOKEN is set, it also auto-configures the Vercel project env.
 *
 * CRITICAL FIX (AUDIT4-SEC / Fix 1): the route now requires a super_admin
 * session AND validates the inbound Host against an allowlist before
 * touching the filesystem or the Vercel API.
 */
export async function handler(req: NextRequest) {
  // ── Auth gate — only a super_admin may retarget the AI relay. ───────────
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const host = (
    req.headers.get("x-forwarded-host") ||
    req.headers.get("host") ||
    ""
  ).toLowerCase();

  // ── Host allowlist — even an authenticated super_admin can't redirect
  //    the relay to an arbitrary host. This blocks DNS-rebinding /
  //    cache-poisoning / XSS-leveraged attacks where the super-admin's
  //    browser is tricked into POSTing with an attacker-chosen Host.
  const allowedHosts = getAllowedHosts();
  if (allowedHosts.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Host allowlist not configured. Set ALLOWED_HOST (comma-separated), NEXT_PUBLIC_APP_URL, or APP_BASE_URL." },
      { status: 400 },
    );
  }
  if (!host || !allowedHosts.includes(host)) {
    return NextResponse.json(
      { ok: false, host, error: "Host not allowed." },
      { status: 400 },
    );
  }

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
        // 9b-N4: read Vercel project ID from env var instead of hardcoding.
        // The literal `prj_mSyTYNlssiuYTBZOhwvBNY8RvFSm` committed to source
        // leaked a real Vercel platform identifier into the public repo.
        // Operators set VERCEL_PROJECT_ID in the deployment env (Vercel →
        // Settings → Environment Variables). Fallback to empty → reject.
        const projectId = process.env.VERCEL_PROJECT_ID || "";
        if (!projectId) {
          return NextResponse.json({ ok: false, host: fullUrl, error: "VERCEL_PROJECT_ID env var not set on this deployment." });
        }
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
        // 9b-N4: do NOT echo `String(e)` — fetch errors can include
        // response bodies, redirect URLs, or internal diagnostics that
        // widen the blast radius if a super_admin session is compromised.
        console.error("[setup-relay] Vercel API call failed:", e);
        return NextResponse.json({ ok: false, host: fullUrl, error: "Vercel API call failed. See server logs for details." });
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
