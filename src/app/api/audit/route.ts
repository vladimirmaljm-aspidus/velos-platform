import { NextRequest, NextResponse } from "next/server";
import { requireAuth, sanitizeError } from "@/lib/api/helpers";
import { redactDetails, TENANT_REDACT_KEYS } from "@/lib/api/redact";

export const runtime = "nodejs";

// Redact secret-bearing fields (e.g. portal password-reset tokens) that get
// written into audit `details` — the audit log is for tracing who did what,
// not for exposing live credentials to anyone who can read it.

export async function GET(req: NextRequest) {
  try {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (audit.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "audit.read"); if (_d) return _d; } /* requirePermission wired */

  if (!auth.tenantId) {
    return NextResponse.json({ error: "Use /api/super-admin/audit for cross-tenant audit." }, { status: 403 });
  }
  const tid = auth.tenantId;
  const url = new URL(req.url);
  const search = url.searchParams.get("search") || undefined;
  const limit = url.searchParams.get("limit") ? Math.min(Number(url.searchParams.get("limit")), 500) : 100;
  const offset = url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : 0;
  const result = await auth.store.listAudit(tid, { search, limit, offset });
  return NextResponse.json({
    ...result,
    items: result.items.map((item) => ({ ...item, details: redactDetails(item.details, TENANT_REDACT_KEYS) })),
  });
  } catch (error: any) {
    console.error("[audit GET]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
