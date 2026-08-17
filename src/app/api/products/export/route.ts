import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, sanitizeError } from "@/lib/api/helpers";
import { toCSV, csvResponse, parseExportParams } from "@/lib/export/csv";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (products.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "products.read"); if (_d) return _d; } /* requirePermission wired */

  const tid = resolveTenantId(auth, req);
  if (!tid) return csvResponse("products.csv", "");

  const result = await auth.store.listProducts(tid, { limit: 10000 });
  const { columns } = parseExportParams(req);

  const cols = columns || [
    "sku", "name", "category", "unit", "price", "currency",
    "cost", "stock", "reorder_level", "active", "created_at",
  ];

  const csv = toCSV(result.items as unknown as Record<string, unknown>[], cols);
  return csvResponse(`products-${new Date().toISOString().split("T")[0]}.csv`, csv);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
