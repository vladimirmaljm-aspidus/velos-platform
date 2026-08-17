import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, sanitizeError } from "@/lib/api/helpers";
import { toCSV, csvResponse, parseExportParams } from "@/lib/export/csv";

export const runtime = "nodejs";

/**
 * GET /api/partners/export?columns=name,email,phone,type,status&format=csv
 * Exports partners as CSV.
 */
export async function GET(req: NextRequest) {
  try {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (partners.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "partners.read"); if (_d) return _d; } /* requirePermission wired */

  const tid = resolveTenantId(auth, req);
  if (!tid) return csvResponse("partners.csv", "");

  const result = await auth.store.listPartners(tid, { limit: 10000 });
  const { columns } = parseExportParams(req);

  const cols = columns || [
    "name", "type", "entity_type", "email", "phone", "country", "city",
    "status", "risk_score", "kyc_status", "portal_enabled", "created_at",
  ];

  const csv = toCSV(result.items as unknown as Record<string, unknown>[], cols);
  return csvResponse(`partners-${new Date().toISOString().split("T")[0]}.csv`, csv);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
