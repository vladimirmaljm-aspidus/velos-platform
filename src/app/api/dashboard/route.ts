import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKey, requireAuthOrApiKeyPermission, resolveTenantId, getIp } from "@/lib/api/helpers";
// 9b-N13 — dashboard routes had no rate limit. A caller with a valid
// session OR API key could spam getInsights() / getDashboardCharts()
// (multi-join aggregations) without any per-IP cap. The DB-backed rate
// limiter (migration 024) is shared across instances — the cap holds
// even on multi-replica deploys. 60 req/min/IP is generous (a legit
// dashboard polls at 30s × 1 tab = 2 req/min) but blocks a single
// attacker from saturating the dashboard endpoints.
import { checkRateLimit } from "@/lib/security/rate-limiter";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  // 9b-N13 — per-IP rate limit. Must run BEFORE requireAuthOrApiKey so
  // even unauthenticated probes are capped (avoids a no-op auth path
  // being hammered). 429 + Retry-After on limit exceeded.
  const rl = await checkRateLimit(`dashboard:ip:${getIp(req)}`, 60, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many dashboard requests. Try again later." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil((rl.retryAfter ?? 60_000) / 1000)) },
      },
    );
  }

  const auth = await requireAuthOrApiKey(req);
  if (auth instanceof NextResponse) return auth;
  // U-FIX (RBAC audit D-1): check permissions for BOTH session AND API
  // key. Previously the gate was wrapped in `if (!("apiKeyId" in auth))`
  // — meaning API-key callers were NEVER permission-checked, so any
  // API key (even one with `permissions: []`) could read dashboard KPIs.
  const denied = requireAuthOrApiKeyPermission(auth, "dashboard.read");
  if (denied) return denied;

  const tid = resolveTenantId(auth, req);
  try {
    const insights = await auth.store.getInsights(tid ?? undefined);
    return NextResponse.json(insights);
  } catch (e) {
    console.error("[dashboard]", e);
    return NextResponse.json({ error: "Error loading." }, { status: 500 });
  }
}
