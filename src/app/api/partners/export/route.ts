import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, sanitizeError } from "@/lib/api/helpers";
import { toCSV, csvResponse, parseExportParams } from "@/lib/export/csv";
// FIX-AUDIT4-SEC / Fix 9 — partners CSV export was shipping the encrypted
// `enc:` blobs (un-decryptable garbage for the spreadsheet user) AND the
// internal HMAC search-token columns. Decrypt the PII fields before
// serializing to CSV; strip the HMAC columns and the legacy portal_token
// (parity with /api/partners GET list handler, lines 188-205).
import { shapePartnerRow } from "@/lib/api/redact";

export const runtime = "nodejs";

/**
 * GET /api/partners/export?columns=name,email,phone,type,status&format=csv
 * Exports partners as CSV.
 *
 * FIX-AUDIT4-SEC / Fix 9: the previous implementation passed raw
 * `listPartners()` items straight to `toCSV()`, which meant the CSV
 * contained the encrypted `enc:<salt>:<iv>:<tag>:<data>` blobs for
 * contact_email / phone / tax_id / vat_number (un-decryptable garbage
 * for a human reading the spreadsheet) AND the internal HMAC search-
 * token columns (tax_id_hmac / vat_number_hmac) which are server-only
 * lookup handles. The export now mirrors the in-app GET list handler:
 * decrypt the four PII fields and strip the HMAC columns + portal_token.
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

  // FIX-AUDIT4-SEC / Fix 9 — decrypt + strip per row, mirroring the
  // /api/partners GET list handler. The HMAC columns (tax_id_hmac,
  // vat_number_hmac) and the legacy `portal_token` secret are NEVER
  // exported — even if an admin explicitly requests them via
  // ?columns=tax_id_hmac,portal_token, the strip below removes them
  // from the row object before toCSV sees the column.
  // AUDIT18 — canonical shaping (was one of 5 drifted copies).
  const safeItems = result.items.map((row: any) => shapePartnerRow(row));

  // Defense-in-depth: also strip the secret / HMAC columns from the
  // user-supplied `cols` list so an admin can't `?columns=portal_token`
  // to bypass the row-level strip (toCSV only emits columns in the list,
  // but the strip above already deleted them from the row — this is
  // belt-and-braces).
  const safeCols = cols.filter(
    (c) => c !== "portal_token" && c !== "tax_id_hmac" && c !== "vat_number_hmac",
  );

  const csv = toCSV(safeItems as unknown as Record<string, unknown>[], safeCols);
  return csvResponse(`partners-${new Date().toISOString().split("T")[0]}.csv`, csv);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
