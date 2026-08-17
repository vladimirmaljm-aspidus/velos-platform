import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKey, requireAuthOrApiKeyPermission, resolveTenantId } from "@/lib/api/helpers";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
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
